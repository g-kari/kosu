/**
 * Signed session and OIDC flow cookies (HMAC with SESSION_SECRET).
 *
 * The session cookie carries only the internal account id — never the OIDC
 * sub. Cookie names use the `__Host-` prefix on https requests.
 */
import { accountById, getSessionEpoch } from "./accounts";
import { verifySignedValue, signValue } from "./tokens";
import type { Env } from "./types";

export const SESSION_COOKIE = "__Host-kosu_session";
export const FLOW_COOKIE = "__Host-kosu_oidc_flow";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const FLOW_TTL_SECONDS = 60 * 10; // 10 minutes

function httpsRequest(requestUrl: string): boolean {
  return new URL(requestUrl).protocol === "https:";
}

export function sessionCookieName(requestUrl: string): string {
  return httpsRequest(requestUrl) ? SESSION_COOKIE : "kosu_session";
}

export function flowCookieName(requestUrl: string): string {
  return httpsRequest(requestUrl) ? FLOW_COOKIE : "kosu_oidc_flow";
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const name = part.slice(0, eq).trim();
      if (seen.has(name)) {
        delete out[name];
        continue;
      }
      seen.add(name);
      try {
        out[name] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        /* Ignore malformed cookies. */
      }
    }
  }
  return out;
}

function cookieHeader(
  name: string,
  value: string,
  maxAge: number,
  secure: boolean,
): string {
  const secureAttr = secure ? "; Secure" : "";
  const expires =
    maxAge === 0 ? "; Expires=Thu, 01 Jan 1970 00:00:00 GMT" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${expires}${secureAttr}`;
}

export interface SessionPayload {
  kind: "session";
  accountId: string;
  epoch: number;
  exp: number;
}

export async function makeSessionCookie(
  env: Env,
  accountId: string,
  requestUrl: string,
): Promise<string> {
  const payload: SessionPayload = {
    kind: "session",
    accountId,
    epoch: await getSessionEpoch(env, accountId),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const value = await signValue(env.SESSION_SECRET, payload);
  return cookieHeader(
    sessionCookieName(requestUrl),
    value,
    SESSION_TTL_SECONDS,
    httpsRequest(requestUrl),
  );
}

export function clearSessionCookie(requestUrl: string): string {
  return cookieHeader(
    sessionCookieName(requestUrl),
    "",
    0,
    httpsRequest(requestUrl),
  );
}

interface RawSessionPayload {
  kind?: unknown;
  accountId?: unknown;
  epoch?: unknown;
  exp?: unknown;
}

/**
 * Resolve the session cookie to an internal account id, or null.
 * The account must still exist and the cookie epoch must match the
 * server-side epoch (revoke-all switch).
 */
export async function readSessionAccountId(
  env: Env,
  cookieHeaderValue: string | null,
  requestUrl: string,
): Promise<string | null> {
  const cookies = parseCookies(cookieHeaderValue);
  const raw = cookies[sessionCookieName(requestUrl)];
  if (!raw) return null;
  const payload = await verifySignedValue<RawSessionPayload>(
    env.SESSION_SECRET,
    raw,
  );
  if (!payload || payload.kind !== "session") return null;
  if (
    typeof payload.accountId !== "string" ||
    payload.accountId.length === 0
  ) {
    return null;
  }
  if (
    typeof payload.exp !== "number" ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  const account = await accountById(env, payload.accountId);
  if (!account) return null;
  const epoch = await getSessionEpoch(env, account.id);
  if ((typeof payload.epoch === "number" ? payload.epoch : -1) !== epoch) {
    return null;
  }
  return account.id;
}

export interface FlowState {
  kind: "flow";
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
}

export async function makeFlowCookie(
  env: Env,
  flow: FlowState,
  requestUrl: string,
): Promise<string> {
  const value = await signValue(env.SESSION_SECRET, flow);
  return cookieHeader(
    flowCookieName(requestUrl),
    value,
    FLOW_TTL_SECONDS,
    httpsRequest(requestUrl),
  );
}

export async function readFlowCookie(
  env: Env,
  cookieHeaderValue: string | null,
  requestUrl: string,
): Promise<FlowState | null> {
  const cookies = parseCookies(cookieHeaderValue);
  const raw = cookies[flowCookieName(requestUrl)];
  if (!raw) return null;
  const flow = await verifySignedValue<FlowState>(env.SESSION_SECRET, raw);
  if (!flow || flow.kind !== "flow") return null;
  if (
    typeof flow.state !== "string" ||
    typeof flow.nonce !== "string" ||
    typeof flow.verifier !== "string"
  ) {
    return null;
  }
  if (
    typeof flow.exp !== "number" ||
    flow.exp <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return flow;
}

export function clearFlowCookie(requestUrl: string): string {
  return cookieHeader(
    flowCookieName(requestUrl),
    "",
    0,
    httpsRequest(requestUrl),
  );
}

/** Only same-origin absolute paths are safe post-login redirect targets. */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  if (next.includes("\\")) return "/";
  return next.slice(0, 512);
}
