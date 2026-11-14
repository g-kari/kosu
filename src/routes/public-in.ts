/**
 * Public inbound endpoints (phase 4). No session/API-key auth — each
 * route carries its own credential:
 *
 * - POST /webhooks/github/:connectionId, POST /webhooks/linear/:connectionId
 *     HMAC-SHA256 signature against the connection's inbound webhook
 *     secret (issued once at connection creation). The connection id in
 *     the path selects which secret verifies the body.
 * - GET  /feeds/ical/:token.ics
 *     The unguessable feed token (only its SHA-256 hash is stored).
 * - POST /inbound/mail/:token
 *     The unguessable per-project inbound token (hash-stored). A mail
 *     forwarding service POSTs parsed mail as JSON {subject, from,
 *     text}; a plain-text body also works (first line = title).
 *
 * Failures are plain 401/404 without detail about which part
 * mismatched, and no secret or sub value is ever rendered here.
 */
import { Hono } from "hono";
import {
  connectionWebhookSecret,
  handleGithubWebhook,
  handleLinearWebhook,
  loadConnectionAny,
  loadIcalFeedByToken,
  loadMailInboundTokenByToken,
  loadProjectRowLoose,
  recordSyncRun,
  statusSlugForCategory,
  touchIcalFeed,
  verifyWebhookSignature,
} from "../integrations";
import { insertTask } from "../tasks";
import type {
  Env,
  IntegrationConnectionRow,
  ProjectRow,
  TaskRow,
  Variables,
} from "../types";
import type { Ctx } from "./http";

export const publicInRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

const BODY_LIMIT = 1024 * 1024;

function jsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function verifiedConnection(
  c: Ctx,
  provider: "github" | "linear",
  rawBody: string,
  signature: string | null,
): Promise<IntegrationConnectionRow | null> {
  const connectionId = c.req.param("connectionId") as string;
  const connection = await loadConnectionAny(c.env, connectionId);
  if (!connection) return null;
  if (connection.provider !== provider) return null;
  if (connection.enabled !== 1) return null;
  if (!signature) return null;
  const secret = await connectionWebhookSecret(c.env, connection);
  if (!secret) return null;
  const ok = await verifyWebhookSignature(secret, rawBody, signature);
  return ok ? connection : null;
}

async function handleWebhook(
  c: Ctx,
  provider: "github" | "linear",
): Promise<Response> {
  const raw = await c.req.text();
  if (raw.length > BODY_LIMIT) return c.json({ error: "too_large" }, 413);
  const signatureHeader =
    provider === "github"
      ? (c.req.header("x-hub-signature-256") ?? "")
      : (c.req.header("linear-signature") ?? "");
  const signature = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  const connection = await verifiedConnection(
    c,
    provider,
    raw,
    signature || null,
  );
  if (!connection) return c.json({ error: "unauthorized" }, 401);
  if (provider === "github" && c.req.header("x-github-event") === "ping") {
    return c.json({ ok: true, pong: true });
  }
  const payload = jsonRecord(raw);
  if (!payload) return c.json({ error: "invalid_json" }, 400);
  const project = connection.project_id
    ? await loadProjectRowLoose(c.env, connection.project_id)
    : null;
  const outcome =
    provider === "github"
      ? await handleGithubWebhook(c.env, connection, project, payload)
      : await handleLinearWebhook(c.env, connection, project, payload);
  await recordSyncRun(c.env, {
    tenantId: connection.tenant_id,
    connectionId: connection.id,
    provider,
    kind: "webhook",
    status: "ok",
    message: outcome.detail,
    stats: {
      handled: outcome.handled,
      tasks_completed: outcome.tasksCompleted,
      tasks_upserted: outcome.tasksUpserted,
    },
    createdByAccountId: connection.created_by_account_id,
  });
  return c.json({
    ok: true,
    handled: outcome.handled,
    detail: outcome.detail,
  });
}

publicInRoutes.post("/webhooks/github/:connectionId", (c) =>
  handleWebhook(c, "github"),
);
publicInRoutes.post("/webhooks/linear/:connectionId", (c) =>
  handleWebhook(c, "linear"),
);

/* ------------------------------------------------------------------ */
/* iCal feed                                                            */
/* ------------------------------------------------------------------ */

function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function nextDate(ymd: string): string {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(ms + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

publicInRoutes.get("/feeds/ical/:file", async (c) => {
  const file = c.req.param("file") as string;
  if (!file.endsWith(".ics")) return c.text("Not found", 404);
  const token = file.slice(0, -".ics".length);
  if (!token) return c.text("Not found", 404);
  const feed = await loadIcalFeedByToken(c.env, token);
  if (!feed) return c.text("Not found", 404);
  await touchIcalFeed(c.env, feed.id);

  // The feed is personal: only tasks in projects the feed owner can
  // read (a membership at any level of the project's ancestry).
  const projectsRes = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(feed.tenant_id)
    .all<ProjectRow>();
  const memberOf = async (sql: string, ...binds: unknown[]) => {
    const row = await c.env.DB.prepare(sql)
      .bind(...binds)
      .first<Record<string, unknown>>();
    return row !== null;
  };
  const isTenantMember = await memberOf(
    "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
    feed.tenant_id,
    feed.account_id,
  );
  const readableProjectIds = new Set<string>();
  for (const project of projectsRes.results) {
    const readable =
      isTenantMember ||
      (await memberOf(
        "SELECT account_id FROM workspace_members WHERE workspace_id = ?1 AND account_id = ?2",
        project.workspace_id,
        feed.account_id,
      )) ||
      (await memberOf(
        "SELECT account_id FROM team_members WHERE team_id = ?1 AND account_id = ?2",
        project.team_id,
        feed.account_id,
      )) ||
      (await memberOf(
        "SELECT account_id FROM project_members WHERE project_id = ?1 AND account_id = ?2",
        project.id,
        feed.account_id,
      ));
    if (readable) readableProjectIds.add(project.id);
  }
  const allTasks = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(feed.tenant_id)
    .all<TaskRow>();
  const tasks = allTasks.results
    .filter(
      (t) =>
        t.due_date !== null &&
        // Loose null check: rows written before phase 3 may simply
        // lack the column in some stores.
        (t.archived_at === null || t.archived_at === undefined) &&
        t.project_id !== null &&
        readableProjectIds.has(t.project_id),
    )
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
    .slice(0, 1000);

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kosu//Tasks//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Kosu tasks",
  ];
  for (const task of tasks) {
    const due = (task.due_date as string).replace(/-/g, "");
    const end = nextDate(task.due_date as string).replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${task.id}@kosu.0g0.xyz`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${due}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${icsEscape(task.title)}`,
      `DESCRIPTION:${icsEscape(`Kosu task status: ${task.status}`)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="kosu.ics"',
      "cache-control": "private, max-age=300",
    },
  });
});

/* ------------------------------------------------------------------ */
/* Mail inbound                                                         */
/* ------------------------------------------------------------------ */

publicInRoutes.post("/inbound/mail/:token", async (c) => {
  const token = c.req.param("token") as string;
  const row = await loadMailInboundTokenByToken(c.env, token);
  if (!row) return c.json({ error: "not_found" }, 404);
  const raw = await c.req.text();
  if (raw.length > BODY_LIMIT) return c.json({ error: "too_large" }, 413);
  let subject: string | null = null;
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = jsonRecord(raw);
    const value = body?.["subject"] ?? body?.["title"];
    subject = typeof value === "string" && value ? value : null;
  }
  if (!subject) {
    // Plain-text fallback: the first non-empty line is the title.
    subject =
      raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? null;
  }
  const title = (subject ?? "").slice(0, 300).trim();
  if (!title) return c.json({ error: "subject_required" }, 400);
  const project = await loadProjectRowLoose(c.env, row.project_id);
  if (!project) return c.json({ error: "project_not_found" }, 422);
  const openStatus = await statusSlugForCategory(c.env, project, "open");
  const task = await insertTask(
    c.env,
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
    { accountId: row.created_by_account_id, admin: true },
  );
  await recordSyncRun(c.env, {
    tenantId: row.tenant_id,
    connectionId: null,
    provider: "mail",
    kind: "webhook",
    status: "ok",
    stats: { created_tasks: 1, task_id: task.id, project_id: project.id },
    createdByAccountId: row.created_by_account_id,
  });
  return c.json({ ok: true, task_id: task.id }, 201);
});
