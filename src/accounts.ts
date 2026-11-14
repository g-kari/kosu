/**
 * Account resolution and first-login provisioning.
 *
 * The OIDC `sub` is stored only in accounts.oidc_sub. Everything outside
 * this module works with the internal account id; screens, APIs and the
 * audit log never see the sub (same rule as Hyo PR #25).
 */
import { randomId } from "./tokens";
import type { AccountRow, Env } from "./types";

export function nowIso(): string {
  return new Date().toISOString();
}

export async function accountById(
  env: Env,
  accountId: string,
): Promise<AccountRow | null> {
  return env.DB.prepare("SELECT * FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first<AccountRow>();
}

export async function accountBySub(
  env: Env,
  sub: string,
): Promise<AccountRow | null> {
  return env.DB.prepare("SELECT * FROM accounts WHERE oidc_sub = ?1")
    .bind(sub)
    .first<AccountRow>();
}

function cleanClaim(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export function profileFromClaims(claims: Record<string, unknown>): {
  name: string | null;
  email: string | null;
} {
  return {
    name: cleanClaim(claims["name"], 120),
    email: cleanClaim(claims["email"], 200),
  };
}

/**
 * Find the account for a verified sub, creating it on first login.
 * Profile fields are refreshed when the IdP sends newer values.
 */
export async function resolveAccount(
  env: Env,
  sub: string,
  profile: { name: string | null; email: string | null },
): Promise<AccountRow> {
  const existing = await accountBySub(env, sub);
  if (existing) {
    if (
      (profile.email && profile.email !== existing.email) ||
      (profile.name && profile.name !== existing.display_name)
    ) {
      await env.DB.prepare(
        "UPDATE accounts SET email = ?1, display_name = ?2, updated_at = ?3 WHERE id = ?4",
      )
        .bind(
          profile.email ?? existing.email,
          profile.name ?? existing.display_name,
          nowIso(),
          existing.id,
        )
        .run();
      return {
        ...existing,
        email: profile.email ?? existing.email,
        display_name: profile.name ?? existing.display_name,
      };
    }
    return existing;
  }
  const now = nowIso();
  const row: AccountRow = {
    id: randomId(),
    oidc_sub: sub,
    display_name: profile.name,
    email: profile.email,
    created_at: now,
    updated_at: now,
  };
  try {
    await env.DB.prepare(
      "INSERT INTO accounts (id, oidc_sub, display_name, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(row.id, row.oidc_sub, row.display_name, row.email, now, now)
      .run();
    return row;
  } catch {
    // Concurrent first logins race on the UNIQUE oidc_sub; the loser reads
    // the winner's row instead of failing the login.
    const winner = await accountBySub(env, sub);
    if (winner) return winner;
    throw new Error("account creation failed");
  }
}

/**
 * Create the personal tenant for an account that belongs to no tenant yet:
 * tenant (owner) + a default workspace (admin) + a default team (lead),
 * so the first login lands in a usable hierarchy. Idempotent.
 */
export async function ensurePersonalTenant(
  env: Env,
  account: AccountRow,
): Promise<string | null> {
  const membership = await env.DB.prepare(
    "SELECT tenant_id FROM tenant_members WHERE account_id = ?1",
  )
    .bind(account.id)
    .first<{ tenant_id: string }>();
  if (membership) return membership.tenant_id;

  const now = nowIso();
  const tenantId = randomId();
  const workspaceId = randomId();
  const teamId = randomId();
  const tenantName = account.display_name
    ? `${account.display_name} のテナント`
    : "個人用テナント";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO tenants (id, name, kind, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, 'personal', ?3, ?4, ?5)",
    ).bind(tenantId, tenantName, account.id, now, now),
    env.DB.prepare(
      "INSERT INTO tenant_members (tenant_id, account_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)",
    ).bind(tenantId, account.id, now),
    env.DB.prepare(
      "INSERT INTO workspaces (id, tenant_id, name, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, 'デフォルト', ?3, ?4, ?5)",
    ).bind(workspaceId, tenantId, account.id, now, now),
    env.DB.prepare(
      "INSERT INTO workspace_members (workspace_id, account_id, role, created_at) VALUES (?1, ?2, 'admin', ?3)",
    ).bind(workspaceId, account.id, now),
    env.DB.prepare(
      "INSERT INTO teams (id, tenant_id, workspace_id, name, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'デフォルト', ?4, ?5, ?6)",
    ).bind(teamId, tenantId, workspaceId, account.id, now, now),
    env.DB.prepare(
      "INSERT INTO team_members (team_id, account_id, role, created_at) VALUES (?1, ?2, 'lead', ?3)",
    ).bind(teamId, account.id, now),
    env.DB.prepare(
      "INSERT INTO audit_log (id, tenant_id, workspace_id, account_id, action, target_type, target_id, detail, created_at) VALUES (?1, ?2, ?3, ?4, 'tenant.create', 'tenant', ?2, ?5, ?6)",
    ).bind(randomId(), tenantId, workspaceId, account.id, tenantName.slice(0, 80), now),
  ]);
  return tenantId;
}

/** Current session epoch for an account; 0 when never revoked. */
export async function getSessionEpoch(
  env: Env,
  accountId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT epoch FROM session_epochs WHERE account_id = ?1",
  )
    .bind(accountId)
    .first<{ epoch: number }>();
  return Number(row?.epoch ?? 0);
}
