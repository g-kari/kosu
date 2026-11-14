/**
 * Token, hashing and signing helpers (WebCrypto only).
 *
 * Same constructions as Hyo (headless-vote): tokens are 32 random bytes,
 * hashes are SHA-256 hex, signed values are `<payload>.<hmac>` in base64url,
 * and PKCE uses S256.
 */
import { base64UrlEncode, base64UrlDecode } from "./crypto";

const encoder = new TextEncoder();

export function randomId(): string {
  return crypto.randomUUID();
}

/** Opaque prefixed token, e.g. randomToken("kosu") -> "kosu_<43 chars>". */
export function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64UrlEncode(bytes)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function utf8ToBase64Url(text: string): string {
  return base64UrlEncode(encoder.encode(text));
}

export function base64UrlToUtf8(input: string): string {
  return new TextDecoder().decode(base64UrlDecode(input));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign a JSON payload: `<payload>.<signature>` (both base64url). */
export async function signValue(
  secret: string,
  payload: unknown,
): Promise<string> {
  const body = utf8ToBase64Url(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Verify a value produced by signValue. Returns the payload or null. */
export async function verifySignedValue<T>(
  secret: string,
  value: string,
): Promise<T | null> {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(signature);
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes as BufferSource,
    encoder.encode(body),
  );
  if (!ok) return null;
  try {
    return JSON.parse(base64UrlToUtf8(body)) as T;
  } catch {
    return null;
  }
}

/** PKCE (RFC 7636) S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** Timing-safe string comparison for equal-length values. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
