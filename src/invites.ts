/**
 * Member invites (phase 2).
 *
 * There is no mail infrastructure, so inviting means issuing a token
 * link; the inviter shares the URL out of band. Only the token's SHA-256
 * hash is stored and the plaintext URL is returned exactly once, at
 * creation. The invitee opens the link while logged in and accepts,
 * which inserts the membership row at the invited level and role.
 */
import { nowIso } from "./accounts";
import { recordAudit } from "./audit";
import { badRequest, conflict, notFound } from "./errors";
import {
  guard,
  loadProject,
  loadTeam,
  loadTenant,
  loadWorkspace,
} from "./hierarchy";
import { randomId, randomToken, sha256Hex } from "./tokens";
import { tenantMemberIds } from "./members";
import { assertWithinLimits } from "./usage";
import type { Env, InviteRow, Principal } from "./types";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteLevel = "tenant" | "workspace" | "team" | "project";

const ROLES_BY_LEVEL: Record<InviteLevel, string[]> = {
  tenant: ["admin", "member"],
  workspace: ["admin", "member"],
  team: ["lead", "member"],
  project: ["admin", "editor", "viewer"],
};

export function publicInvite(row: InviteRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    level: row.level,
    workspace_id: row.workspace_id,
    team_id: row.team_id,
    project_id: row.project_id,
    email: row.email,
    role: row.role,
    created_by: row.created_by_account_id,
    expires_at: row.expires_at,
    accepted_by: row.accepted_by_account_id,
    accepted_at: row.accepted_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    status: row.revoked_at
      ? "revoked"
      : row.accepted_at
        ? "accepted"
        : row.expires_at <= nowIso()
          ? "expired"
          : "pending",
  };
}

export interface InviteInput {
  level: InviteLevel;
  workspaceId: string | null;
  teamId: string | null;
  projectId: string | null;
  email: string;
  role: string;
}

export function parseInviteInput(
  body: Record<string, unknown>,
): InviteInput {
  const level = body["level"];
  if (
    level !== "tenant" &&
    level !== "workspace" &&
    level !== "team" &&
    level !== "project"
  ) {
    throw badRequest('"level" must be tenant, workspace, team or project');
  }
  const email = body["email"];
  if (
    typeof email !== "string" ||
    email.length < 3 ||
    email.length > 200 ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  ) {
    throw badRequest('"email" must be an email address');
  }
  const role = body["role"];
  if (typeof role !== "string" || !ROLES_BY_LEVEL[level].includes(role)) {
    throw badRequest(
      `"role" for a ${level} invite must be one of: ${ROLES_BY_LEVEL[level].join(", ")}`,
    );
  }
  const idOf = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 200) {
      throw badRequest(`"${field}" must be an id string`);
    }
    return value;
  };
  const workspaceId = idOf(body["workspace_id"], "workspace_id");
  const teamId = idOf(body["team_id"], "team_id");
  const projectId = idOf(body["project_id"], "project_id");
  if (level === "workspace" && !workspaceId) {
    throw badRequest('A workspace invite requires "workspace_id"');
  }
  if (level === "team" && (!workspaceId || !teamId)) {
    throw badRequest('A team invite requires "workspace_id" and "team_id"');
  }
  if (level === "project" && (!workspaceId || !teamId || !projectId)) {
    throw badRequest(
      'A project invite requires "workspace_id", "team_id" and "project_id"',
    );
  }
  return {
    level,
    workspaceId,
    teamId,
    projectId,
    email: email.trim().toLowerCase(),
    role,
  };
}

/**
 * Check the inviter's admin rights on the invite target and that the
 * ancestry chain named by the input actually exists.
 */
async function assertInviteTarget(
  env: Env,
  principal: Principal,
  tenantId: string,
  input: InviteInput,
): Promise<void> {
  await loadTenant(env, tenantId);
  const ref: {
    tenantId: string;
    workspaceId?: string;
    teamId?: string;
    projectId?: string;
  } = { tenantId };
  if (input.level !== "tenant") {
    await loadWorkspace(env, tenantId, input.workspaceId as string);
    ref.workspaceId = input.workspaceId as string;
  }
  if (input.level === "team" || input.level === "project") {
    await loadTeam(env, input.workspaceId as string, input.teamId as string);
    ref.teamId = input.teamId as string;
  }
  if (input.level === "project") {
    await loadProject(env, input.teamId as string, input.projectId as string);
    ref.projectId = input.projectId as string;
  }
  await guard(env, principal, ref, "admin");
}

export async function createInvite(
  env: Env,
  principal: Principal,
  tenantId: string,
  input: InviteInput,
): Promise<{ invite: InviteRow; token: string; acceptUrl: string }> {
  await assertInviteTarget(env, principal, tenantId, input);
  const token = randomToken("inv");
  const now = nowIso();
  const row: InviteRow = {
    id: randomId(),
    tenant_id: tenantId,
    level: input.level,
    workspace_id: input.workspaceId,
    team_id: input.teamId,
    project_id: input.projectId,
    email: input.email,
    role: input.role,
    token_hash: await sha256Hex(token),
    created_by_account_id: principal.accountId,
    expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    accepted_by_account_id: null,
    accepted_at: null,
    revoked_at: null,
    created_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO invites (id, tenant_id, level, workspace_id, team_id, project_id, email, role, token_hash, created_by_account_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
  )
    .bind(
      row.id, tenantId, input.level, input.workspaceId, input.teamId,
      input.projectId, input.email, input.role, row.token_hash,
      principal.accountId, row.expires_at, now,
    )
    .run();
  await recordAudit(env, {
    tenantId,
    workspaceId: input.workspaceId,
    accountId: principal.accountId,
    action: "invite.create",
    targetType: "invite",
    targetId: row.id,
    detail: `${input.level}:${input.role}`,
  });
  return {
    invite: row,
    token,
    acceptUrl: `${env.APP_ORIGIN}/invite/${token}`,
  };
}

export async function listInvites(
  env: Env,
  tenantId: string,
): Promise<InviteRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM invites WHERE tenant_id = ?1 ORDER BY created_at ASC",
  )
    .bind(tenantId)
    .all<InviteRow>();
  return res.results;
}

export async function revokeInvite(
  env: Env,
  principal: Principal,
  tenantId: string,
  inviteId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM invites WHERE id = ?1 AND tenant_id = ?2",
  )
    .bind(inviteId, tenantId)
    .first<InviteRow>();
  if (!row) throw notFound("Invite not found");
  await assertInviteTarget(env, principal, tenantId, {
    level: row.level as InviteLevel,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    projectId: row.project_id,
    email: row.email,
    role: row.role,
  });
  if (row.revoked_at || row.accepted_at) return;
  await env.DB.prepare(
    "UPDATE invites SET revoked_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), inviteId)
    .run();
}

const MEMBER_TABLES = {
  tenant: {
    table: "tenant_members",
    idColumn: "tenant_id",
  },
  workspace: {
    table: "workspace_members",
    idColumn: "workspace_id",
  },
  team: { table: "team_members", idColumn: "team_id" },
  project: { table: "project_members", idColumn: "project_id" },
} as const;

/**
 * Accept an invite for the logged-in account. Membership is inserted at
 * the invited role; an existing membership keeps its current role (an
 * invite never downgrades anyone).
 */
export async function acceptInvite(
  env: Env,
  principal: Principal,
  token: string,
): Promise<InviteRow> {
  const hash = await sha256Hex(token.trim());
  const row = await env.DB.prepare(
    "SELECT * FROM invites WHERE token_hash = ?1",
  )
    .bind(hash)
    .first<InviteRow>();
  if (!row) throw notFound("Invite not found");
  if (row.revoked_at) throw conflict("INVITE_REVOKED", "This invite was revoked");
  if (row.accepted_at) {
    throw conflict("INVITE_ACCEPTED", "This invite was already accepted");
  }
  if (row.expires_at <= nowIso()) {
    throw conflict("INVITE_EXPIRED", "This invite has expired");
  }
  const targetId =
    row.level === "tenant"
      ? row.tenant_id
      : row.level === "workspace"
        ? (row.workspace_id as string)
        : row.level === "team"
          ? (row.team_id as string)
          : (row.project_id as string);
  const spec = MEMBER_TABLES[row.level as InviteLevel];
  const existing = await env.DB.prepare(
    `SELECT account_id FROM ${spec.table} WHERE ${spec.idColumn} = ?1 AND account_id = ?2`,
  )
    .bind(targetId, principal.accountId)
    .first<{ account_id: string }>();
  if (!existing) {
    // Phase 5 tenant member limit: only a genuinely new member of the
    // tenant counts against it.
    const memberIds = await tenantMemberIds(env, row.tenant_id);
    if (!memberIds.includes(principal.accountId)) {
      await assertWithinLimits(env, row.tenant_id, "member");
    }
  }
  const now = nowIso();
  const statements = [];
  if (!existing) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO ${spec.table} (${spec.idColumn}, account_id, role, created_at) VALUES (?1, ?2, ?3, ?4)`,
      ).bind(targetId, principal.accountId, row.role, now),
    );
  }
  statements.push(
    env.DB.prepare(
      "UPDATE invites SET accepted_by_account_id = ?1, accepted_at = ?2 WHERE id = ?3",
    ).bind(principal.accountId, now, row.id),
  );
  await env.DB.batch(statements);
  await recordAudit(env, {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    accountId: principal.accountId,
    action: "invite.accept",
    targetType: "invite",
    targetId: row.id,
    detail: `${row.level}:${row.role}`,
  });
  return { ...row, accepted_by_account_id: principal.accountId, accepted_at: now };
}
