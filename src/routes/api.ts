/**
 * Hierarchy JSON API under /api/v1.
 *
 *   POST/GET            /api/v1/tenants
 *   GET/PATCH/DELETE    /api/v1/tenants/:tenantId
 *   POST/GET            /api/v1/tenants/:tenantId/workspaces
 *   GET/PATCH/DELETE    /api/v1/tenants/:tenantId/workspaces/:workspaceId
 *   POST/GET            .../workspaces/:workspaceId/teams
 *   GET/PATCH/DELETE    .../teams/:teamId
 *   POST/GET            .../teams/:teamId/projects
 *   GET/PATCH/DELETE    .../projects/:projectId
 *   POST/GET            /api/v1/tenants/:tenantId/api-keys
 *   DELETE              /api/v1/tenants/:tenantId/api-keys/:keyId
 *
 * Authentication: session cookie or API key (see src/auth.ts). Deletes are
 * soft. Required access: create/list under a parent needs write on the
 * parent, updates need write on the resource, deletes need admin on the
 * resource.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  issueApiKey,
  listApiKeys,
  normalizeIpAllowlist,
  normalizeScopes,
  publicKey,
  revokeApiKey,
  updateApiKeyIpAllowlist,
} from "../apikeys";
import { recordAudit } from "../audit";
import { assertKeyTenant, requirePrincipal, requireSessionPrincipal } from "../auth";
import { badRequest } from "../errors";
import {
  cleanName,
  createProject,
  createTeam,
  createTenant,
  createWorkspace,
  deleteProject,
  deleteTeam,
  deleteTenant,
  deleteWorkspace,
  guard,
  listProjects,
  listTeams,
  listTenants,
  listWorkspaces,
  loadProject,
  loadTeam,
  loadTenant,
  loadWorkspace,
  parseProjectInput,
  publicProject,
  publicTeam,
  publicTenant,
  publicWorkspace,
  updateProject,
  updateTeam,
  updateTenant,
  updateWorkspace,
} from "../hierarchy";
import type { Env, Principal, Variables } from "../types";

export const apiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const BODY_LIMIT = 64 * 1024;

async function readJsonBody(c: Ctx): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.length > BODY_LIMIT) throw badRequest("Request body too large");
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function auth(c: Ctx, tenantId?: string): Promise<Principal> {
  const principal = await requirePrincipal(c);
  if (tenantId) assertKeyTenant(principal, tenantId);
  return principal;
}

/* ------------------------------------------------------------------ */
/* Tenants                                                              */
/* ------------------------------------------------------------------ */

apiRoutes.post("/api/v1/tenants", async (c) => {
  const principal = await requireSessionPrincipal(c);
  const body = await readJsonBody(c);
  const row = await createTenant(c.env, principal, cleanName(body["name"]));
  const { access } = await guard(
    c.env,
    principal,
    { tenantId: row.id },
    "read",
  );
  return c.json({ tenant: publicTenant(row, access) }, 201);
});

apiRoutes.get("/api/v1/tenants", async (c) => {
  const principal = await auth(c);
  const tenants = await listTenants(c.env, principal);
  // An API key sees only its own tenant in the list.
  const visible =
    principal.kind === "api_key"
      ? tenants.filter((t) => t.row.id === principal.tenantId)
      : tenants;
  return c.json({
    tenants: visible.map((t) => publicTenant(t.row, t.access)),
  });
});

apiRoutes.get("/api/v1/tenants/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const principal = await auth(c, tenantId);
  const row = await loadTenant(c.env, tenantId);
  const { access } = await guard(c.env, principal, { tenantId }, "read");
  return c.json({ tenant: publicTenant(row, access) });
});

apiRoutes.patch("/api/v1/tenants/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const row = await updateTenant(c.env, tenantId, cleanName(body["name"]));
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "tenant.update",
    targetType: "tenant",
    targetId: tenantId,
    detail: row.name.slice(0, 80),
  });
  const { access } = await guard(c.env, principal, { tenantId }, "read");
  return c.json({ tenant: publicTenant(row, access) });
});

apiRoutes.delete("/api/v1/tenants/:tenantId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "admin");
  await deleteTenant(c.env, tenantId);
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "tenant.delete",
    targetType: "tenant",
    targetId: tenantId,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Workspaces                                                           */
/* ------------------------------------------------------------------ */

const WS_PATH = "/api/v1/tenants/:tenantId/workspaces";

apiRoutes.post(WS_PATH, async (c) => {
  const tenantId = c.req.param("tenantId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const row = await createWorkspace(
    c.env,
    principal,
    tenantId,
    cleanName(body["name"]),
  );
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId: row.id },
    "read",
  );
  return c.json({ workspace: publicWorkspace(row, access) }, 201);
});

apiRoutes.get(WS_PATH, async (c) => {
  const tenantId = c.req.param("tenantId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const workspaces = await listWorkspaces(c.env, principal, tenantId);
  return c.json({
    workspaces: workspaces.map((w) => publicWorkspace(w.row, w.access)),
  });
});

apiRoutes.get(`${WS_PATH}/:workspaceId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const row = await loadWorkspace(c.env, tenantId, workspaceId);
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId },
    "read",
  );
  return c.json({ workspace: publicWorkspace(row, access) });
});

apiRoutes.patch(`${WS_PATH}/:workspaceId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await guard(c.env, principal, { tenantId, workspaceId }, "write");
  const row = await updateWorkspace(
    c.env,
    tenantId,
    workspaceId,
    cleanName(body["name"]),
  );
  await recordAudit(c.env, {
    tenantId,
    workspaceId,
    accountId: principal.accountId,
    action: "workspace.update",
    targetType: "workspace",
    targetId: workspaceId,
    detail: row.name.slice(0, 80),
  });
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId },
    "read",
  );
  return c.json({ workspace: publicWorkspace(row, access) });
});

apiRoutes.delete(`${WS_PATH}/:workspaceId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await guard(c.env, principal, { tenantId, workspaceId }, "admin");
  await deleteWorkspace(c.env, workspaceId);
  await recordAudit(c.env, {
    tenantId,
    workspaceId,
    accountId: principal.accountId,
    action: "workspace.delete",
    targetType: "workspace",
    targetId: workspaceId,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Teams                                                                */
/* ------------------------------------------------------------------ */

const TEAM_PATH = `${WS_PATH}/:workspaceId/teams`;

apiRoutes.post(TEAM_PATH, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await guard(c.env, principal, { tenantId, workspaceId }, "write");
  const row = await createTeam(
    c.env,
    principal,
    tenantId,
    workspaceId,
    cleanName(body["name"]),
  );
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId, teamId: row.id },
    "read",
  );
  return c.json({ team: publicTeam(row, access) }, 201);
});

apiRoutes.get(TEAM_PATH, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await guard(c.env, principal, { tenantId, workspaceId }, "read");
  const teams = await listTeams(c.env, principal, tenantId, workspaceId);
  return c.json({ teams: teams.map((t) => publicTeam(t.row, t.access)) });
});

apiRoutes.get(`${TEAM_PATH}/:teamId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const teamId = c.req.param("teamId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  const row = await loadTeam(c.env, workspaceId, teamId);
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId, teamId },
    "read",
  );
  return c.json({ team: publicTeam(row, access) });
});

apiRoutes.patch(`${TEAM_PATH}/:teamId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const teamId = c.req.param("teamId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await loadTeam(c.env, workspaceId, teamId);
  await guard(c.env, principal, { tenantId, workspaceId, teamId }, "write");
  const row = await updateTeam(
    c.env,
    workspaceId,
    teamId,
    cleanName(body["name"]),
  );
  await recordAudit(c.env, {
    tenantId,
    workspaceId,
    accountId: principal.accountId,
    action: "team.update",
    targetType: "team",
    targetId: teamId,
    detail: row.name.slice(0, 80),
  });
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId, teamId },
    "read",
  );
  return c.json({ team: publicTeam(row, access) });
});

apiRoutes.delete(`${TEAM_PATH}/:teamId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const teamId = c.req.param("teamId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await loadTeam(c.env, workspaceId, teamId);
  await guard(c.env, principal, { tenantId, workspaceId, teamId }, "admin");
  await deleteTeam(c.env, teamId);
  await recordAudit(c.env, {
    tenantId,
    workspaceId,
    accountId: principal.accountId,
    action: "team.delete",
    targetType: "team",
    targetId: teamId,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Projects                                                             */
/* ------------------------------------------------------------------ */

const PROJECT_PATH = `${TEAM_PATH}/:teamId/projects`;

apiRoutes.post(PROJECT_PATH, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const teamId = c.req.param("teamId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await loadTeam(c.env, workspaceId, teamId);
  await guard(c.env, principal, { tenantId, workspaceId, teamId }, "write");
  const input = parseProjectInput(body, false);
  const row = await createProject(c.env, principal, tenantId, workspaceId, teamId, {
    name: input.name as string,
    color: input.color ?? null,
    startsOn: input.startsOn ?? null,
    dueOn: input.dueOn ?? null,
  });
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId, teamId, projectId: row.id },
    "read",
  );
  return c.json({ project: publicProject(row, access) }, 201);
});

apiRoutes.get(PROJECT_PATH, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const teamId = c.req.param("teamId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await loadTeam(c.env, workspaceId, teamId);
  await guard(c.env, principal, { tenantId, workspaceId, teamId }, "read");
  const projects = await listProjects(
    c.env,
    principal,
    tenantId,
    workspaceId,
    teamId,
  );
  return c.json({
    projects: projects.map((p) => publicProject(p.row, p.access)),
  });
});

apiRoutes.get(`${PROJECT_PATH}/:projectId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const teamId = c.req.param("teamId");
  const projectId = c.req.param("projectId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await loadTeam(c.env, workspaceId, teamId);
  const row = await loadProject(c.env, teamId, projectId);
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId, teamId, projectId },
    "read",
  );
  return c.json({ project: publicProject(row, access) });
});

apiRoutes.patch(`${PROJECT_PATH}/:projectId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const teamId = c.req.param("teamId");
  const projectId = c.req.param("projectId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await loadTeam(c.env, workspaceId, teamId);
  await loadProject(c.env, teamId, projectId);
  await guard(
    c.env,
    principal,
    { tenantId, workspaceId, teamId, projectId },
    "write",
  );
  const row = await updateProject(
    c.env,
    teamId,
    projectId,
    parseProjectInput(body, true),
  );
  await recordAudit(c.env, {
    tenantId,
    workspaceId,
    accountId: principal.accountId,
    action: "project.update",
    targetType: "project",
    targetId: projectId,
    detail: row.name.slice(0, 80),
  });
  const { access } = await guard(
    c.env,
    principal,
    { tenantId, workspaceId, teamId, projectId },
    "read",
  );
  return c.json({ project: publicProject(row, access) });
});

apiRoutes.delete(`${PROJECT_PATH}/:projectId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const workspaceId = c.req.param("workspaceId");
  const teamId = c.req.param("teamId");
  const projectId = c.req.param("projectId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await loadWorkspace(c.env, tenantId, workspaceId);
  await loadTeam(c.env, workspaceId, teamId);
  await loadProject(c.env, teamId, projectId);
  await guard(
    c.env,
    principal,
    { tenantId, workspaceId, teamId, projectId },
    "admin",
  );
  await deleteProject(c.env, projectId);
  await recordAudit(c.env, {
    tenantId,
    workspaceId,
    accountId: principal.accountId,
    action: "project.delete",
    targetType: "project",
    targetId: projectId,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* API keys                                                             */
/* ------------------------------------------------------------------ */

const KEYS_PATH = "/api/v1/tenants/:tenantId/api-keys";

apiRoutes.post(KEYS_PATH, async (c) => {
  const tenantId = c.req.param("tenantId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const name = cleanName(body["name"]);
  const scopes = normalizeScopes(body["scopes"] ?? ["read", "write"]);
  const ipAllowlist = normalizeIpAllowlist(body["ip_allowlist"]);
  const issued = await issueApiKey(
    c.env,
    tenantId,
    principal.accountId,
    name,
    scopes,
    ipAllowlist,
  );
  // The plaintext key is returned exactly once, at issuance.
  return c.json({ api_key: issued.apiKey, key: issued.key }, 201);
});

apiRoutes.patch(`${KEYS_PATH}/:keyId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const keyId = c.req.param("keyId");
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "write");
  const tenantAdmin = chain.tenant === "owner" || chain.tenant === "admin";
  const key = await updateApiKeyIpAllowlist(
    c.env,
    tenantId,
    keyId,
    principal.accountId,
    tenantAdmin,
    normalizeIpAllowlist(body["ip_allowlist"]),
  );
  return c.json({ key });
});

apiRoutes.get(KEYS_PATH, async (c) => {
  const tenantId = c.req.param("tenantId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  const tenantAdmin = chain.tenant === "owner" || chain.tenant === "admin";
  const keys = await listApiKeys(
    c.env,
    tenantId,
    tenantAdmin ? null : principal.accountId,
  );
  return c.json({ keys: keys.map(publicKey) });
});

apiRoutes.delete(`${KEYS_PATH}/:keyId`, async (c) => {
  const tenantId = c.req.param("tenantId");
  const keyId = c.req.param("keyId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "write");
  const tenantAdmin = chain.tenant === "owner" || chain.tenant === "admin";
  await revokeApiKey(
    c.env,
    tenantId,
    keyId,
    principal.accountId,
    tenantAdmin,
  );
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Members (phase 6: read-only directory for pickers and name lookup)   */
/* ------------------------------------------------------------------ */

apiRoutes.get("/api/v1/tenants/:tenantId/members", async (c) => {
  const tenantId = c.req.param("tenantId");
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  // Two-step lookup (no JOIN) so the test double and D1 agree.
  const { results: memberships } = await c.env.DB.prepare(
    "SELECT account_id, role FROM tenant_members WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<{ account_id: string; role: string }>();
  const members: Array<{
    account_id: string;
    display_name: string | null;
    email: string | null;
    role: string;
  }> = [];
  for (const m of memberships ?? []) {
    const account = await c.env.DB.prepare(
      "SELECT display_name, email FROM accounts WHERE id = ?1",
    )
      .bind(m.account_id)
      .first<{ display_name: string | null; email: string | null }>();
    members.push({
      account_id: m.account_id,
      display_name: account?.display_name ?? null,
      email: account?.email ?? null,
      role: m.role,
    });
  }
  members.sort((a, b) => {
    if (a.display_name && b.display_name) {
      return a.display_name.localeCompare(b.display_name);
    }
    if (a.display_name) return -1;
    if (b.display_name) return 1;
    return a.account_id.localeCompare(b.account_id);
  });
  return c.json({ members });
});

