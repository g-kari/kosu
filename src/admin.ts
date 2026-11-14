/**
 * Operator (service admin) support (phase 5 item 19).
 *
 * Operators are named by internal account id in the OPERATOR_ACCOUNT_IDS
 * environment variable (comma-separated). Operator endpoints are
 * session-only and never expose sub or credentials: the overview shows
 * tenants, usage and integration connection states (provider +
 * enabled flag only).
 */

import type { Env } from "./types";
import { getTenantUsage } from "./usage";

export function operatorAccountIds(env: Env): string[] {
  const raw = env.OPERATOR_ACCOUNT_IDS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function isOperator(env: Env, accountId: string): boolean {
  return operatorAccountIds(env).includes(accountId);
}

export interface TenantOverview {
  tenant_id: string;
  name: string;
  kind: string;
  created_at: string;
  usage: { members: number; tasks: number; attachment_bytes: number };
  integrations: { provider: string; enabled: boolean }[];
}

export async function adminOverview(env: Env): Promise<{
  tenants: TenantOverview[];
  totals: { tenants: number; accounts: number };
}> {
  const { results: tenantRows } = await env.DB.prepare(
    "SELECT id, name, kind, created_at FROM tenants WHERE deleted_at IS NULL",
  ).all<{ id: string; name: string; kind: string; created_at: string }>();
  const { results: accountRows } = await env.DB.prepare(
    "SELECT id FROM accounts",
  ).all<{ id: string }>();
  const tenants: TenantOverview[] = [];
  for (const t of tenantRows ?? []) {
    const usage = await getTenantUsage(env, t.id);
    const { results: connections } = await env.DB.prepare(
      "SELECT provider, enabled FROM integration_connections WHERE tenant_id = ?1",
    )
      .bind(t.id)
      .all<{ provider: string; enabled: number }>();
    tenants.push({
      tenant_id: t.id,
      name: t.name,
      kind: t.kind,
      created_at: t.created_at,
      usage,
      integrations: (connections ?? []).map((conn) => ({
        provider: conn.provider,
        enabled: Number(conn.enabled) === 1,
      })),
    });
  }
  return {
    tenants,
    totals: {
      tenants: tenants.length,
      accounts: (accountRows ?? []).length,
    },
  };
}
