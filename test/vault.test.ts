import { describe, expect, it } from "vitest";
import { decryptField } from "../src/crypto";
import {
  createVaultMaterial,
  decryptText,
  encryptText,
  normalizeRecoveryCode,
  unwrapWithRecoveryCode,
} from "../client/vault.js";
import { FakeDb } from "./fake-db";
import { call, setupOwner } from "./phase2-helpers";

describe("client vault crypto", () => {
  it("wraps and unwraps the ADK with the recovery code", async () => {
    const material = await createVaultMaterial(10_000);
    expect(material.recoveryCode).toMatch(
      /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/,
    );
    const unwrapped = await unwrapWithRecoveryCode({
      wrappedKey: material.wrappedKey,
      kdfSalt: material.kdfSalt,
      kdfIterations: material.kdfIterations,
      recoveryCode: material.recoveryCode.toLowerCase(),
    });
    expect([...unwrapped]).toEqual([...material.adkBytes]);
    await expect(
      unwrapWithRecoveryCode({
        wrappedKey: material.wrappedKey,
        kdfSalt: material.kdfSalt,
        kdfIterations: material.kdfIterations,
        recoveryCode: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA",
      }),
    ).rejects.toThrow();
    expect(normalizeRecoveryCode(" ab-cd ")).toBe("ABCD");
  });

  it("encrypts text in the server-compatible v1 format", async () => {
    const material = await createVaultMaterial(10_000);
    const stored = await encryptText(material.adkBytes, "秘密のメモ");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(await decryptText(material.adkBytes, stored)).toBe("秘密のメモ");
    // The Worker's own decryptField (used for FIELD_ENCRYPTION_KEY values)
    // reads the same format when given the ADK as key material.
    const keyMaterial = Buffer.from(material.adkBytes).toString("base64");
    expect(await decryptField(keyMaterial, stored)).toBe("秘密のメモ");
  });
});

describe("account key API", () => {
  it("registers, recovers and rotates the vault", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const material = await createVaultMaterial(10_000);

    const empty = await call(db, "/api/v1/me/encryption-key", {
      cookie: owner.cookie,
    });
    expect(((await empty.json()) as { vault: { exists: boolean } }).vault.exists).toBe(false);

    const put = await call(db, "/api/v1/me/encryption-key", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        wrapped_key: material.wrappedKey,
        kdf_salt: material.kdfSalt,
        kdf_iterations: material.kdfIterations,
        recovery_code: material.recoveryCode,
      },
    });
    expect(put.status).toBe(200);

    const duplicate = await call(db, "/api/v1/me/encryption-key", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        wrapped_key: material.wrappedKey,
        kdf_salt: material.kdfSalt,
        kdf_iterations: material.kdfIterations,
        recovery_code: material.recoveryCode,
      },
    });
    expect(duplicate.status).toBe(409);

    const wrong = await call(db, "/api/v1/me/encryption-key/recover", {
      method: "POST",
      cookie: owner.cookie,
      body: { recovery_code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ" },
    });
    expect(wrong.status).toBe(401);

    const recovered = await call(db, "/api/v1/me/encryption-key/recover", {
      method: "POST",
      cookie: owner.cookie,
      body: { recovery_code: material.recoveryCode },
    });
    expect(recovered.status).toBe(200);
    const vault = (
      (await recovered.json()) as {
        vault: { wrapped_key: string; kdf: { salt: string; iterations: number } };
      }
    ).vault;
    expect(vault.wrapped_key).toBe(material.wrappedKey);
    // ...and the returned material unwraps locally to the same ADK.
    const adk = await unwrapWithRecoveryCode({
      wrappedKey: vault.wrapped_key,
      kdfSalt: vault.kdf.salt,
      kdfIterations: vault.kdf.iterations,
      recoveryCode: material.recoveryCode,
    });
    expect([...adk]).toEqual([...material.adkBytes]);

    // Rotation requires the current recovery code.
    const next = await createVaultMaterial(10_000);
    const rotateNoProof = await call(db, "/api/v1/me/encryption-key", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        wrapped_key: next.wrappedKey,
        kdf_salt: next.kdfSalt,
        kdf_iterations: next.kdfIterations,
        recovery_code: next.recoveryCode,
        rotate: true,
      },
    });
    expect(rotateNoProof.status).toBe(400);
    const rotate = await call(db, "/api/v1/me/encryption-key", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        wrapped_key: next.wrappedKey,
        kdf_salt: next.kdfSalt,
        kdf_iterations: next.kdfIterations,
        recovery_code: next.recoveryCode,
        rotate: true,
        current_recovery_code: material.recoveryCode,
      },
    });
    expect(rotate.status).toBe(200);
  });
});
