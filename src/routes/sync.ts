/**
 * Sync API and account vault (phase 2).
 *
 *   POST   /api/v1/sync/devices            register a device
 *   GET    /api/v1/sync/devices            list my devices
 *   DELETE /api/v1/sync/devices/:deviceId  revoke a device
 *   POST   /api/v1/tenants/:tenantId/sync/push
 *   GET    /api/v1/tenants/:tenantId/sync/pull?device_id=&since_seq=
 *   GET    /api/v1/tenants/:tenantId/sync/status?device_id=
 *   GET    /api/v1/tenants/:tenantId/sync/conflicts (tenant admin)
 *   GET/PUT /api/v1/me/encryption-key
 *   POST   /api/v1/me/encryption-key/recover
 *
 * Sync traffic requires a registered, non-revoked device so a lost
 * device can be cut off without rotating the account.
 */
import { Hono } from "hono";
import { badRequest, forbidden, conflict } from "../errors";
import { cleanName, guard, loadTenant } from "../hierarchy";
import {
  applyPush,
  listConflicts,
  listDevices,
  publicDevice,
  registerDevice,
  requireActiveDevice,
  revokeDevice,
  syncPull,
  syncScopeToken,
  syncStatus,
  type PushChange,
} from "../sync";
import {
  getAccountKey,
  parseVaultInput,
  publicVault,
  putAccountKey,
  recoverAccountKey,
} from "../vault";
import type { Env, Variables } from "../types";
import { auth, queryInt, readJsonBody, type Ctx } from "./http";

export const syncRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const TENANT_SYNC = "/api/v1/tenants/:tenantId/sync";

syncRoutes.post("/api/v1/sync/devices", async (c) => {
  const principal = await auth(c);
  const body = await readJsonBody(c);
  const name = cleanName(body["name"], "name");
  const platform =
    typeof body["platform"] === "string" && body["platform"].length <= 40
      ? body["platform"]
      : null;
  const row = await registerDevice(c.env, principal.accountId, name, platform);
  return c.json({ device: publicDevice(row) }, 201);
});

syncRoutes.get("/api/v1/sync/devices", async (c) => {
  const principal = await auth(c);
  const devices = await listDevices(c.env, principal.accountId);
  return c.json({ devices: devices.map(publicDevice) });
});

syncRoutes.delete("/api/v1/sync/devices/:deviceId", async (c) => {
  const principal = await auth(c);
  await revokeDevice(c.env, principal.accountId, c.req.param("deviceId") as string);
  return c.json({ ok: true });
});

async function deviceGate(c: Ctx, tenantId: string, deviceId: string) {
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  await requireActiveDevice(c.env, principal.accountId, deviceId);
  return principal;
}

function deviceIdFrom(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200) {
    throw badRequest('"device_id" is required');
  }
  return value;
}

syncRoutes.post(`${TENANT_SYNC}/push`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const body = await readJsonBody(c);
  const deviceId = deviceIdFrom(body["device_id"]);
  const principal = await deviceGate(c, tenantId, deviceId);
  if (body["protocol"] !== 2) throw badRequest("Sync client upgrade required (protocol 2)");
  if (body["scope_token"] !== await syncScopeToken(c.env,principal,tenantId)) throw conflict("SYNC_SCOPE_CHANGED", "Refresh access before uploading local changes");
  const changes = body["changes"];
  if (!Array.isArray(changes)) throw badRequest('"changes" must be an array');
  const result = await applyPush(
    c.env,
    principal,
    tenantId,
    deviceId,
    changes as PushChange[],
  );
  return c.json({ results: result.results, last_seq: result.lastSeq });
});

syncRoutes.get(`${TENANT_SYNC}/pull`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const deviceId = deviceIdFrom(c.req.query("device_id"));
  const principal = await deviceGate(c, tenantId, deviceId);
  const sinceSeq = queryInt(c, "since_seq", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = queryInt(c, "limit", 500, 1, 1000);
  if (c.req.query("protocol") !== "2") throw badRequest("Sync client upgrade required (protocol 2)");
  return c.json(await syncPull(c.env, principal, tenantId, sinceSeq, limit, c.req.query("scope_token") ?? ""));
});

syncRoutes.get(`${TENANT_SYNC}/status`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const deviceId = deviceIdFrom(c.req.query("device_id"));
  const principal = await deviceGate(c, tenantId, deviceId);
  return c.json(await syncStatus(c.env, principal, tenantId));
});

syncRoutes.get(`${TENANT_SYNC}/conflicts`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner" && chain.tenant !== "admin") {
    throw forbidden("Sync conflicts require a tenant admin");
  }
  return c.json({ conflicts: await listConflicts(c.env, tenantId) });
});

/* ------------------------------------------------------------------ */
/* Account encryption vault                                             */
/* ------------------------------------------------------------------ */

syncRoutes.get("/api/v1/me/encryption-key", async (c) => {
  const principal = await auth(c);
  return c.json({ vault: publicVault(await getAccountKey(c.env, principal.accountId)) });
});

syncRoutes.put("/api/v1/me/encryption-key", async (c) => {
  const principal = await auth(c);
  const body = await readJsonBody(c);
  const input = parseVaultInput(body);
  const rotate = body["rotate"] === true;
  const currentRecoveryCode =
    typeof body["current_recovery_code"] === "string"
      ? body["current_recovery_code"]
      : undefined;
  const row = await putAccountKey(c.env, principal.accountId, input, {
    rotate,
    currentRecoveryCode,
  });
  return c.json({ vault: publicVault(row) });
});

syncRoutes.post("/api/v1/me/encryption-key/recover", async (c) => {
  const principal = await auth(c);
  const body = await readJsonBody(c);
  const code = body["recovery_code"];
  if (typeof code !== "string" || !code) {
    throw badRequest('"recovery_code" is required');
  }
  const row = await recoverAccountKey(c.env, principal.accountId, code);
  return c.json({ vault: publicVault(row), verified: true });
});

