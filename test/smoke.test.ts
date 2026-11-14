import { describe, expect, it } from "vitest";
import app from "../src/index";
import {
  decryptField,
  encryptField,
  fieldEncryptionAvailable,
} from "../src/crypto";

// 32-byte test key, base64-encoded. Test-only material, not a real secret.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const WRONG_KEY = Buffer.alloc(32, 9).toString("base64");

describe("app", () => {
  it("GET / returns the HTML landing page for browsers", async () => {
    const res = await app.request("/", {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Kosu");
    expect(html).toContain("/auth/login");
  });

  it("GET / still returns the service identity JSON when asked", async () => {
    const res = await app.request("/", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      status: string;
      version: string;
    };
    expect(body.name).toBe("Kosu");
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.8.1");
  });

  it("GET /health returns ok with the service identity", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.8.1");
  });

  it("GET /api/health returns the service identity", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; status: string };
    expect(body.name).toBe("Kosu");
    expect(body.status).toBe("ok");
  });
});

describe("field encryption", () => {
  it("round-trips UTF-8 text", async () => {
    const stored = await encryptField(TEST_KEY, "工数メモ: 設計レビュー 1.5h");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain("設計レビュー");
    await expect(decryptField(TEST_KEY, stored)).resolves.toBe(
      "工数メモ: 設計レビュー 1.5h",
    );
  });

  it("fails with a different key", async () => {
    const stored = await encryptField(TEST_KEY, "secret");
    await expect(decryptField(WRONG_KEY, stored)).rejects.toThrow();
  });

  it("reports availability from key material", async () => {
    await expect(fieldEncryptionAvailable(TEST_KEY)).resolves.toBe(true);
    await expect(fieldEncryptionAvailable(undefined)).resolves.toBe(false);
    await expect(fieldEncryptionAvailable("not-a-key")).resolves.toBe(false);
  });
});
