/**
 * Hierarchy CRUD services (tenant -> workspace -> team -> project).
 *
 * Every read/write goes through `guard`, which loads the resource, checks
 * the ancestry chain matches, resolves the caller's role chain, and
 * enforces the required access. Resources the caller cannot read answer
 * 404 so their existence is not leaked; insufficient privilege on a
 * readable resource answers 403. Deletes are soft (deleted_at).
 */
import { nowIso } from "./accounts";
import { recordAudit } from "./audit";
import { badRequest, forbidden, notFound } from "./errors";
import {
  accessForRef,
  loadRoleChain,
  type Access,
  type ResourceRef,
  type RoleChain,
} from "./permissions";
import { randomId } from "./tokens";
import type {
  Env,
  Principal,
  ProjectRow,
  TeamRow,
  TenantRow,
  WorkspaceRow,
} from "./types";

export function cleanName(input: unknown, field = "name"): string {
  if (typeof input !== "string") throw badRequest(`"${field}" is required`);
  const name = input.trim();
  if (name.length < 1 || name.length > 120) {
    throw badRequest(`"${field}" must be 1-120 characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw badRequest(`"${field}" must not contain control characters`);
  }
  return name;
}

function optionalDate(input: unknown, field: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw badRequest(`"${field}" must be a YYYY-MM-DD date`);
  }
  return input;
}

function optionalColor(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !/^#[0-9a-fA-F]{6}$/.test(input)) {
    throw badRequest('"color" must be a #RRGGBB hex color');
  }
  return input;
}

/* ------------------------------------------------------------------ */
/* Loaders (soft-delete aware)                                          */
/* ------------------------------------------------------------------ */

export async function loadTenant(
  env: Env,
  tenantId: string,
): Promise<TenantRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM tenants WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .first<TenantRow>();
  if (!row) throw notFound("Tenant not found");
  return row;
}

export async function loadWorkspace(
  env: Env,
  tenantId: string,
  workspaceId: string,
): Promise<WorkspaceRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM workspaces WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(workspaceId, tenantId)
    .first<WorkspaceRow>();
  if (!row) throw notFound("Workspace not found");
  return row;
}

export async function loadTeam(
  env: Env,
  workspaceId: string,
  teamId: string,
): Promise<TeamRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM teams WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL",
  )
    .bind(teamId, workspaceId)
    .first<TeamRow>();
  if (!row) throw notFound("Team not found");
  return row;
}

export async function loadProject(
  env: Env,
  teamId: string,
  projectId: string,
): Promise<ProjectRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND team_id = ?2 AND deleted_at IS NULL",
  )
    .bind(projectId, teamId)
    .first<ProjectRow>();
  if (!row) throw notFound("Project not found");
  return row;
}

/* ------------------------------------------------------------------ */
/* Guard                                                                */
/* ------------------------------------------------------------------ */

export interface Guarded {
  chain: RoleChain;
  access: Access;
}

/**
 * Authorize `need` on the resource named by ref. Ancestor rows must be
 * loaded by the caller first (loaders above) so ancestry is verified.
 */
export async function guard(
  env: Env,
  principal: Principal,
  ref: ResourceRef,
  need: "read" | "write" | "admin",
): Promise<Guarded> {
  const chain = await loadRoleChain(env, principal.accountId, ref);
  const access = accessForRef(chain, ref);
  if (!access.read) throw notFound("Not found");
  if (need === "write" && !access.write) {
    throw forbidden("Write access is required");
  }
  if (need === "admin" && !access.admin) {
    throw forbidden("Admin access is required");
  }
  return { chain, access };
}

/* ------------------------------------------------------------------ */
/* Serializers (internal ids only; never the OIDC sub)                  */
/* ------------------------------------------------------------------ */

export function publicTenant(row: TenantRow, access?: Access) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(access ? { access } : {}),
  };
}

export function publicWorkspace(row: WorkspaceRow, access?: Access) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(access ? { access } : {}),
  };
}

export function publicTeam(row: TeamRow, access?: Access) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    name: row.name,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(access ? { access } : {}),
  };
}

export function publicProject(row: ProjectRow, access?: Access) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    team_id: row.team_id,
    name: row.name,
    color: row.color,
    starts_on: row.starts_on,
    due_on: row.due_on,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(access ? { access } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Tenants                                                              */
/* ------------------------------------------------------------------ */

export async function createTenant(
  env: Env,
  principal: Principal,
  name: string,
): Promise<TenantRow> {
  const now = nowIso();
  const row: TenantRow = {
    id: randomId(),
    name,
    kind: "team",
    created_by_account_id: principal.accountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO tenants (id, name, kind, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, 'team', ?3, ?4, ?5)",
    ).bind(row.id, row.name, row.created_by_account_id, now, now),
    env.DB.prepare(
      "INSERT INTO tenant_members (tenant_id, account_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)",
    ).bind(row.id, principal.accountId, now),
  ]);
  await recordAudit(env, {
    tenantId: row.id,
    accountId: principal.accountId,
    action: "tenant.create",
    targetType: "tenant",
    targetId: row.id,
    detail: name.slice(0, 80),
  });
  return row;
}

export async function listTenants(
  env: Env,
  principal: Principal,
): Promise<{ row: TenantRow; access: Access }[]> {
  const memberships = await env.DB.prepare(
    "SELECT tenant_id FROM tenant_members WHERE account_id = ?1",
  )
    .bind(principal.accountId)
    .all<{ tenant_id: string }>();
  const out: { row: TenantRow; access: Access }[] = [];
  for (const m of memberships.results) {
    const row = await env.DB.prepare(
      "SELECT * FROM tenants WHERE id = ?1 AND deleted_at IS NULL",
    )
      .bind(m.tenant_id)
      .first<TenantRow>();
    if (!row) continue;
    const chain = await loadRoleChain(env, principal.accountId, {
      tenantId: row.id,
    });
    out.push({ row, access: accessForRef(chain, { tenantId: row.id }) });
  }
  out.sort((a, b) => a.row.created_at.localeCompare(b.row.created_at));
  return out;
}

export async function updateTenant(
  env: Env,
  tenantId: string,
  name: string,
): Promise<TenantRow> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE tenants SET name = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
  )
    .bind(name, now, tenantId)
    .run();
  return loadTenant(env, tenantId);
}

export async function deleteTenant(env: Env, tenantId: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE tenants SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
  )
    .bind(now, now, tenantId)
    .run();
}

/* ------------------------------------------------------------------ */
/* Workspaces                                                           */
/* ------------------------------------------------------------------ */

export async function createWorkspace(
  env: Env,
  principal: Principal,
  tenantId: string,
  name: string,
): Promise<WorkspaceRow> {
  const now = nowIso();
  const row: WorkspaceRow = {
    id: randomId(),
    tenant_id: tenantId,
    name,
    created_by_account_id: principal.accountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces (id, tenant_id, name, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(row.id, tenantId, name, principal.accountId, now, now),
    env.DB.prepare(
      "INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES (?1, ?2, 'admin', ?3)",
    ).bind(row.id, principal.accountId, now),
  ]);
  await recordAudit(env, {
    tenantId,
    workspaceId: row.id,
    accountId: principal.accountId,
    action: "workspace.create",
    targetType: "workspace",
    targetId: row.id,
    detail: name.slice(0, 80),
  });
  return row;
}

export async function listWorkspaces(
  env: Env,
  principal: Principal,
  tenantId: string,
): Promise<{ row: WorkspaceRow; access: Access }[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM workspaces WHERE tenant_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC",
  )
    .bind(tenantId)
    .all<WorkspaceRow>();
  const out: { row: WorkspaceRow; access: Access }[] = [];
  for (const row of res.results) {
    const chain = await loadRoleChain(env, principal.accountId, {
      tenantId,
      workspaceId: row.id,
    });
    const access = accessForRef(chain, { tenantId, workspaceId: row.id });
    if (access.read) out.push({ row, access });
  }
  return out;
}

export async function updateWorkspace(
  env: Env,
  tenantId: string,
  workspaceId: string,
  name: string,
): Promise<WorkspaceRow> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
  )
    .bind(name, now, workspaceId)
    .run();
  return loadWorkspace(env, tenantId, workspaceId);
}

export async function deleteWorkspace(
  env: Env,
  workspaceId: string,
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE workspaces SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
  )
    .bind(now, now, workspaceId)
    .run();
}

/* ------------------------------------------------------------------ */
/* Teams                                                                */
/* ------------------------------------------------------------------ */

export async function createTeam(
  env: Env,
  principal: Principal,
  tenantId: string,
  workspaceId: string,
  name: string,
): Promise<TeamRow> {
  const now = nowIso();
  const row: TeamRow = {
    id: randomId(),
    tenant_id: tenantId,
    workspace_id: workspaceId,
    name,
    created_by_account_id: principal.accountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, tenant_id, workspace_id, name, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(row.id, tenantId, workspaceId, name, principal.accountId, now, now),
    env.DB.prepare(
      "INSERT INTO team_members (team_id, account_id, role, created_at) VALUES (?1, ?2, 'lead', ?3)",
    ).bind(row.id, principal.accountId, now),
  ]);
  await recordAudit(env, {
    tenantId,
    workspaceId,
    accountId: principal.accountId,
    action: "team.create",
    targetType: "team",
    targetId: row.id,
    detail: name.slice(0, 80),
  });
  return row;
}

export async function listTeams(
  env: Env,
  principal: Principal,
  tenantId: string,
  workspaceId: string,
): Promise<{ row: TeamRow; access: Access }[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM teams WHERE workspace_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC",
  )
    .bind(workspaceId)
    .all<TeamRow>();
  const out: { row: TeamRow; access: Access }[] = [];
  for (const row of res.results) {
    const chain = await loadRoleChain(env, principal.accountId, {
      tenantId,
      workspaceId,
      teamId: row.id,
    });
    const access = accessForRef(chain, { tenantId, workspaceId, teamId: row.id });
    if (access.read) out.push({ row, access });
  }
  return out;
}

export async function updateTeam(
  env: Env,
  workspaceId: string,
  teamId: string,
  name: string,
): Promise<TeamRow> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE teams SET name = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
  )
    .bind(name, now, teamId)
    .run();
  return loadTeam(env, workspaceId, teamId);
}

export async function deleteTeam(env: Env, teamId: string): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE teams SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
  )
    .bind(now, now, teamId)
    .run();
}

/* ------------------------------------------------------------------ */
/* Projects                                                             */
/* ------------------------------------------------------------------ */

export interface ProjectInput {
  name: string;
  color: string | null;
  startsOn: string | null;
  dueOn: string | null;
}

export function parseProjectInput(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<ProjectInput> {
  const out: Partial<ProjectInput> = {};
  if (!partial || body["name"] !== undefined) {
    out.name = cleanName(body["name"]);
  }
  if (body["color"] !== undefined) out.color = optionalColor(body["color"]);
  if (body["starts_on"] !== undefined) {
    out.startsOn = optionalDate(body["starts_on"], "starts_on");
  }
  if (body["due_on"] !== undefined) {
    out.dueOn = optionalDate(body["due_on"], "due_on");
  }
  return out;
}

export async function createProject(
  env: Env,
  principal: Principal,
  tenantId: string,
  workspaceId: string,
  teamId: string,
  input: ProjectInput,
): Promise<ProjectRow> {
  const now = nowIso();
  const row: ProjectRow = {
    id: randomId(),
    tenant_id: tenantId,
    workspace_id: workspaceId,
    team_id: teamId,
    name: input.name,
    description_enc: null,
    color: input.color,
    starts_on: input.startsOn,
    due_on: input.dueOn,
    created_by_account_id: principal.accountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, tenant_id, workspace_id, team_id, name, color, starts_on, due_on, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    ).bind(
      row.id,
      tenantId,
      workspaceId,
      teamId,
      row.name,
      row.color,
      row.starts_on,
      row.due_on,
      principal.accountId,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO project_members (project_id, account_id, role, created_at) VALUES (?1, ?2, 'admin', ?3)",
    ).bind(row.id, principal.accountId, now),
  ]);
  await recordAudit(env, {
    tenantId,
    workspaceId,
    accountId: principal.accountId,
    action: "project.create",
    targetType: "project",
    targetId: row.id,
    detail: input.name.slice(0, 80),
  });
  return row;
}

export async function listProjects(
  env: Env,
  principal: Principal,
  tenantId: string,
  workspaceId: string,
  teamId: string,
): Promise<{ row: ProjectRow; access: Access }[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM projects WHERE team_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC",
  )
    .bind(teamId)
    .all<ProjectRow>();
  const out: { row: ProjectRow; access: Access }[] = [];
  for (const row of res.results) {
    const chain = await loadRoleChain(env, principal.accountId, {
      tenantId,
      workspaceId,
      teamId,
      projectId: row.id,
    });
    const access = accessForRef(chain, {
      tenantId,
      workspaceId,
      teamId,
      projectId: row.id,
    });
    if (access.read) out.push({ row, access });
  }
  return out;
}

export async function updateProject(
  env: Env,
  teamId: string,
  projectId: string,
  patch: Partial<ProjectInput>,
): Promise<ProjectRow> {
  const current = await loadProject(env, teamId, projectId);
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE projects SET name = ?1, color = ?2, starts_on = ?3, due_on = ?4, updated_at = ?5 WHERE id = ?6 AND deleted_at IS NULL",
  )
    .bind(
      patch.name ?? current.name,
      patch.color !== undefined ? patch.color : current.color,
      patch.startsOn !== undefined ? patch.startsOn : current.starts_on,
      patch.dueOn !== undefined ? patch.dueOn : current.due_on,
      now,
      projectId,
    )
    .run();
  return loadProject(env, teamId, projectId);
}

export async function deleteProject(
  env: Env,
  projectId: string,
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE projects SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
  )
    .bind(now, now, projectId)
    .run();
}
