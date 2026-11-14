/**
 * OIDC client for 0g0-id (authorization code flow + PKCE S256).
 *
 * Adapted from Hyo's client: discovery is pinned to the issuer origin,
 * endpoints must be https on that same origin, responses are never followed
 * through redirects, and ID tokens are verified against the issuer JWKS
 * (ES256) with iss / aud / exp / iat / nonce checks. The client is public
 * (token_endpoint_auth_method "none"), so no client secret is ever sent.
 */
import { base64UrlDecode } from "./crypto";
import { timingSafeEqual } from "./tokens";
import type { Env } from "./types";

const OIDC_BODY_LIMIT = 64 * 1024;
const JWT_MAX_LENGTH = 8192;
const CLOCK_SKEW_SECONDS = 60;

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: { issuer: string; doc: OidcDiscovery } | null = null;

/** Issuer and every OIDC URL must be https and on the same origin. */
export function assertPinnedOidcUrl(issuer: string, endpoint: string): void {
  const issuerUrl = new URL(issuer);
  const endpointUrl = new URL(endpoint);
  if (issuerUrl.protocol !== "https:" || endpointUrl.protocol !== "https:") {
    throw new Error("OIDC URLs must use https");
  }
  if (
    issuerUrl.username ||
    issuerUrl.password ||
    endpointUrl.username ||
    endpointUrl.password
  ) {
    throw new Error("OIDC URLs must not include credentials");
  }
  if (issuerUrl.pathname !== "/" && issuerUrl.pathname !== "") {
    throw new Error("OIDC issuer must not include a path");
  }
  if (issuerUrl.origin === "null" || endpointUrl.origin !== issuerUrl.origin) {
    throw new Error("OIDC endpoint is not on the issuer origin");
  }
}

function assertDiscovery(doc: OidcDiscovery): void {
  assertPinnedOidcUrl(doc.issuer, doc.authorization_endpoint);
  assertPinnedOidcUrl(doc.issuer, doc.token_endpoint);
  assertPinnedOidcUrl(doc.issuer, doc.jwks_uri);
}

async function fetchNoRedirect(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error("OIDC endpoint returned a redirect");
  }
  return res;
}

async function readOidcJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > OIDC_BODY_LIMIT) throw new Error("OIDC response too large");
  return JSON.parse(text);
}

export async function getDiscovery(env: Env): Promise<OidcDiscovery> {
  const issuer = env.OIDC_ISSUER.replace(/\/+$/, "");
  if (discoveryCache?.issuer === issuer) return discoveryCache.doc;
  assertPinnedOidcUrl(issuer, `${issuer}/.well-known/openid-configuration`);
  const res = await fetchNoRedirect(
    `${issuer}/.well-known/openid-configuration`,
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`OIDC discovery failed: ${res.status}`);
  }
  const raw = (await readOidcJson(res)) as OidcDiscovery;
  const doc: OidcDiscovery = {
    issuer,
    authorization_endpoint: raw.authorization_endpoint,
    token_endpoint: raw.token_endpoint,
    jwks_uri: raw.jwks_uri,
  };
  assertDiscovery(doc);
  discoveryCache = { issuer, doc };
  return doc;
}

interface Jwk {
  kid?: string;
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  use?: string;
}

let jwksCache: { uri: string; keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

async function getJwks(env: Env): Promise<Jwk[]> {
  const discovery = await getDiscovery(env);
  const now = Date.now();
  if (
    jwksCache &&
    jwksCache.uri === discovery.jwks_uri &&
    now - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }
  assertPinnedOidcUrl(discovery.issuer, discovery.jwks_uri);
  const res = await fetchNoRedirect(discovery.jwks_uri);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`JWKS fetch failed: ${res.status}`);
  }
  const doc = (await readOidcJson(res)) as { keys: Jwk[] };
  jwksCache = { uri: discovery.jwks_uri, keys: doc.keys, fetchedAt: now };
  return doc.keys;
}

export interface VerifiedToken {
  sub: string;
  claims: Record<string, unknown>;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  try {
    return JSON.parse(
      new TextDecoder().decode(base64UrlDecode(part)),
    ) as Record<string, unknown>;
  } catch {
    throw new Error("malformed JWT");
  }
}

/**
 * Verify a JWT issued by the configured issuer.
 * Signature ES256 against JWKS; iss exact; exp in the future; nbf honored;
 * iat required and sane; aud must contain the audience (azp rules applied);
 * nonce must match when given.
 */
export async function verifyJwt(
  env: Env,
  token: string,
  opts: { audience: string; nonce?: string },
): Promise<VerifiedToken> {
  if (!opts.audience) throw new Error("audience is required");
  if (token.length === 0 || token.length > JWT_MAX_LENGTH) {
    throw new Error("malformed JWT");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  const header = decodeJsonPart(headerPart);
  const claims = decodeJsonPart(payloadPart);

  if (header["alg"] !== "ES256") throw new Error("unexpected JWT alg");
  if (header["crit"] !== undefined) throw new Error("unsupported crit");
  const typ = header["typ"];
  if (typ !== undefined && typ !== "JWT" && typ !== "jwt") {
    throw new Error("unexpected JWT typ");
  }
  const issuer = env.OIDC_ISSUER.replace(/\/+$/, "");
  if (claims["iss"] !== issuer) throw new Error("issuer mismatch");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = claims["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) {
    throw new Error("token expired");
  }
  const nbf = claims["nbf"];
  if (
    nbf !== undefined &&
    (typeof nbf !== "number" || !Number.isFinite(nbf) || nbf > nowSeconds)
  ) {
    throw new Error("token not yet valid");
  }
  const iat = claims["iat"];
  if (typeof iat !== "number" || !Number.isFinite(iat)) {
    throw new Error("token has no valid iat");
  }
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("token issued in the future");
  }
  if (iat > exp) throw new Error("token iat is after exp");

  const aud = claims["aud"];
  const audiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
  if (!audiences.includes(opts.audience)) throw new Error("audience mismatch");
  const azp = claims["azp"];
  if (audiences.length > 1 && azp !== opts.audience) {
    throw new Error("azp mismatch for multi-audience token");
  }
  if (azp !== undefined && azp !== opts.audience) {
    throw new Error("azp mismatch");
  }
  if (opts.nonce !== undefined) {
    const claimNonce = claims["nonce"];
    if (
      typeof claimNonce !== "string" ||
      !timingSafeEqual(claimNonce, opts.nonce)
    ) {
      throw new Error("nonce mismatch");
    }
  }

  const keys = await getJwks(env);
  if (header["kid"] !== undefined && typeof header["kid"] !== "string") {
    throw new Error("bad kid");
  }
  const kid = typeof header["kid"] === "string" ? header["kid"] : undefined;
  const jwk = keys.find(
    (k) => (kid ? k.kid === kid : true) && k.kty === "EC" && k.crv === "P-256",
  );
  if (!jwk || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("signing key not found");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(signaturePart);
  } catch {
    throw new Error("malformed signature");
  }
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature as BufferSource,
    signed,
  );
  if (!ok) throw new Error("signature verification failed");

  const sub = claims["sub"];
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 256) {
    throw new Error("missing sub");
  }
  return { sub, claims };
}

/** Exchange an authorization code at the token endpoint (public client). */
export async function exchangeCode(
  env: Env,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<{ idToken: string }> {
  const discovery = await getDiscovery(env);
  assertPinnedOidcUrl(discovery.issuer, discovery.token_endpoint);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: env.OIDC_CLIENT_ID,
    code_verifier: params.codeVerifier,
  });
  const res = await fetchNoRedirect(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`token exchange failed: ${res.status}`);
  }
  const json = (await readOidcJson(res)) as { id_token?: unknown };
  if (
    typeof json.id_token !== "string" ||
    json.id_token.length === 0 ||
    json.id_token.length > JWT_MAX_LENGTH
  ) {
    throw new Error("token response has no id_token");
  }
  return { idToken: json.id_token };
}
