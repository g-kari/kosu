/**
 * Invites, tenant/workspace settings and the work calendar (phase 2).
 *
 *   POST   /api/v1/tenants/:tenantId/invites
 *   GET    /api/v1/tenants/:tenantId/invites        (tenant admin)
 *   DELETE /api/v1/tenants/:tenantId/invites/:id    (admin of the target)
 *   POST   /api/v1/invites/accept { token }
 *   GET    /api/v1/invites/preview?token=           (logged in)
 *   GET/PUT /api/v1/tenants/:tenantId/settings      (read member, write admin)
 *   GET    /api/v1/tenants/:tenantId/calendar?from=&to=
 *   PUT/DELETE /api/v1/tenants/:tenantId/calendar/:date  (tenant admin)
 *   GET/PUT /api/v1/tenants/:tenantId/workspaces/:workspaceId/rounding
 */
import { Hono } from "hono";
import { sha256Hex } from "../tokens";
import { badRequest, forbidden, notFound } from "../errors";
import { guard, loadTenant, loadWorkspace } from "../hierarchy";
import {
  acceptInvite,
  createInvite,
  listInvites,
  parseInviteInput,
  publicInvite,
  revokeInvite,
} from "../invites";
import {
  calendarRange,
  clearCalendarDay,
  getTenantSettings,
  parseRoundingMinutes,
  parseRoundingMode,
  parseWorkdays,
  putTenantSettings,
  putWorkspaceRounding,
  resolveRounding,
  setCalendarDay,
} from "../settings";
import { isDateString } from "../timecalc";
import type { Env, InviteRow, Variables } from "../types";
import { auth, readJsonBody } from "./http";

export const collabRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const TENANT_PATH = "/api/v1/tenants/:tenantId";

collabRoutes.post(`${TENANT_PATH}/invites`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  const input = parseInviteInput(body);
  const { invite, acceptUrl } = await createInvite(
    c.env,
    principal,
    tenantId,
    input,
  );
  // No mail infrastructure: the link is shown once to the inviter, who
  // shares it out of band. Only its hash is stored.
  return c.json(
    { invite: publicInvite(invite), accept_url: acceptUrl },
    201,
  );
});

collabRoutes.get(`${TENANT_PATH}/invites`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner" && chain.tenant !== "admin") {
    throw forbidden("Listing invites requires a tenant admin");
  }
  const invites = await listInvites(c.env, tenantId);
  return c.json({ invites: invites.map(publicInvite) });
});

collabRoutes.delete(`${TENANT_PATH}/invites/:inviteId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await revokeInvite(c.env, principal, tenantId, c.req.param("inviteId") as string);
  return c.json({ ok: true });
});

async function findInviteByToken(c: { env: Env }, token: string) {
  const hash = await sha256Hex(token.trim());
  const row = await c.env.DB.prepare(
    "SELECT * FROM invites WHERE token_hash = ?1",
  )
    .bind(hash)
    .first<InviteRow>();
  if (!row) throw notFound("Invite not found");
  return row;
}

collabRoutes.get("/api/v1/invites/preview", async (c) => {
  await auth(c);
  const token = c.req.query("token");
  if (!token) throw badRequest('"token" query is required');
  const row = await findInviteByToken(c, token);
  return c.json({ invite: publicInvite(row) });
});

collabRoutes.post("/api/v1/invites/accept", async (c) => {
  const principal = await auth(c);
  const body = await readJsonBody(c);
  const token = body["token"];
  if (typeof token !== "string" || !token) {
    throw badRequest('"token" is required');
  }
  const row = await acceptInvite(c.env, principal, token);
  return c.json({ invite: publicInvite(row), accepted: true });
});

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

collabRoutes.get(`${TENANT_PATH}/settings`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  return c.json({ settings: await getTenantSettings(c.env, tenantId) });
});

collabRoutes.put(`${TENANT_PATH}/settings`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner" && chain.tenant !== "admin") {
    throw forbidden("Changing tenant settings requires a tenant admin");
  }
  const patch: {
    weekly_workdays?: number[];
    rounding_minutes?: number;
    rounding_mode?: "nearest" | "up" | "down";
  } = {};
  if (body["weekly_workdays"] !== undefined) {
    patch.weekly_workdays = parseWorkdays(body["weekly_workdays"]);
  }
  if (body["rounding_minutes"] !== undefined) {
    patch.rounding_minutes = parseRoundingMinutes(body["rounding_minutes"]);
  }
  if (body["rounding_mode"] !== undefined) {
    patch.rounding_mode = parseRoundingMode(body["rounding_mode"]);
  }
  const settings = await putTenantSettings(c.env, tenantId, patch);
  return c.json({ settings });
});

collabRoutes.put(`${TENANT_PATH}/workspaces/:workspaceId/rounding`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const workspaceId = c.req.param("workspaceId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await guard(c.env, principal, { tenantId, workspaceId }, "admin");
  // A null (or omitted) field clears that override, inheriting the tenant.
  const minutes =
    body["rounding_minutes"] === undefined || body["rounding_minutes"] === null
      ? null
      : parseRoundingMinutes(body["rounding_minutes"]);
  const mode =
    body["rounding_mode"] === undefined || body["rounding_mode"] === null
      ? null
      : parseRoundingMode(body["rounding_mode"]);
  await putWorkspaceRounding(c.env, workspaceId, { minutes, mode });
  return c.json({
    rounding: await resolveRounding(c.env, tenantId, workspaceId),
  });
});

/* ------------------------------------------------------------------ */
/* Work calendar                                                        */
/* ------------------------------------------------------------------ */

collabRoutes.get(`${TENANT_PATH}/calendar`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!isDateString(from) || !isDateString(to)) {
    throw badRequest('"from" and "to" queries (YYYY-MM-DD) are required');
  }
  return c.json({ days: await calendarRange(c.env, tenantId, from, to) });
});

collabRoutes.put(`${TENANT_PATH}/calendar/:date`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner" && chain.tenant !== "admin") {
    throw forbidden("Changing the calendar requires a tenant admin");
  }
  const date = c.req.param("date") as string;
  const kind = body["kind"] ?? body["type"];
  if (kind !== "workday" && kind !== "holiday") {
    throw badRequest('"kind" must be "workday" or "holiday"');
  }
  const note =
    typeof body["note"] === "string" && body["note"].length <= 200
      ? body["note"]
      : null;
  await setCalendarDay(c.env, tenantId, date, kind, note);
  return c.json({ ok: true });
});

collabRoutes.delete(`${TENANT_PATH}/calendar/:date`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner" && chain.tenant !== "admin") {
    throw forbidden("Changing the calendar requires a tenant admin");
  }
  const date = c.req.param("date") as string;
  if (!isDateString(date)) throw badRequest('"date" must be YYYY-MM-DD');
  await clearCalendarDay(c.env, tenantId, date);
  return c.json({ ok: true });
});
