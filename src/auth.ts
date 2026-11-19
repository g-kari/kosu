/**
 * Authentication principal resolution for API routes.
 *
 * Accepts either an `Authorization: Bearer <api key>` or the session
 * cookie. A presented-but-invalid bearer token is a hard 401 (never a
 * silent downgrade to anonymous). Session-authenticated mutations must
 * carry a same-origin Origin header (CSRF guard); API-key requests are
 * exempt because they do not ride on ambient cookie authority.
 */
import {
  findActiveApiKey,
  parseScopes,
  scopeAllows,
  touchApiKey,
} from "./apikeys";
import { forbidden, notFound, unauthorized } from "./errors";
import { readSessionAccountId } from "./session";
import { ipAllowed, requestIp } from "./security";
import type { Env, Principal } from "./types";

export interface CtxLike {
  env: Env;
  req: {
    url: string;
    method: string;
    header(name: string): string | undefined;
  };
}

export function bearerToken(c: CtxLike): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : null;
}

export async function resolvePrincipal(c: CtxLike): Promise<Principal | null> {
  const token = bearerToken(c);
  if (token) {
    const found = await findActiveApiKey(c.env, token);
    if (!found) {
      throw unauthorized("INVALID_API_KEY", "API key is not valid");
    }
    // Phase 5: per-key IP allowlist. The request IP comes from the
    // platform headers (cf-connecting-ip, falling back to
    // x-forwarded-for); a mismatch is a hard 403.
    const headers = new Headers();
    for (const name of ["cf-connecting-ip", "x-forwarded-for"]) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const ip = requestIp(headers);
    if (!ipAllowed(found.key.ip_allowlist, ip)) {
      throw forbidden("API key is not allowed from this IP address");
    }
    await touchApiKey(c.env, found.key.id);
    return {
      kind: "api_key",
      accountId: found.key.account_id,
      tenantId: found.key.tenant_id,
      keyId: found.key.id,
      scopes: parseScopes(found.key.scopes),
    };
  }
  const accountId = await readSessionAccountId(
    c.env,
    c.req.header("cookie") ?? null,
    c.req.url,
  );
  if (!accountId) return null;
  return { kind: "session", accountId };
}

/** Resolve the principal or throw 401; enforces scope and CSRF rules. */
export async function requirePrincipal(c: CtxLike): Promise<Principal> {
  const principal = await resolvePrincipal(c);
  if (!principal) {
    throw unauthorized("UNAUTHORIZED", "Authentication required");
  }
  if (principal.kind === "session") {
    assertSameOriginForSessionMutation(c);
  } else if (!scopeAllows(principal.scopes, c.req.method)) {
    throw forbidden("This API key is read-only");
  }
  return principal;
}

/** API keys are bound to one tenant; using one elsewhere hides the target. */
export function assertKeyTenant(principal: Principal, tenantId: string): void {
  if (principal.kind === "api_key" && principal.tenantId !== tenantId) {
    throw notFound("Not found");
  }
}

export function assertSameOriginForSessionMutation(c: CtxLike): void {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return;
  const origin = c.req.header("origin");
  const expected = new URL(c.req.url).origin;
  if (!origin || origin !== expected) {
    throw forbidden("Cross-origin mutation rejected");
  }
}


/** Tenant-scoped API keys never authorize account-global state or membership expansion. */
export async function requireSessionPrincipal(c: CtxLike): Promise<Principal> {
  const principal = await requirePrincipal(c);
  if (principal.kind !== "session") throw forbidden("A browser session is required for account operations");
  return principal;
}
