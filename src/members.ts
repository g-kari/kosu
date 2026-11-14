/**
 * Membership lookups across the four hierarchy levels (phase 5
 * helper). Membership lives in per-level tables
 * (tenant_members / workspace_members / team_members /
 * project_members); these helpers collect the distinct account ids a
 * feature needs without duplicating the walk everywhere.
 */

import type { Env } from "./types";

interface MemberRef {
  account_id: string;
  role: string;
}

async function collect(
  env: Env,
  sql: string,
  bind: string,
  into: Set<string>,
  roles?: Set<string>,
): Promise<void> {
  const { results } = await env.DB.prepare(sql)
    .bind(bind)
    .all<MemberRef>();
  for (const r of results ?? []) {
    if (roles && !roles.has(r.role)) continue;
    into.add(r.account_id);
  }
}

/** Distinct accounts that belong to the tenant at any level. */
export async function tenantMemberIds(
  env: Env,
  tenantId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  await collect(
    env,
    "SELECT account_id, role FROM tenant_members WHERE tenant_id = ?1",
    tenantId,
    ids,
  );
  const workspaces = await env.DB.prepare(
    "SELECT id FROM workspaces WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<{ id: string }>();
  for (const ws of workspaces.results ?? []) {
    await collect(
      env,
      "SELECT account_id, role FROM workspace_members WHERE workspace_id = ?1",
      ws.id,
      ids,
    );
  }
  const teams = await env.DB.prepare(
    "SELECT id FROM teams WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<{ id: string }>();
  for (const t of teams.results ?? []) {
    await collect(
      env,
      "SELECT account_id, role FROM team_members WHERE team_id = ?1",
      t.id,
      ids,
    );
  }
  const projects = await env.DB.prepare(
    "SELECT id FROM projects WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<{ id: string }>();
  for (const p of projects.results ?? []) {
    await collect(
      env,
      "SELECT account_id, role FROM project_members WHERE project_id = ?1",
      p.id,
      ids,
    );
  }
  return [...ids];
}

/** Tenant-level owners and admins. */
export async function tenantAdminIds(
  env: Env,
  tenantId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  await collect(
    env,
    "SELECT account_id, role FROM tenant_members WHERE tenant_id = ?1",
    tenantId,
    ids,
    new Set(["owner", "admin"]),
  );
  return [...ids];
}

/** Project-level admins (project_members role admin). */
export async function projectAdminIds(
  env: Env,
  projectId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  await collect(
    env,
    "SELECT account_id, role FROM project_members WHERE project_id = ?1",
    projectId,
    ids,
    new Set(["admin"]),
  );
  return [...ids];
}

/** Tenant owners only. */
export async function tenantOwnerIds(
  env: Env,
  tenantId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  await collect(
    env,
    "SELECT account_id, role FROM tenant_members WHERE tenant_id = ?1",
    tenantId,
    ids,
    new Set(["owner"]),
  );
  return [...ids];
}
