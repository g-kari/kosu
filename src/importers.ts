/**
 * One-shot imports (phase 4): Toggl / Clockify / Kimai CSV exports, a
 * generic CSV shape, and ActivityWatch JSON exports.
 *
 * Every imported row is deduplicated through external_items with a
 * content hash as the external id, so importing the same file twice
 * creates nothing the second time. Time entries belong to the importing
 * account. Entry notes / descriptions from the source files are NOT
 * copied: Kosu entry notes are client-side ciphertext (note_enc), so a
 * plaintext source note has no valid place to go (see docs/DESIGN.md).
 * ActivityWatch events become entries on per-app tasks named
 * "ActivityWatch: <app>" — drafts the user can rename or reassign.
 */
import { guard } from "./hierarchy";
import { assertEntryEditable } from "./locks";
import { nowIso } from "./accounts";
import { badRequest } from "./errors";
import {
  findExternalItem,
  recordExternalItem,
  recordSyncRun,
  statusSlugForCategory,
} from "./integrations";
import { insertEntry, insertTask, listTasks } from "./tasks";
import { sha256Hex } from "./tokens";
import type {
  Env,
  IntegrationSyncRunRow,
  ProjectRow,
  TaskRow,
} from "./types";

/* ------------------------------------------------------------------ */
/* CSV parsing (RFC 4180 subset: quotes, embedded commas/newlines)      */
/* ------------------------------------------------------------------ */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

/* ------------------------------------------------------------------ */
/* Normalized import rows                                               */
/* ------------------------------------------------------------------ */

export interface ImportRow {
  taskTitle: string;
  startedAt: string; // ISO instant
  endedAt: string | null;
  durationSeconds: number | null;
  /** Stable source identity (file row number / event key) for dedupe. */
  sourceKey: string;
}

function parseDurationSeconds(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  // "1:30:00" / "0:45" (h:mm:ss or m:ss)
  const colon = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) {
    const a = Number(colon[1]);
    const b = Number(colon[2]);
    const c = colon[3] ? Number(colon[3]) : null;
    return c !== null ? a * 3600 + b * 60 + c : a * 60 + b;
  }
  // Decimal hours ("1.5") — Toggl/Clockify both emit this in some locales.
  const num = Number(s.replace(",", "."));
  if (Number.isFinite(num) && num >= 0) return Math.round(num * 3600);
  return null;
}

function combineDateTime(date: string, time: string): string | null {
  const d = date.trim();
  const t = time.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const hh = String(m[1]).padStart(2, "0");
  const mm = m[2] as string;
  const ss = m[3] ? String(m[3]).padStart(2, "0") : "00";
  const iso = `${d}T${hh}:${mm}:${ss}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function instantOrNull(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Accept "YYYY-MM-DD HH:MM:SS" as UTC as well as full ISO strings.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)
    ? `${s.replace(" ", "T")}Z`
    : s;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type RowMap = Record<string, string>;

function toRowMap(headers: string[], cells: string[]): RowMap {
  const out: RowMap = {};
  headers.forEach((h, i) => {
    out[h.trim().toLowerCase()] = (cells[i] ?? "").trim();
  });
  return out;
}

function pick(map: RowMap, ...names: string[]): string {
  for (const name of names) {
    const v = map[name.toLowerCase()];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

/** Parse a Toggl / Clockify / Kimai / generic CSV export. */
export function parseTimeCsv(
  format: "toggl" | "clockify" | "kimai" | "csv",
  text: string,
): ImportRow[] {
  const table = parseCsv(text);
  if (table.length < 2) {
    throw badRequest("CSV must have a header row and at least one data row");
  }
  const headers = table[0] as string[];
  const out: ImportRow[] = [];
  for (let idx = 1; idx < table.length; idx++) {
    const map = toRowMap(headers, table[idx] as string[]);
    let taskTitle = "";
    let startedAt: string | null = null;
    let endedAt: string | null = null;
    let durationSeconds: number | null = null;
    if (format === "toggl") {
      taskTitle = pick(map, "task") || pick(map, "project") || pick(map, "description");
      startedAt = combineDateTime(
        pick(map, "start date"),
        pick(map, "start time"),
      );
      endedAt = combineDateTime(pick(map, "end date"), pick(map, "end time"));
      durationSeconds = parseDurationSeconds(pick(map, "duration"));
    } else if (format === "clockify") {
      taskTitle = pick(map, "task") || pick(map, "project") || pick(map, "description");
      startedAt = instantOrNull(
        `${pick(map, "start date")} ${pick(map, "start time")}`,
      );
      endedAt = instantOrNull(
        `${pick(map, "end date")} ${pick(map, "end time")}`,
      );
      durationSeconds = parseDurationSeconds(
        pick(map, "duration (h)") || pick(map, "duration"),
      );
    } else if (format === "kimai") {
      taskTitle = pick(map, "activity") || pick(map, "project") || pick(map, "description");
      const date = pick(map, "date");
      const begin = pick(map, "begin") || pick(map, "start");
      const end = pick(map, "end");
      startedAt = date
        ? combineDateTime(date, begin || "00:00")
        : instantOrNull(begin);
      endedAt = date && end ? combineDateTime(date, end) : instantOrNull(end);
      durationSeconds = parseDurationSeconds(
        pick(map, "duration") || pick(map, "duration (h)"),
      );
    } else {
      // Generic shape: title/task, started_at, ended_at, duration_seconds
      // (ISO instants are also accepted for start/end columns).
      taskTitle = pick(map, "task", "title", "task title", "name");
      startedAt =
        instantOrNull(pick(map, "started_at", "start", "start time", "begin")) ??
        combineDateTime(pick(map, "date"), pick(map, "start time", "begin"));
      endedAt =
        instantOrNull(pick(map, "ended_at", "end", "end time")) ??
        (pick(map, "date")
          ? combineDateTime(pick(map, "date"), pick(map, "end time", "end"))
          : null);
      const rawDuration = pick(map, "duration_seconds", "duration (s)");
      durationSeconds =
        rawDuration !== ""
          ? Math.round(Number(rawDuration)) || null
          : parseDurationSeconds(pick(map, "duration"));
    }
    if (!startedAt) continue;
    if (durationSeconds === null && endedAt) {
      durationSeconds = Math.max(
        0,
        Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
      );
    }
    out.push({
      taskTitle: taskTitle || "(no task)",
      startedAt,
      endedAt,
      durationSeconds,
      sourceKey: `row-${idx}`,
    });
    if (out.length > 5000) {
      throw badRequest("Import is limited to 5000 rows per request");
    }
  }
  return out;
}

/** Parse an ActivityWatch export (bucket map, bucket array, or bucket). */
export function parseActivityWatch(text: string): ImportRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("ActivityWatch import requires a JSON document");
  }
  const buckets: Record<string, unknown>[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const v of value) collect(v);
      return;
    }
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      if (Array.isArray(rec["events"])) buckets.push(rec);
      else if (rec["buckets"] && typeof rec["buckets"] === "object") {
        collect(Object.values(rec["buckets"] as Record<string, unknown>));
      }
    }
  };
  collect(parsed);
  const out: ImportRow[] = [];
  for (const bucket of buckets) {
    const events = bucket["events"] as Record<string, unknown>[];
    for (const event of events) {
      const timestamp = event["timestamp"];
      const duration = event["duration"];
      if (typeof timestamp !== "string") continue;
      if (typeof duration !== "number" || duration < 30) continue;
      const startedMs = Date.parse(timestamp);
      if (!Number.isFinite(startedMs)) continue;
      const data =
        event["data"] && typeof event["data"] === "object"
          ? (event["data"] as Record<string, unknown>)
          : {};
      const app =
        typeof data["app"] === "string" && data["app"]
          ? (data["app"] as string)
          : "unknown app";
      out.push({
        taskTitle: `ActivityWatch: ${app}`.slice(0, 300),
        startedAt: new Date(startedMs).toISOString(),
        endedAt: new Date(startedMs + duration * 1000).toISOString(),
        durationSeconds: Math.round(duration),
        sourceKey: `${timestamp}:${app}:${duration}`,
      });
      if (out.length > 5000) {
        throw badRequest("Import is limited to 5000 rows per request");
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Applying imports                                                     */
/* ------------------------------------------------------------------ */

export interface ImportStats {
  rows: number;
  created_entries: number;
  created_tasks: number;
  skipped_duplicates: number;
  skipped_invalid: number;
}

export async function applyTimeImport(
  env: Env,
  project: ProjectRow,
  format: string,
  rows: ImportRow[],
  actorAccountId: string,
): Promise<ImportStats> {
  const { access } = await guard(env, {kind:"session",accountId:actorAccountId}, {
    tenantId:project.tenant_id,workspaceId:project.workspace_id,teamId:project.team_id,projectId:project.id,
  }, "write");
  const provider = `import:${format}`;
  const stats: ImportStats = {
    rows: rows.length,
    created_entries: 0,
    created_tasks: 0,
    skipped_duplicates: 0,
    skipped_invalid: 0,
  };
  const tasks = await listTasks(env, project.id, { includeArchived: true });
  const byTitle = new Map<string, TaskRow>();
  for (const t of tasks) {
    if (!byTitle.has(t.title)) byTitle.set(t.title, t);
  }
  const openStatus = await statusSlugForCategory(env, project, "open");
  const findOrCreateTask = async (title: string): Promise<TaskRow> => {
    const existing = byTitle.get(title);
    if (existing) return existing;
    const task = await insertTask(
      env,
      project,
      {
        title,
        descriptionEnc: null,
        status: openStatus,
        priority: "medium",
        assigneeAccountId: null,
        parentTaskId: null,
        startDate: null,
        dueDate: null,
        sortOrder: 0,
        estimateMinutes: null,
      },
      { accountId: actorAccountId, admin: access.admin },
    );
    byTitle.set(title, task);
    stats.created_tasks++;
    return task;
  };
  for (const row of rows) {
    const hash = await sha256Hex(
      [
        provider,
        actorAccountId,
        row.taskTitle,
        row.startedAt,
        row.endedAt ?? "",
        row.durationSeconds ?? "",
        row.sourceKey.startsWith("row-") ? row.sourceKey : row.sourceKey,
      ].join("|"),
    );
    const dupe = await findExternalItem(env, project.tenant_id, provider, hash);
    if (dupe) {
      stats.skipped_duplicates++;
      continue;
    }
    try {
      // Reject locked/submitted dates before creating associated tasks.
      await assertEntryEditable(env, {tenantId:project.tenant_id,entryAccountId:actorAccountId,
        actorAccountId,actorIsAdmin:access.admin,startedAts:[row.startedAt]});
      const task = await findOrCreateTask(row.taskTitle.slice(0, 300));
      const entry = await insertEntry(
        env,
        {
          tenantId: project.tenant_id,
          workspaceId: project.workspace_id,
          taskId: task.id,
          accountId: actorAccountId,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          durationSeconds: row.durationSeconds,
          noteEnc: null,
        },
        { accountId: actorAccountId, admin: access.admin },
      );
      await recordExternalItem(env, {
        tenantId: project.tenant_id,
        connectionId: null,
        provider,
        externalId: hash,
        entityType: "time_entry",
        entityId: entry.id,
        externalUpdatedAt: null,
      });
      stats.created_entries++;
    } catch {
      stats.skipped_invalid++;
    }
  }
  return stats;
}

/** Parse + apply + record a sync run for one import request. */
export async function runImport(
  env: Env,
  project: ProjectRow,
  format: "toggl" | "clockify" | "kimai" | "csv" | "activitywatch",
  content: string,
  actorAccountId: string,
): Promise<{ run: IntegrationSyncRunRow; stats: ImportStats }> {
  const { access } = await guard(env, {kind:"session",accountId:actorAccountId}, {
    tenantId:project.tenant_id,workspaceId:project.workspace_id,teamId:project.team_id,projectId:project.id,
  }, "write");
  const provider = `import:${format}`;
  try {
    const rows =
      format === "activitywatch"
        ? parseActivityWatch(content)
        : parseTimeCsv(format, content);
    const stats = await applyTimeImport(env, project, format, rows, actorAccountId);
    const run = await recordSyncRun(env, {
      tenantId: project.tenant_id,
      connectionId: null,
      provider,
      kind: "import",
      status: "ok",
      stats: { ...stats, project_id: project.id },
      createdByAccountId: actorAccountId,
    });
    return { run, stats };
  } catch (err) {
    const run = await recordSyncRun(env, {
      tenantId: project.tenant_id,
      connectionId: null,
      provider,
      kind: "import",
      status: "error",
      message: err instanceof Error ? err.message : "Import failed",
      stats: { project_id: project.id },
      createdByAccountId: actorAccountId,
    });
    return {
      run,
      stats: {
        rows: 0,
        created_entries: 0,
        created_tasks: 0,
        skipped_duplicates: 0,
        skipped_invalid: 0,
      },
    };
  }
}

