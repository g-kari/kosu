/**
 * OIDC login flow (0g0-id) and session endpoints.
 *
 * GET  /auth/login    start the authorization code flow (PKCE S256)
 * GET  /auth/callback exchange the code, verify the ID token, set session
 * POST /auth/logout   clear the session cookie
 * GET  /me            the caller's public profile (internal id only)
 */
import { Hono } from "hono";
import {
  accountById,
  ensurePersonalTenant,
  profileFromClaims,
  resolveAccount,
} from "../accounts";
import { requirePrincipal } from "../auth";
import { ApiError, badRequest } from "../errors";
import { exchangeCode, getDiscovery, verifyJwt } from "../oidc";
import {
  clearFlowCookie,
  clearSessionCookie,
  makeFlowCookie,
  makeSessionCookie,
  readFlowCookie,
  safeNextPath,
  type FlowState,
} from "../session";
import { pkceChallenge, randomToken, sha256Hex, timingSafeEqual } from "../tokens";
import { recordLoginEvent, requestIp } from "../security";
import type { Env, Variables } from "../types";

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const OIDC_ERROR = /^[A-Za-z0-9_]{1,64}$/;

/** Start login: register a single-use state, set the flow cookie, redirect. */
authRoutes.get("/auth/login", async (c) => {
  if (!c.env.OIDC_CLIENT_ID) {
    return c.json(
      {
        error: {
          code: "NOT_CONFIGURED",
          message: "OIDC_CLIENT_ID is not configured yet",
        },
      },
      503,
    );
  }
  const origin = c.env.APP_ORIGIN.replace(/\/+$/, "");
  const discovery = await getDiscovery(c.env);
  const state = randomToken("st");
  const nonce = randomToken("no");
  const verifier = randomToken("cv");
  const challenge = await pkceChallenge(verifier);
  const flow: FlowState = {
    kind: "flow",
    state,
    nonce,
    verifier,
    next: safeNextPath(c.req.query("next")),
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oidc_states WHERE expires_at <= ?1").bind(now),
    c.env.DB.prepare(
      "INSERT INTO oidc_states (state_hash, expires_at) VALUES (?1, ?2)",
    ).bind(await sha256Hex(state), flow.exp),
  ]);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.env.OIDC_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    scope: c.env.OIDC_SCOPES ?? "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  c.header("Set-Cookie", await makeFlowCookie(c.env, flow, c.req.url));
  c.header("Cache-Control", "no-store");
  return c.redirect(
    `${discovery.authorization_endpoint}?${params.toString()}`,
    302,
  );
});

/** Callback: consume the state, exchange the code, start the session. */
authRoutes.get("/auth/callback", async (c) => {
  const origin = c.env.APP_ORIGIN.replace(/\/+$/, "");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  if (error) {
    const codeName = OIDC_ERROR.test(error) ? error : "unknown_error";
    throw badRequest(
      `Login failed at the identity provider (${codeName}). Please try again.`,
    );
  }
  if (!code || !state || code.length > 2048 || state.length > 512) {
    throw badRequest("Missing code/state in callback");
  }
  if (!c.env.OIDC_CLIENT_ID) throw badRequest("Login is not configured");
  const flow = await readFlowCookie(
    c.env,
    c.req.header("cookie") ?? null,
    c.req.url,
  );
  if (!flow || !timingSafeEqual(flow.state, state)) {
    throw badRequest("Login flow expired or state mismatch. Please try again.");
  }
  const consumed = await c.env.DB.prepare(
    "DELETE FROM oidc_states WHERE state_hash = ?1 AND expires_at > ?2",
  )
    .bind(await sha256Hex(flow.state), Math.floor(Date.now() / 1000))
    .run();
  if (Number(consumed.meta.changes ?? 0) !== 1) {
    throw badRequest("Login flow expired or state mismatch. Please try again.");
  }
  // The flow is consumed past this point; exchange/verification failures
  // are client-visible login failures (400), not server faults.
  let accountId: string;
  try {
    const { idToken } = await exchangeCode(c.env, {
      code,
      codeVerifier: flow.verifier,
      redirectUri: `${origin}/auth/callback`,
    });
    const verified = await verifyJwt(c.env, idToken, {
      audience: c.env.OIDC_CLIENT_ID,
      nonce: flow.nonce,
    });
    const account = await resolveAccount(
      c.env,
      verified.sub,
      profileFromClaims(verified.claims),
    );
    await ensurePersonalTenant(c.env, account);
    accountId = account.id;
    // Phase 5: record the login; a new device/IP raises an alert.
    // Alerting must never break sign-in, so failures are swallowed.
    try {
      await recordLoginEvent(
        c.env,
        account.id,
        requestIp(c.req.raw.headers),
        c.req.header("user-agent") ?? "",
      );
    } catch {
      // ignored: login proceeds regardless
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    c.header("Set-Cookie", clearFlowCookie(c.req.url));
    throw badRequest(
      "Sign-in could not be completed. The authorization code may have expired or already been used. Please try again.",
    );
  }
  c.header(
    "Set-Cookie",
    await makeSessionCookie(c.env, accountId, c.req.url),
  );
  c.header("Set-Cookie", clearFlowCookie(c.req.url), { append: true });
  c.header("Cache-Control", "no-store");
  return c.redirect(new URL(flow.next, origin).toString(), 302);
});

/** Logout ends only this browser's session cookie. */
authRoutes.post("/auth/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie(c.req.url));
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true });
});

/** The caller's public profile. Internal account id only — never the sub. */
authRoutes.get("/me", async (c) => {
  c.header("Cache-Control", "no-store");
  const principal = await requirePrincipal(c);
  const account = await accountById(c.env, principal.accountId);
  if (!account) {
    throw badRequest("Account no longer exists");
  }
  return c.json({
    account: {
      id: account.id,
      display_name: account.display_name,
      email: account.email,
      created_at: account.created_at,
    },
    auth: { kind: principal.kind },
  });
});

/**
 * The caller's profile plus the tenants they belong to (phase 6).
 * The Web UI (and the phase 2-5 pages before it) bootstrap their
 * tenant context from this endpoint: `default_tenant_id` is the
 * personal tenant when one exists, otherwise the first membership.
 * Internal account ids only — never the sub.
 */
authRoutes.get("/api/v1/me", async (c) => {
  const principal = await requirePrincipal(c);
  const account = await accountById(c.env, principal.accountId);
  if (!account) {
    throw badRequest("Account no longer exists");
  }
  // Two-step lookup (no JOIN) so the test double and D1 agree.
  const { results: memberships } = await c.env.DB.prepare(
    "SELECT tenant_id, role FROM tenant_members WHERE account_id = ?1",
  )
    .bind(principal.accountId)
    .all<{ tenant_id: string; role: string }>();
  const tenants: Array<{
    id: string;
    name: string;
    kind: string;
    role: string;
    created_at: string;
  }> = [];
  for (const m of memberships ?? []) {
    const tenant = await c.env.DB.prepare(
      "SELECT id, name, kind, created_at FROM tenants WHERE id = ?1 AND deleted_at IS NULL",
    )
      .bind(m.tenant_id)
      .first<{ id: string; name: string; kind: string; created_at: string }>();
    if (tenant) tenants.push({ ...tenant, role: m.role });
  }
  tenants.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const personal = tenants.find((t) => t.kind === "personal");
  const defaultTenantId = personal?.id ?? tenants[0]?.id ?? null;
  return c.json({
    account: {
      id: account.id,
      display_name: account.display_name,
      email: account.email,
      created_at: account.created_at,
      default_tenant_id: defaultTenantId,
    },
    tenants: tenants.map((x) => ({
      id: x.id,
      name: x.name,
      kind: x.kind,
      role: x.role,
    })),
    auth: { kind: principal.kind },
  });
});

