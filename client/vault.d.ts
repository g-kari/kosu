/** Type declarations for vault.js (plain-JS client library). */
export declare const DEFAULT_KDF_ITERATIONS: number;
export declare function generateRecoveryCode(): string;
export declare function normalizeRecoveryCode(code: string): string;
export interface VaultMaterial {
  adkBytes: Uint8Array;
  recoveryCode: string;
  wrappedKey: string;
  kdfSalt: string;
  kdfIterations: number;
}
export declare function createVaultMaterial(
  iterations?: number,
): Promise<VaultMaterial>;
export declare function unwrapWithRecoveryCode(input: {
  wrappedKey: string;
  kdfSalt: string;
  kdfIterations: number;
  recoveryCode: string;
}): Promise<Uint8Array>;
export declare function encryptText(
  adkBytes: Uint8Array,
  plaintext: string,
): Promise<string>;
export declare function decryptText(
  adkBytes: Uint8Array,
  stored: string,
): Promise<string>;
export declare function adkFingerprint(
  adkBytes: Uint8Array,
): Promise<string>;
export declare function base64UrlEncode(bytes: Uint8Array): string;
export declare function base64UrlDecode(input: string): Uint8Array;
