/**
 * Hierarchical permission checks (see docs/DESIGN.md 権限設定).
 *
 * Roles live per level: tenant (owner/admin/member), workspace
 * (admin/member), team (lead/member), project (admin/editor/viewer).
 * Management rights inherit downward: a tenant owner/admin administers
 * everything below, a workspace admin administers its teams and projects,
 * and a team lead administers its projects. An explicit membership at the
 * target level decides read/write at that level; without one, the nearest
 * ancestor membership applies. A plain tenant member has no implicit access
 * to workspaces below.
 *
 * The `accessFor*` functions are pure so the whole inheritance matrix is
 * unit-testable; `loadRoleChain` fetches the raw roles from D1.
 */
import type { Env } from "./types";

export type TenantRole = "owner" | "admin" | "member";
export type WorkspaceRole = "admin" | "member";
export type TeamRole = "lead" | "member";
export type ProjectRole = "admin" | "editor" | "viewer";

export interface RoleChain {
  tenant: TenantRole | null;
  workspace: WorkspaceRole | null;
  team: TeamRole | null;
  project: ProjectRole | null;
}

export interface Access {
  read: boolean;
  write: boolean;
  admin: boolean;
}

export const NO_ACCESS: Access = { read: false, write: false, admin: false };
const FULL: Access = { read: true, write: true, admin: true };
const READ_WRITE: Access = { read: true, write: true, admin: false };

export function isTenantAdmin(chain: RoleChain): boolean {
  return chain.tenant === "owner" || chain.tenant === "admin";
}

export function accessForTenant(chain: RoleChain): Access {
  if (!chain.tenant) return NO_ACCESS;
  return { read: true, write: true, admin: isTenantAdmin(chain) };
}

export function accessForWorkspace(chain: RoleChain): Access {
  if (chain.workspace) {
    return {
      read: true,
      write: true,
      admin: chain.workspace === "admin" || isTenantAdmin(chain),
    };
  }
  if (isTenantAdmin(chain)) return FULL;
  return NO_ACCESS;
}

export function accessForTeam(chain: RoleChain): Access {
  if (chain.team) {
    return {
      read: true,
      write: true,
      admin: chain.team === "lead" || accessForWorkspace(chain).admin,
    };
  }
  if (chain.workspace) {
    return {
      read: true,
      write: true,
      admin: accessForWorkspace(chain).admin,
    };
  }
  if (isTenantAdmin(chain)) return FULL;
  return NO_ACCESS;
}

export function accessForProject(chain: RoleChain): Access {
  const adminAbove =
    accessForTeam(chain).admin || isTenantAdmin(chain);
  if (chain.project) {
    const base: Access =
      chain.project === "admin"
        ? { ...FULL }
        : chain.project === "editor"
          ? { ...READ_WRITE }
          : { read: true, write: false, admin: false };
    if (adminAbove) return FULL;
    return base;
  }
  if (chain.team || chain.workspace) {
    return { read: true, write: true, admin: adminAbove };
  }
  if (isTenantAdmin(chain)) return FULL;
  return NO_ACCESS;
}

export interface ResourceRef {
  tenantId: string;
  workspaceId?: string;
  teamId?: string;
  projectId?: string;
}

async function roleOf(
  env: Env,
  sql: string,
  id: string,
  accountId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(sql)
    .bind(id, accountId)
    .first<{ role: string }>();
  return row?.role ?? null;
}

/** Fetch the caller's raw role at each level of the resource's ancestry. */
export async function loadRoleChain(
  env: Env,
  accountId: string,
  ref: ResourceRef,
): Promise<RoleChain> {
  const tenant = (await roleOf(
    env,
    "SELECT role FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
    ref.tenantId,
    accountId,
  )) as TenantRole | null;
  let workspace: WorkspaceRole | null = null;
  let team: TeamRole | null = null;
  let project: ProjectRole | null = null;
  if (ref.workspaceId) {
    workspace = (await roleOf(
      env,
      "SELECT role FROM workspace_members WHERE workspace_id = ?1 AND account_id = ?2",
      ref.workspaceId,
      accountId,
    )) as WorkspaceRole | null;
  }
  if (ref.teamId) {
    team = (await roleOf(
      env,
      "SELECT role FROM team_members WHERE team_id = ?1 AND account_id = ?2",
      ref.teamId,
      accountId,
    )) as TeamRole | null;
  }
  if (ref.projectId) {
    project = (await roleOf(
      env,
      "SELECT role FROM project_members WHERE project_id = ?1 AND account_id = ?2",
      ref.projectId,
      accountId,
    )) as ProjectRole | null;
  }
  return { tenant, workspace, team, project };
}

/** Effective access at the deepest level named by the ref. */
export function accessForRef(chain: RoleChain, ref: ResourceRef): Access {
  if (ref.projectId) return accessForProject(chain);
  if (ref.teamId) return accessForTeam(chain);
  if (ref.workspaceId) return accessForWorkspace(chain);
  return accessForTenant(chain);
}
