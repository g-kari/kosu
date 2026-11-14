/**
 * Custom report builder and scheduled delivery (phase 5 item 4).
 *
 * A report definition is the phase-3 report parameters plus a range
 * spec that resolves at run time (last N days / this month / last
 * month / fixed custom range) and an optional schedule
 * (off | daily | weekly | monthly). Running a definition builds the
 * report through the same `buildTimeReport` used by the ad-hoc
 * endpoint, stores the JSON in report_runs and notifies the creator
 * (in-app + tenant webhooks via the notification dispatcher).
 */

import { randomId } from "./tokens";
import { badRequest } from "./errors";
import { nowIso } from "./accounts";
import { addDays, isDateString } from "./timecalc";
import { buildTimeReport } from "./reports";
import { dispatchNotifications } from "./notify";
import type { Env, ReportDefinitionRow } from "./types";

export interface ReportRangeSpec {
  kind: "last_days" | "this_month" | "last_month" | "custom";
  days?: number;
  from?: string;
  to?: string;
}

export interface ReportDefinition {
  group_by: "project" | "member" | "day";
  range: ReportRangeSpec;
  project_id?: string | null;
  account_id?: string | null;
}

export const REPORT_SCHEDULES = ["off", "daily", "weekly", "monthly"] as const;

export function parseDefinition(raw: unknown): ReportDefinition {
  const value =
    typeof raw === "string"
      ? ((): unknown => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            throw badRequest('"definition" must be valid JSON');
          }
        })()
      : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest('"definition" must be an object');
  }
  const rec = value as Record<string, unknown>;
  // "account" is accepted as an alias for the canonical "member".
  const groupByRaw = rec["group_by"] ?? "project";
  const groupBy = groupByRaw === "account" ? "member" : groupByRaw;
  if (groupBy !== "project" && groupBy !== "member" && groupBy !== "day") {
    throw badRequest('"definition.group_by" must be project, member or day');
  }
  const rangeRaw = rec["range"];
  if (!rangeRaw || typeof rangeRaw !== "object" || Array.isArray(rangeRaw)) {
    throw badRequest('"definition.range" is required');
  }
  const rangeRec = rangeRaw as Record<string, unknown>;
  const kind = rangeRec["kind"];
  if (
    kind !== "last_days" &&
    kind !== "this_month" &&
    kind !== "last_month" &&
    kind !== "custom"
  ) {
    throw badRequest(
      '"definition.range.kind" must be last_days, this_month, last_month or custom',
    );
  }
  const range: ReportRangeSpec = { kind };
  if (kind === "last_days") {
    const days = rangeRec["days"] ?? 7;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 366) {
      throw badRequest('"definition.range.days" must be 1-366');
    }
    range.days = days;
  }
  if (kind === "custom") {
    if (!isDateString(rangeRec["from"]) || !isDateString(rangeRec["to"])) {
      throw badRequest('"definition.range" custom needs from/to dates');
    }
    range.from = rangeRec["from"] as string;
    range.to = rangeRec["to"] as string;
  }
  const projectId = rec["project_id"] ?? null;
  const accountId = rec["account_id"] ?? null;
  if (projectId !== null && typeof projectId !== "string") {
    throw badRequest('"definition.project_id" must be a string or null');
  }
  if (accountId !== null && typeof accountId !== "string") {
    throw badRequest('"definition.account_id" must be a string or null');
  }
  return {
    group_by: groupBy,
    range,
    project_id: projectId,
    account_id: accountId,
  };
}

/** Resolve a range spec against a reference date (YYYY-MM-DD). */
export function resolveRange(
  range: ReportRangeSpec,
  today: string,
): { from: string; to: string } {
  switch (range.kind) {
    case "last_days": {
      const days = range.days ?? 7;
      return { from: addDays(today, -(days - 1)), to: today };
    }
    case "this_month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last_month": {
      const first = `${today.slice(0, 7)}-01`;
      const prevEnd = addDays(first, -1);
      return { from: `${prevEnd.slice(0, 7)}-01`, to: prevEnd };
    }
    case "custom":
      return { from: range.from as string, to: range.to as string };
  }
}

/** The next scheduled run instant for a schedule, from `fromIso`. */
export function nextRunAt(schedule: string, fromIso: string): string | null {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return null;
  switch (schedule) {
    case "daily":
      from.setUTCDate(from.getUTCDate() + 1);
      break;
    case "weekly":
      from.setUTCDate(from.getUTCDate() + 7);
      break;
    case "monthly":
      from.setUTCMonth(from.getUTCMonth() + 1);
      break;
    default:
      return null;
  }
  return from.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function publicDefinition(
  row: ReportDefinitionRow,
): Record<string, unknown> {
  let definition: unknown = {};
  try {
    definition = JSON.parse(row.definition_json) as unknown;
  } catch {
    definition = {};
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    definition,
    schedule: row.schedule,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function insertDefinition(
  env: Env,
  args: {
    tenantId: string;
    name: string;
    definition: ReportDefinition;
    schedule: string;
    createdBy: string;
  },
): Promise<ReportDefinitionRow> {
  const now = nowIso();
  const row: ReportDefinitionRow = {
    id: randomId(),
    tenant_id: args.tenantId,
    name: args.name,
    definition_json: JSON.stringify(args.definition),
    schedule: args.schedule,
    next_run_at:
      args.schedule === "off" ? null : nextRunAt(args.schedule, now),
    last_run_at: null,
    created_by_account_id: args.createdBy,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO report_definitions (id, tenant_id, name, definition_json, schedule, next_run_at, last_run_at, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(
      row.id, row.tenant_id, row.name, row.definition_json, row.schedule,
      row.next_run_at, row.last_run_at, row.created_by_account_id, now, now,
    )
    .run();
  return row;
}

export async function listDefinitions(
  env: Env,
  tenantId: string,
): Promise<ReportDefinitionRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM report_definitions WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<ReportDefinitionRow>();
  return results ?? [];
}

export async function getDefinition(
  env: Env,
  tenantId: string,
  id: string,
): Promise<ReportDefinitionRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM report_definitions WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(id, tenantId)
    .first<ReportDefinitionRow>();
  return row ?? null;
}

/** Build the report for a definition and store the run. */
export async function runDefinition(
  env: Env,
  row: ReportDefinitionRow,
  now: string = nowIso(),
): Promise<{ runId: string; report: unknown }> {
  const definition = parseDefinition(row.definition_json);
  const today = now.slice(0, 10);
  const { from, to } = resolveRange(definition.range, today);
  const report = await buildTimeReport(env, {
    tenantId: row.tenant_id,
    from,
    to,
    groupBy: definition.group_by,
    projectId: definition.project_id ?? undefined,
    accountId: definition.account_id ?? undefined,
  });
  const runId = randomId();
  await env.DB.prepare(
    "INSERT INTO report_runs (id, tenant_id, definition_id, report_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(runId, row.tenant_id, row.id, JSON.stringify(report), now)
    .run();
  return { runId, report };
}

/** Cron entry point: run every definition whose schedule is due. */
export async function runDueReports(
  env: Env,
  now: string = nowIso(),
): Promise<{ ran: number }> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM report_definitions WHERE deleted_at IS NULL",
  ).all<ReportDefinitionRow>();
  let ran = 0;
  for (const row of results ?? []) {
    if (row.schedule === "off" || !row.next_run_at) continue;
    if (row.next_run_at > now) continue;
    try {
      await runDefinition(env, row, now);
      ran++;
      await dispatchNotifications(env, {
        kind: "report_ready",
        tenantId: row.tenant_id,
        recipientIds: [row.created_by_account_id],
        title: `定期レポート「${row.name}」を生成しました`,
        payload: { definition_id: row.id },
        relatedType: "report_definition",
        relatedId: row.id,
      });
    } catch {
      // A broken definition must not stop the cron; the next_run_at
      // update below still advances the schedule.
    }
    await env.DB.prepare(
      "UPDATE report_definitions SET last_run_at = ?1, next_run_at = ?2, updated_at = ?3 WHERE id = ?4",
    )
      .bind(now, nextRunAt(row.schedule, now), now, row.id)
      .run();
  }
  return { ran };
}
