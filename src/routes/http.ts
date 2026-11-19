/** Shared helpers for the phase-2 route modules. */
import type { Context } from "hono";
import { assertKeyTenant, requirePrincipal, requireSessionPrincipal } from "../auth";
import { badRequest } from "../errors";
import type { Env, Principal, Variables } from "../types";

export type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const BODY_LIMIT = 256 * 1024;

export async function readJsonBody(
  c: Ctx,
): Promise<Record<string, unknown>> {
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

export async function auth(c: Ctx, tenantId?: string): Promise<Principal> {
  const principal = tenantId ? await requirePrincipal(c) : await requireSessionPrincipal(c);
  if (tenantId) assertKeyTenant(principal, tenantId);
  return principal;
}

/** Optional integer query parameter with a fallback. */
export function queryInt(
  c: Ctx,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`"${name}" must be an integer ${min}-${max}`);
  }
  return value;
}

