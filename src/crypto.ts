/**
 * Field encryption helpers (AES-GCM, WebCrypto).
 *
 * Same scheme as Hyo (headless-vote): the key is a base64-encoded 32-byte
 * value supplied as a Worker secret (FIELD_ENCRYPTION_KEY). Each record is
 * encrypted with a fresh random 12-byte IV and stored as
 * `v1.<base64url(iv || ciphertext)>`, so plaintext never reaches D1.
 */

const FORMAT_PREFIX = "v1.";
const IV_BYTES = 12;
const KEY_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Import the field-encryption key from its string form (base64 or base64url,
 * 32 bytes). Returns null when the material is missing or unusable, so
 * callers can treat encryption as unavailable instead of failing open.
 */
export async function importFieldKey(
  keyMaterial: string | undefined,
): Promise<CryptoKey | null> {
  const raw = keyMaterial?.trim();
  if (!raw) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(raw.replace(/\+/g, "-").replace(/\//g, "_"));
  } catch {
    return null;
  }
  if (bytes.length !== KEY_BYTES) return null;
  return crypto.subtle.importKey(
    "raw",
    bytes as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

/** True when a usable field-encryption key is configured. */
export async function fieldEncryptionAvailable(
  keyMaterial: string | undefined,
): Promise<boolean> {
  return (await importFieldKey(keyMaterial)) !== null;
}

/** Encrypt a UTF-8 string. Output format: `v1.<base64url(iv || ciphertext)>`. */
export async function encryptField(
  keyMaterial: string | undefined,
  plaintext: string,
): Promise<string> {
  const key = await importFieldKey(keyMaterial);
  if (!key) throw new Error("FIELD_ENCRYPTION_KEY is not configured");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(plaintext),
    ),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return FORMAT_PREFIX + base64UrlEncode(packed);
}

/** Decrypt a value produced by encryptField. Throws on tampering or wrong key. */
export async function decryptField(
  keyMaterial: string | undefined,
  stored: string,
): Promise<string> {
  const key = await importFieldKey(keyMaterial);
  if (!key) throw new Error("FIELD_ENCRYPTION_KEY is not configured");
  if (!stored.startsWith(FORMAT_PREFIX)) {
    throw new Error("unknown encrypted field format");
  }
  const bytes = base64UrlDecode(stored.slice(FORMAT_PREFIX.length));
  if (bytes.length <= IV_BYTES) throw new Error("encrypted field too short");
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) as BufferSource },
    key,
    bytes.slice(IV_BYTES) as BufferSource,
  );
  return decoder.decode(clear);
}
