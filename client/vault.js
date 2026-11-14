/**
 * Kosu client vault (phase 2): the account data key (ADK) and the
 * client-side field encryption built on it.
 *
 * Key lifecycle:
 *  1. The client generates a random 32-byte ADK and a recovery code
 *     (160 bits, base32).
 *  2. A key-encryption key (KEK) is derived from the recovery code with
 *     PBKDF2-HMAC-SHA256; the ADK is AES-GCM-wrapped with it.
 *  3. Only the wrapped key, the KDF salt and iteration count, and (on the
 *     server) the recovery code's SHA-256 hash are stored server-side.
 *     The ADK and the recovery code never leave the client in plaintext,
 *     apart from the single recovery-verification call.
 *  4. A new device recovers by entering the recovery code: the server
 *     verifies its hash and returns the wrapped key, which the client
 *     unwraps locally.
 *
 * Body encryption uses the same wire format as the server's field
 * encryption (`v1.<base64url(iv || ciphertext)>`, AES-GCM, 12-byte IV),
 * so the values stored in *_enc columns are opaque to the server.
 */

const FORMAT_PREFIX = "v1.";
const IV_BYTES = 12;
const ADK_BYTES = 32;
export const DEFAULT_KDF_ITERATIONS = 210_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlDecode(input) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                       */
/* ------------------------------------------------------------------ */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 160-bit recovery code, grouped for humans: XXXX-XXXX-... (8 groups). */
export function generateRecoveryCode(random = crypto.getRandomValues.bind(crypto)) {
  const bytes = random(new Uint8Array(20));
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let code = "";
  for (let i = 0; i < bits.length; i += 5) {
    code += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/** Same normalization the server applies before hashing. */
export function normalizeRecoveryCode(code) {
  return String(code).replace(/[\s-]+/g, "").toUpperCase();
}

/* ------------------------------------------------------------------ */
/* ADK wrap / unwrap                                                    */
/* ------------------------------------------------------------------ */

async function deriveKek(recoveryCode, saltBytes, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(normalizeRecoveryCode(recoveryCode)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function importAdk(adkBytes) {
  return crypto.subtle.importKey("raw", adkBytes, "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

async function packEncrypted(key, plaintextBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextBytes),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return FORMAT_PREFIX + base64UrlEncode(packed);
}

async function unpackEncrypted(key, stored) {
  if (typeof stored !== "string" || !stored.startsWith(FORMAT_PREFIX)) {
    throw new Error("unknown encrypted value format");
  }
  const bytes = base64UrlDecode(stored.slice(FORMAT_PREFIX.length));
  if (bytes.length <= IV_BYTES) throw new Error("encrypted value too short");
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
    key,
    bytes.slice(IV_BYTES),
  );
  return new Uint8Array(clear);
}

/**
 * Create fresh vault material: a new ADK and recovery code plus the
 * server-bound wrapped form. The caller registers the wrapped form via
 * PUT /api/v1/me/encryption-key and shows the recovery code exactly once.
 */
export async function createVaultMaterial(iterations = DEFAULT_KDF_ITERATIONS) {
  const adkBytes = crypto.getRandomValues(new Uint8Array(ADK_BYTES));
  const recoveryCode = generateRecoveryCode();
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKek(recoveryCode, saltBytes, iterations);
  const wrappedKey = await packEncrypted(kek, adkBytes);
  return {
    adkBytes,
    recoveryCode,
    wrappedKey,
    kdfSalt: base64UrlEncode(saltBytes),
    kdfIterations: iterations,
  };
}

/**
 * Unwrap the ADK with a recovery code. Throws when the code is wrong
 * (AES-GCM authentication fails), before any server round-trip result is
 * trusted.
 */
export async function unwrapWithRecoveryCode({
  wrappedKey,
  kdfSalt,
  kdfIterations,
  recoveryCode,
}) {
  const kek = await deriveKek(
    recoveryCode,
    base64UrlDecode(kdfSalt),
    kdfIterations,
  );
  const adkBytes = await unpackEncrypted(kek, wrappedKey);
  if (adkBytes.length !== ADK_BYTES) throw new Error("invalid account key");
  return adkBytes;
}

/* ------------------------------------------------------------------ */
/* Body encryption with the ADK                                         */
/* ------------------------------------------------------------------ */

export async function encryptText(adkBytes, plaintext) {
  const key = await importAdk(adkBytes);
  return packEncrypted(key, encoder.encode(String(plaintext)));
}

export async function decryptText(adkBytes, stored) {
  const key = await importAdk(adkBytes);
  const clear = await unpackEncrypted(key, stored);
  return decoder.decode(clear);
}

/** Short non-sensitive fingerprint so the UI can show "key loaded". */
export async function adkFingerprint(adkBytes) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", adkBytes),
  );
  return [...digest.slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
