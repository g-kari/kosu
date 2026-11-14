/**
 * Phase-3 ops API: aggregated reports (+ CSV export and a printable
 * HTML view), member rates, project budgets, leave records,
 * submissions / period locks / entry change requests / proxy entry,
 * notifications & preferences & webhook endpoints, and sync-conflict
 * diffs & resolution.
 *
 * Paths (all under /api/v1):
 *   /tenants/:tenantId/report?from&to&group_by&format=json|csv
 *   /tenants/:tenantId/report/print?...            printable HTML
 *   /tenants/:tenantId/rates[/:accountId]          tenant admin
 *   /tenants/:tenantId/projects/:projectId/budget
 *   /tenants/:tenantId/leave[/:leaveId]
 *   /tenants/:tenantId/submissions[/:id/decide]
 *   /tenants/:tenantId/period-locks[/:period/lock|unlock]
 *   /tenants/:tenantId/change-requests[/:id/decide]
 *   /tenants/:tenantId/time-entries/proxy          tenant admin
 *   /me/notifications[/:id/read|/read-all]
 *   /tenants/:tenantId/notification-prefs
 *   /tenants/:tenantId/webhooks[/:webhookId]       tenant admin
 *   /tenants/:tenantId/sync-conflicts[/:id[/resolve]]
 */
import { Hono } from "hono";

import { recordAudit } from "../audit";
import {
  createChangeRequest,
  createSubmission,
  decideChangeRequest,
  decideSubmission,
  listChangeRequests,
  listLocks,
  listSubmissions,
  lockPeriod,
  proxyCreateEntry,
  publicChangeRequest,
  publicSubmission,
  unlockPeriod,
} from "../approvals";
import { loadConflict, publicConflict, resolveConflict } from "../conflicts";
import { badRequest, forbidden, notFound } from "../errors";
import { guard, loadTenant } from "../hierarchy";
import {
  createWebhook,
  deleteWebhook,
  getPrefs,
  listNotifications,
  listWebhooks,
  loadWebhook,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_KINDS,
  publicNotification,
  publicWebhook,
  putPrefs,
  type ChannelPref,
  type NotificationPrefs,
} from "../notify";
import {
  buildTimeReport,
  createLeave,
  deleteLeave,
  getBudget,
  listLeave,
  listRates,
  publicLeave,
  putBudget,
  putRate,
  reportToCsv,
  type ReportGroupBy,
} from "../reports";
import { isDateString } from "../timecalc";
import type {
  Env,
  Principal,
  SyncConflictRow,
  Variables,
} from "../types";
import { auth, readJsonBody, type Ctx } from "./http";

export const opsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const TENANT_PATH = "/api/v1/tenants/:tenantId";

async function isTenantAdmin(
  c: Ctx,
  principal: Principal,
  tenantId: string,
): Promise<boolean> {
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  return chain.tenant === "owner" || chain.tenant === "admin";
}

async function requireTenantAdmin(
  c: Ctx,
  principal: Principal,
  tenantId: string,
): Promise<void> {
  if (!(await isTenantAdmin(c, principal, tenantId))) {
    throw forbidden("A tenant admin role is required");
  }
}

function optString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Load a project by id alone (tenant-scoped routes carry no team id). */
async function loadProjectScoped(c: Ctx, projectId: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(projectId)
    .first<import("../types").ProjectRow>();
  if (!row) throw notFound("Project not found");
  return row;
}

/* ------------------------------------------------------------------ */
/* Reports                                                              */
/* ------------------------------------------------------------------ */

interface ReportParams {
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  projectId: string | null;
  accountId: string | null;
}

function parseReportParams(c: Ctx): ReportParams {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!isDateString(from) || !isDateString(to)) {
    throw badRequest('Query parameters "from" and "to" (YYYY-MM-DD) are required');
  }
  const groupRaw = c.req.query("group_by") ?? "project";
  if (!["project", "member", "task", "day"].includes(groupRaw)) {
    throw badRequest('"group_by" must be project, member, task or day');
  }
  return {
    from,
    to,
    groupBy: groupRaw as ReportGroupBy,
    projectId: c.req.query("project_id") ?? null,
    accountId: c.req.query("account_id") ?? null,
  };
}

async function assertReportScope(
  c: Ctx,
  principal: Principal,
  tenantId: string,
  params: ReportParams,
): Promise<void> {
  // A member may always see the tenant-wide aggregate and their own
  // numbers; filtering to somebody else's entries requires an admin.
  if (params.accountId && params.accountId !== principal.accountId) {
    await requireTenantAdmin(c, principal, tenantId);
  }
}

opsRoutes.get(`${TENANT_PATH}/report`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const params = parseReportParams(c);
  await assertReportScope(c, principal, tenantId, params);
  const report = await buildTimeReport(c.env, {
    tenantId,
    from: params.from,
    to: params.to,
    groupBy: params.groupBy,
    projectId: params.projectId,
    accountId: params.accountId,
  });
  const format = c.req.query("format") ?? "json";
  if (format === "csv") {
    return new Response(reportToCsv(report), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="kosu-report-${params.from}-${params.to}.csv"`,
      },
    });
  }
  if (format !== "json") throw badRequest('"format" must be json or csv');
  return c.json({ report });
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatHours(seconds: number): string {
  return (seconds / 3600).toFixed(2);
}

opsRoutes.get(`${TENANT_PATH}/report/print`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const tenant = await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const params = parseReportParams(c);
  await assertReportScope(c, principal, tenantId, params);
  const report = await buildTimeReport(c.env, {
    tenantId,
    from: params.from,
    to: params.to,
    groupBy: params.groupBy,
    projectId: params.projectId,
    accountId: params.accountId,
  });
  const rows = report.groups
    .map(
      (g) =>
        `<tr><td>${escapeHtml(g.label)}</td><td>${g.entries}</td>` +
        `<td>${formatHours(g.seconds)}</td><td>${formatHours(g.rounded_seconds)}</td>` +
        `<td>${g.cost_cents}</td>` +
        `<td>${g.expected_seconds !== undefined ? formatHours(g.expected_seconds) : ""}</td>` +
        `<td>${g.budget_cents !== undefined && g.budget_cents !== null ? String(g.budget_cents) : ""}</td>` +
        `<td>${g.over_budget ? "超過" : ""}</td></tr>`,
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kosu 工数レポート ${escapeHtml(params.from)} 〜 ${escapeHtml(params.to)}</title>
<style>
body { font-family: sans-serif; margin: 24px; color: #111; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #999; padding: 6px 8px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
@media print { body { margin: 0; } }
</style></head><body>
<h1>${escapeHtml(tenant.name)} — 工数レポート</h1>
<p>期間: ${escapeHtml(params.from)} 〜 ${escapeHtml(params.to)} / 集計単位: ${escapeHtml(params.groupBy)} / 通貨: ${escapeHtml(report.currency)}</p>
<table>
<thead><tr><th scope="col">項目</th><th scope="col">件数</th><th scope="col">実績 (h)</th><th scope="col">丸め後 (h)</th><th scope="col">コスト (セント)</th><th scope="col">期待値 (h)</th><th scope="col">予算 (セント)</th><th scope="col">予算超過</th></tr></thead>
<tbody>
${rows}
<tr><th scope="row">合計</th><th scope="col">${report.totals.entries}</th><th scope="col">${formatHours(report.totals.seconds)}</th><th scope="col">${formatHours(report.totals.rounded_seconds)}</th><th scope="col">${report.totals.cost_cents}</th><th scope="col"></th><th scope="col"></th><th scope="col"></th></tr>
</tbody></table>
<p>このページは印刷・PDF 保存向けの表示です。</p>
</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});

/* ------------------------------------------------------------------ */
/* Rates and budgets                                                    */
/* ------------------------------------------------------------------ */

opsRoutes.get(`${TENANT_PATH}/rates`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const rates = await listRates(c.env, tenantId);
  return c.json({ rates });
});

opsRoutes.put(`${TENANT_PATH}/rates/:accountId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const rateRaw = body["rate_cents_per_hour"];
  if (typeof rateRaw !== "number" || !Number.isInteger(rateRaw) || rateRaw < 0) {
    throw badRequest('"rate_cents_per_hour" must be a non-negative integer');
  }
  const currency = optString(body["currency"]) ?? "JPY";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw badRequest('"currency" must be a 3-letter code');
  }
  const target = c.req.param("accountId") as string;
  const member = await c.env.DB.prepare(
    "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
  )
    .bind(tenantId, target)
    .first<{ account_id: string }>();
  if (!member) throw badRequest("Target account is not a tenant member");
  const rate = await putRate(
    c.env,
    tenantId,
    target,
    rateRaw,
    currency,
    principal.accountId,
  );
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "rate.update",
    targetType: "account",
    targetId: target,
    detail: `${rateRaw} ${currency}/h`,
  });
  return c.json({ rate });
});

opsRoutes.get(`${TENANT_PATH}/projects/:projectId/budget`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const project = await loadProjectScoped(c, c.req.param("projectId") as string);
  if (project.tenant_id !== tenantId) throw notFound("Project not found");
  await guard(
    c.env,
    principal,
    {
      tenantId,
      workspaceId: project.workspace_id,
      teamId: project.team_id,
      projectId: project.id,
    },
    "read",
  );
  const budget = await getBudget(c.env, project.id);
  return c.json({ budget });
});

opsRoutes.put(`${TENANT_PATH}/projects/:projectId/budget`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  const project = await loadProjectScoped(c, c.req.param("projectId") as string);
  if (project.tenant_id !== tenantId) throw notFound("Project not found");
  await guard(
    c.env,
    principal,
    {
      tenantId,
      workspaceId: project.workspace_id,
      teamId: project.team_id,
      projectId: project.id,
    },
    "admin",
  );
  const budgetRaw = body["budget_cents"];
  if (
    typeof budgetRaw !== "number" ||
    !Number.isInteger(budgetRaw) ||
    budgetRaw < 0
  ) {
    throw badRequest('"budget_cents" must be a non-negative integer');
  }
  const currency = optString(body["currency"]) ?? "JPY";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw badRequest('"currency" must be a 3-letter code');
  }
  const budget = await putBudget(
    c.env,
    tenantId,
    project.id,
    budgetRaw,
    currency,
    principal.accountId,
  );
  await recordAudit(c.env, {
    tenantId,
    workspaceId: project.workspace_id,
    accountId: principal.accountId,
    action: "budget.update",
    targetType: "project",
    targetId: project.id,
    detail: `${budgetRaw} ${currency}`,
  });
  return c.json({ budget });
});

/* ------------------------------------------------------------------ */
/* Leave                                                                */
/* ------------------------------------------------------------------ */

opsRoutes.get(`${TENANT_PATH}/leave`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const from = c.req.query("from") ?? "0000-01-01";
  const to = c.req.query("to") ?? "9999-12-31";
  if (!isDateString(from) || !isDateString(to)) {
    throw badRequest('"from" and "to" must be YYYY-MM-DD dates');
  }
  const target = c.req.query("account_id") ?? null;
  const admin = await isTenantAdmin(c, principal, tenantId);
  if (target && target !== principal.accountId && !admin) {
    throw forbidden("Listing another member's leave requires a tenant admin");
  }
  const rows = await listLeave(
    c.env,
    tenantId,
    from,
    to,
    target ?? (admin ? null : principal.accountId),
  );
  return c.json({ leave: rows.map(publicLeave) });
});

opsRoutes.post(`${TENANT_PATH}/leave`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const target = optString(body["account_id"]) ?? principal.accountId;
  if (target !== principal.accountId) {
    await requireTenantAdmin(c, principal, tenantId);
  }
  const row = await createLeave(c.env, {
    tenantId,
    accountId: target,
    date: typeof body["date"] === "string" ? body["date"] : "",
    kind: typeof body["kind"] === "string" ? body["kind"] : "",
    noteEnc: optString(body["note_enc"]),
    createdByAccountId: principal.accountId,
  });
  return c.json({ leave: publicLeave(row) }, 201);
});

opsRoutes.delete(`${TENANT_PATH}/leave/:leaveId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const row = await c.env.DB.prepare(
    "SELECT * FROM leave_records WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(c.req.param("leaveId") as string, tenantId)
    .first<{ account_id: string }>();
  if (!row) throw notFound("Leave record not found");
  if (row.account_id !== principal.accountId) {
    await requireTenantAdmin(c, principal, tenantId);
  }
  await deleteLeave(c.env, c.req.param("leaveId") as string);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Submissions, period locks, change requests, proxy entry              */
/* ------------------------------------------------------------------ */

opsRoutes.post(`${TENANT_PATH}/submissions`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const row = await createSubmission(
    c.env,
    principal,
    tenantId,
    typeof body["period_start"] === "string" ? body["period_start"] : "",
    typeof body["period_end"] === "string" ? body["period_end"] : "",
  );
  return c.json({ submission: publicSubmission(row) }, 201);
});

opsRoutes.get(`${TENANT_PATH}/submissions`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const admin = await isTenantAdmin(c, principal, tenantId);
  const rows = await listSubmissions(
    c.env,
    tenantId,
    admin ? null : principal.accountId,
  );
  return c.json({ submissions: rows.map(publicSubmission) });
});

opsRoutes.post(`${TENANT_PATH}/submissions/:submissionId/decide`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const decision = body["decision"];
  if (decision !== "approved" && decision !== "rejected") {
    throw badRequest('"decision" must be "approved" or "rejected"');
  }
  const row = await decideSubmission(
    c.env,
    principal,
    tenantId,
    c.req.param("submissionId") as string,
    decision,
    optString(body["review_note_enc"]),
  );
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: `submission.${decision}`,
    targetType: "submission",
    targetId: row.id,
  });
  return c.json({ submission: publicSubmission(row) });
});

opsRoutes.get(`${TENANT_PATH}/period-locks`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const locks = await listLocks(c.env, tenantId);
  return c.json({ locks });
});

opsRoutes.post(`${TENANT_PATH}/period-locks/:period/lock`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const period = c.req.param("period") as string;
  await lockPeriod(c.env, principal, tenantId, period);
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "period.lock",
    targetType: "tenant",
    targetId: tenantId,
    detail: period,
  });
  return c.json({ ok: true, period });
});

opsRoutes.post(`${TENANT_PATH}/period-locks/:period/unlock`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const period = c.req.param("period") as string;
  await unlockPeriod(c.env, tenantId, period);
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "period.unlock",
    targetType: "tenant",
    targetId: tenantId,
    detail: period,
  });
  return c.json({ ok: true, period });
});

opsRoutes.post(`${TENANT_PATH}/change-requests`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const type = body["type"];
  if (type !== "edit" && type !== "create" && type !== "delete") {
    throw badRequest('"type" must be "edit", "create" or "delete"');
  }
  const payload = body["payload"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw badRequest('"payload" must be an object');
  }
  const row = await createChangeRequest(c.env, principal, tenantId, {
    entryId: optString(body["entry_id"]),
    type,
    payload: payload as Record<string, unknown>,
    reasonEnc: optString(body["reason_enc"]),
  });
  return c.json({ change_request: publicChangeRequest(row) }, 201);
});

opsRoutes.get(`${TENANT_PATH}/change-requests`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const admin = await isTenantAdmin(c, principal, tenantId);
  const rows = await listChangeRequests(c.env, tenantId, {
    accountId: principal.accountId,
    all: admin,
  });
  return c.json({ change_requests: rows.map(publicChangeRequest) });
});

opsRoutes.post(`${TENANT_PATH}/change-requests/:requestId/decide`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const decision = body["decision"];
  if (decision !== "approved" && decision !== "rejected") {
    throw badRequest('"decision" must be "approved" or "rejected"');
  }
  const admin = await isTenantAdmin(c, principal, tenantId);
  const row = await decideChangeRequest(
    c.env,
    principal,
    tenantId,
    c.req.param("requestId") as string,
    decision,
    admin,
  );
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: `change_request.${decision}`,
    targetType: "change_request",
    targetId: row.id,
  });
  return c.json({ change_request: publicChangeRequest(row) });
});

opsRoutes.post(`${TENANT_PATH}/time-entries/proxy`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const entry = await proxyCreateEntry(c.env, principal, tenantId, body);
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "time_entry.proxy_create",
    targetType: "time_entry",
    targetId: entry.id,
  });
  // proxyCreateEntry already returns the public entry shape.
  return c.json({ entry }, 201);
});

/* ------------------------------------------------------------------ */
/* Notifications, preferences, webhooks                                 */
/* ------------------------------------------------------------------ */

opsRoutes.get("/api/v1/me/notifications", async (c) => {
  const tenantId = c.req.query("tenant_id") ?? null;
  const principal = await auth(c, tenantId ?? undefined);
  const rows = await listNotifications(
    c.env,
    principal.accountId,
    tenantId,
    c.req.query("unread") === "1",
  );
  return c.json({ notifications: rows.map(publicNotification) });
});

opsRoutes.post("/api/v1/me/notifications/read-all", async (c) => {
  const body = await readJsonBody(c);
  const tenantId = optString(body["tenant_id"]);
  if (!tenantId) throw badRequest('"tenant_id" is required');
  const principal = await auth(c, tenantId);
  await markAllNotificationsRead(c.env, principal.accountId, tenantId);
  return c.json({ ok: true });
});

opsRoutes.post("/api/v1/me/notifications/:notificationId/read", async (c) => {
  const principal = await auth(c);
  const ok = await markNotificationRead(
    c.env,
    principal.accountId,
    c.req.param("notificationId") as string,
  );
  if (!ok) throw notFound("Notification not found");
  return c.json({ ok: true });
});

opsRoutes.get(`${TENANT_PATH}/notification-prefs`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const prefs = await getPrefs(c.env, principal.accountId, tenantId);
  return c.json({ prefs, kinds: NOTIFICATION_KINDS });
});

opsRoutes.put(`${TENANT_PATH}/notification-prefs`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const kindsRaw = body["kinds"];
  const kinds: Record<string, ChannelPref> = {};
  if (kindsRaw !== undefined) {
    if (!kindsRaw || typeof kindsRaw !== "object" || Array.isArray(kindsRaw)) {
      throw badRequest('"kinds" must be an object keyed by notification kind');
    }
    for (const [kind, pref] of Object.entries(
      kindsRaw as Record<string, unknown>,
    )) {
      if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) {
        throw badRequest(`Unknown notification kind "${kind}"`);
      }
      if (!pref || typeof pref !== "object" || Array.isArray(pref)) {
        throw badRequest(`Preference for "${kind}" must be an object`);
      }
      const p = pref as Record<string, unknown>;
      kinds[kind] = {
        in_app: p["in_app"] !== false,
        webhook: p["webhook"] !== false,
      };
    }
  }
  const quiet = (key: string): number | null => {
    const v = body[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1439) {
      throw badRequest(`"${key}" must be minutes after midnight (0-1439) or null`);
    }
    return v;
  };
  const tzRaw = body["tz_offset_minutes"];
  const tz =
    typeof tzRaw === "number" && Number.isInteger(tzRaw) ? tzRaw : 0;
  if (tz < -840 || tz > 840) {
    throw badRequest('"tz_offset_minutes" must be between -840 and 840');
  }
  const prefs: NotificationPrefs = {
    kinds,
    quiet_start_min: quiet("quiet_start_min"),
    quiet_end_min: quiet("quiet_end_min"),
    tz_offset_minutes: tz,
  };
  const saved = await putPrefs(c.env, principal.accountId, tenantId, prefs);
  return c.json({ prefs: saved });
});

opsRoutes.get(`${TENANT_PATH}/webhooks`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const rows = await listWebhooks(c.env, tenantId);
  return c.json({ webhooks: rows.map(publicWebhook) });
});

opsRoutes.post(`${TENANT_PATH}/webhooks`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const url = optString(body["url"]);
  if (!url) throw badRequest('"url" is required');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('"url" must be a valid URL');
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw badRequest('"url" must use http or https');
  }
  const eventsRaw = body["events"];
  const events: string[] = [];
  if (eventsRaw !== undefined) {
    if (!Array.isArray(eventsRaw)) {
      throw badRequest('"events" must be an array of notification kinds');
    }
    for (const e of eventsRaw) {
      if (
        typeof e !== "string" ||
        !(NOTIFICATION_KINDS as readonly string[]).includes(e)
      ) {
        throw badRequest(`Unknown notification kind "${String(e)}"`);
      }
      events.push(e);
    }
  }
  const { row, secret } = await createWebhook(c.env, {
    tenantId,
    url,
    events,
    createdByAccountId: principal.accountId,
  });
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "webhook.create",
    targetType: "webhook",
    targetId: row.id,
    detail: url.slice(0, 120),
  });
  // The signing secret is shown exactly once, here.
  return c.json({ webhook: publicWebhook(row), secret }, 201);
});

opsRoutes.delete(`${TENANT_PATH}/webhooks/:webhookId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await requireTenantAdmin(c, principal, tenantId);
  const row = await loadWebhook(
    c.env,
    tenantId,
    c.req.param("webhookId") as string,
  );
  if (!row) throw notFound("Webhook endpoint not found");
  await deleteWebhook(c.env, row);
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "webhook.delete",
    targetType: "webhook",
    targetId: row.id,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Sync conflicts: list, diff preview, resolve                          */
/* ------------------------------------------------------------------ */

opsRoutes.get(`${TENANT_PATH}/sync-conflicts`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const admin = await isTenantAdmin(c, principal, tenantId);
  const status = c.req.query("status") ?? "open";
  if (status !== "open" && status !== "resolved" && status !== "all") {
    throw badRequest('"status" must be open, resolved or all');
  }
  const res = await c.env.DB.prepare(
    "SELECT * FROM sync_conflicts WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<SyncConflictRow>();
  const rows = res.results
    .filter(
      (r) =>
        (admin || r.account_id === principal.accountId) &&
        (status === "all" || r.status === status),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return c.json({ conflicts: rows.map((r) => publicConflict(r)) });
});

async function loadConflictForActor(
  c: Ctx,
  principal: Principal,
  tenantId: string,
  conflictId: string,
): Promise<SyncConflictRow> {
  const row = await loadConflict(c.env, tenantId, conflictId);
  const admin = await isTenantAdmin(c, principal, tenantId);
  if (!admin && row.account_id !== principal.accountId) {
    throw notFound("Sync conflict not found");
  }
  return row;
}

opsRoutes.get(`${TENANT_PATH}/sync-conflicts/:conflictId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const row = await loadConflictForActor(
    c,
    principal,
    tenantId,
    c.req.param("conflictId") as string,
  );
  // withDiff: the response carries both payloads and a per-field
  // comparison (server / client / differs) for the preview screen.
  return c.json({ conflict: publicConflict(row, true) });
});

opsRoutes.post(`${TENANT_PATH}/sync-conflicts/:conflictId/resolve`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const row = await loadConflictForActor(
    c,
    principal,
    tenantId,
    c.req.param("conflictId") as string,
  );
  const choice = body["choice"];
  if (choice !== "server" && choice !== "client") {
    throw badRequest('"choice" must be "server" or "client"');
  }
  const resolved = await resolveConflict(c.env, principal, row, choice);
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "sync_conflict.resolve",
    targetType: "sync_conflict",
    targetId: row.id,
    detail: choice,
  });
  return c.json({ conflict: publicConflict(resolved, true) });
});
