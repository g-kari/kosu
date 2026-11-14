/**
 * Per-account API keys, bound to a single tenant.
 *
 * Tokens look like `kosu_<base64url>`; only their SHA-256 hash is stored.
 * Scopes are a subset of {read, write}: a read key may only call GET
 * endpoints, a write key may also mutate. This is the authentication front
 * door for the MCP endpoint in a later phase.
 */
import { recordAudit } from "./audit";
import { badRequest, notFound } from "./errors";
import { randomId, randomToken, sha256Hex } from "./tokens";
import type { Env } from "./types";

export const API_KEY_PREFIX = "kosu";
export const ALLOWED_SCOPES = ["read", "write"] as const;
export type ApiScope = (typeof ALLOWED_SCOPES)[number];

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function parseScopes(stored: string): string[] {
  return stored.split(/\s+/).filter((s) => s.length > 0);
}

/** Validate a requested scope list; returns the canonical stored form. */
export function normalizeScopes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw badRequest('"scopes" must be a non-empty array');
  }
  const scopes: string[] = [];
  for (const s of input) {
    if (s !== "read" && s !== "write") {
      throw badRequest('"scopes" entries must be "read" or "write"');
    }
    if (!scopes.includes(s)) scopes.push(s);
  }
  return scopes;
}

/** A write scope implies read access to GET endpoints. */
export function scopeAllows(
  scopes: string[],
  method: string,
): boolean {
  if (scopes.includes("write")) return true;
  const safe = method.toUpperCase();
  return scopes.includes("read") && (safe === "GET" || safe === "HEAD");
}

export function keyPrefix(token: string): string {
  return token.slice(0, 12);
}

export function publicKey(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
  };
}

export interface FoundApiKey {
  key: ApiKeyRow;
}

/** Look up an active key by its plaintext token. Null when invalid/revoked. */
export async function findActiveApiKey(
  env: Env,
  token: string,
): Promise<FoundApiKey | null> {
  if (!token.startsWith(`${API_KEY_PREFIX}_`) || token.length > 128) {
    return null;
  }
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT * FROM api_keys WHERE key_hash = ?1",
  )
    .bind(hash)
    .first<ApiKeyRow>();
  if (!row || row.revoked_at) return null;
  return { key: row };
}

export async function touchApiKey(env: Env, keyId: string): Promise<void> {
  await env.DB.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2")
    .bind(new Date().toISOString(), keyId)
    .run();
}

export async function listApiKeys(
  env: Env,
  tenantId: string,
  accountId: string | null,
): Promise<ApiKeyRow[]> {
  const sql = accountId
    ? "SELECT * FROM api_keys WHERE tenant_id = ?1 AND account_id = ?2 ORDER BY created_at ASC"
    : "SELECT * FROM api_keys WHERE tenant_id = ?1 ORDER BY created_at ASC";
  const stmt = env.DB.prepare(sql);
  const res = accountId
    ? await stmt.bind(tenantId, accountId).all<ApiKeyRow>()
    : await stmt.bind(tenantId).all<ApiKeyRow>();
  return res.results;
}

export async function issueApiKey(
  env: Env,
  tenantId: string,
  accountId: string,
  name: string,
  scopes: string[],
): Promise<{ apiKey: string; key: ReturnType<typeof publicKey> }> {
  const apiKey = randomToken(API_KEY_PREFIX);
  const now = new Date().toISOString();
  const row: ApiKeyRow = {
    id: randomId(),
    tenant_id: tenantId,
    account_id: accountId,
    name,
    key_hash: await sha256Hex(apiKey),
    key_prefix: keyPrefix(apiKey),
    scopes: scopes.join(" "),
    created_at: now,
    revoked_at: null,
    last_used_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO api_keys (id, tenant_id, account_id, name, key_hash, key_prefix, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      row.id,
      row.tenant_id,
      row.account_id,
      row.name,
      row.key_hash,
      row.key_prefix,
      row.scopes,
      row.created_at,
    )
    .run();
  await recordAudit(env, {
    tenantId,
    accountId,
    action: "api_key.create",
    targetType: "api_key",
    targetId: row.id,
    detail: `${row.name} (${row.scopes})`,
  });
  return { apiKey, key: publicKey(row) };
}

/**
 * Revoke a key. The owner of the key always may; `canManageOthers` (tenant
 * admins) may revoke keys issued by other accounts in the tenant.
 */
export async function revokeApiKey(
  env: Env,
  tenantId: string,
  keyId: string,
  actorAccountId: string,
  canManageOthers: boolean,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM api_keys WHERE id = ?1 AND tenant_id = ?2",
  )
    .bind(keyId, tenantId)
    .first<ApiKeyRow>();
  if (!row || row.revoked_at) throw notFound("API key not found");
  if (row.account_id !== actorAccountId && !canManageOthers) {
    throw notFound("API key not found");
  }
  await env.DB.prepare("UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2")
    .bind(new Date().toISOString(), row.id)
    .run();
  await recordAudit(env, {
    tenantId,
    accountId: actorAccountId,
    action: "api_key.revoke",
    targetType: "api_key",
    targetId: row.id,
    detail: row.key_prefix,
  });
}
