/**
 * Account encryption vault (client-side key management, phase 2).
 *
 * The account data key (ADK) is generated in the client, wrapped with a
 * key derived from the user's recovery code (PBKDF2), and only the
 * wrapped form is stored here together with the recovery code's SHA-256
 * hash. The server never sees the ADK or the recovery code in plaintext,
 * so a database leak alone does not expose encrypted bodies.
 */
import { nowIso } from "./accounts";
import { badRequest, conflict, notFound, unauthorized } from "./errors";
import { sha256Hex, timingSafeEqual } from "./tokens";
import type { Env } from "./types";

export interface AccountKeyRow {
  account_id: string;
  wrapped_key: string;
  kdf_salt: string;
  kdf_iterations: number;
  recovery_code_hash: string;
  created_at: string;
  updated_at: string;
}

const MAX_WRAPPED_KEY_LENGTH = 4096;
const MAX_ITERATIONS = 5_000_000;

export function publicVault(row: AccountKeyRow | null) {
  if (!row) return { exists: false as const };
  return {
    exists: true as const,
    wrapped_key: row.wrapped_key,
    kdf: { salt: row.kdf_salt, iterations: Number(row.kdf_iterations) },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getAccountKey(
  env: Env,
  accountId: string,
): Promise<AccountKeyRow | null> {
  return env.DB.prepare(
    "SELECT * FROM account_keys WHERE account_id = ?1",
  )
    .bind(accountId)
    .first<AccountKeyRow>();
}

export interface VaultInput {
  wrappedKey: string;
  kdfSalt: string;
  kdfIterations: number;
  recoveryCode: string;
}

export function parseVaultInput(body: Record<string, unknown>): VaultInput {
  const wrappedKey = body["wrapped_key"];
  const kdfSalt = body["kdf_salt"];
  const kdfIterations = body["kdf_iterations"];
  const recoveryCode = body["recovery_code"];
  if (
    typeof wrappedKey !== "string" ||
    wrappedKey.length < 10 ||
    wrappedKey.length > MAX_WRAPPED_KEY_LENGTH
  ) {
    throw badRequest('"wrapped_key" must be a wrapped key string');
  }
  if (typeof kdfSalt !== "string" || kdfSalt.length < 8 || kdfSalt.length > 256) {
    throw badRequest('"kdf_salt" must be a base64 salt string');
  }
  if (
    typeof kdfIterations !== "number" ||
    !Number.isInteger(kdfIterations) ||
    kdfIterations < 10_000 ||
    kdfIterations > MAX_ITERATIONS
  ) {
    throw badRequest('"kdf_iterations" must be an integer 10000-5000000');
  }
  if (typeof recoveryCode !== "string" || recoveryCode.length < 8) {
    throw badRequest('"recovery_code" is required');
  }
  return { wrappedKey, kdfSalt, kdfIterations, recoveryCode };
}

/** Normalize a recovery code the same way the client does before hashing. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

export async function recoveryCodeHash(code: string): Promise<string> {
  return sha256Hex(`kosu-recovery:${normalizeRecoveryCode(code)}`);
}

/**
 * Create the vault, or rotate it when `rotate` is set and the caller
 * proves knowledge of the current recovery code.
 */
export async function putAccountKey(
  env: Env,
  accountId: string,
  input: VaultInput,
  opts: { rotate?: boolean; currentRecoveryCode?: string } = {},
): Promise<AccountKeyRow> {
  const existing = await getAccountKey(env, accountId);
  const now = nowIso();
  const hash = await recoveryCodeHash(input.recoveryCode);
  if (existing) {
    if (!opts.rotate) {
      throw conflict(
        "VAULT_EXISTS",
        "An encryption key is already registered; rotate it explicitly",
      );
    }
    if (!opts.currentRecoveryCode) {
      throw badRequest(
        '"current_recovery_code" is required to rotate the key',
      );
    }
    const currentHash = await recoveryCodeHash(opts.currentRecoveryCode);
    if (!timingSafeEqual(currentHash, existing.recovery_code_hash)) {
      throw unauthorized(
        "RECOVERY_CODE_MISMATCH",
        "The current recovery code does not match",
      );
    }
    await env.DB.prepare(
      "UPDATE account_keys SET wrapped_key = ?1, kdf_salt = ?2, kdf_iterations = ?3, recovery_code_hash = ?4, updated_at = ?5 WHERE account_id = ?6",
    )
      .bind(
        input.wrappedKey,
        input.kdfSalt,
        input.kdfIterations,
        hash,
        now,
        accountId,
      )
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO account_keys (account_id, wrapped_key, kdf_salt, kdf_iterations, recovery_code_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(
        accountId,
        input.wrappedKey,
        input.kdfSalt,
        input.kdfIterations,
        hash,
        now,
        now,
      )
      .run();
  }
  const row = await getAccountKey(env, accountId);
  if (!row) throw new Error("vault write failed");
  return row;
}

/**
 * Recovery flow step: verify the recovery code against the stored hash.
 * On success the caller receives the wrapped key + KDF parameters and
 * unwraps the ADK locally; the code itself never leaves the client other
 * than this single verification call.
 */
export async function recoverAccountKey(
  env: Env,
  accountId: string,
  recoveryCode: string,
): Promise<AccountKeyRow> {
  const row = await getAccountKey(env, accountId);
  if (!row) throw notFound("No encryption key is registered");
  const hash = await recoveryCodeHash(recoveryCode);
  if (!timingSafeEqual(hash, row.recovery_code_hash)) {
    throw unauthorized(
      "RECOVERY_CODE_MISMATCH",
      "The recovery code does not match",
    );
  }
  return row;
}
