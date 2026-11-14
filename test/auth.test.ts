import { describe, expect, it } from "vitest";
import app from "../src/index";
import { normalizeScopes, scopeAllows } from "../src/apikeys";
import { safeNextPath } from "../src/session";
import { pkceChallenge, signValue, verifySignedValue } from "../src/tokens";
import { FakeDb, makeEnv, seedAccount, sessionCookieFor } from "./fake-db";

describe("PKCE", () => {
  it("matches the RFC 7636 test vector", async () => {
    // RFC 7636 Appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    await expect(pkceChallenge(verifier)).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("signed values", () => {
  it("round-trips a payload", async () => {
    const value = await signValue("s3cret", { kind: "session", n: 42 });
    await expect(verifySignedValue("s3cret", value)).resolves.toEqual({
      kind: "session",
      n: 42,
    });
  });
  it("rejects tampering and wrong secrets", async () => {
    const value = await signValue("s3cret", { kind: "session" });
    const tampered = value.slice(0, -2) + "xx";
    await expect(verifySignedValue("s3cret", tampered)).resolves.toBeNull();
    await expect(verifySignedValue("other", value)).resolves.toBeNull();
    await expect(verifySignedValue("s3cret", "not-a-token")).resolves.toBeNull();
  });
});

describe("safeNextPath", () => {
  it("allows same-origin paths and rejects open redirects", () => {
    expect(safeNextPath("/api/v1/tenants")).toBe("/api/v1/tenants");
    expect(safeNextPath("//evil.example.com")).toBe("/");
    expect(safeNextPath("https://evil.example.com")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("/\\evil")).toBe("/");
  });
});

describe("API key scopes", () => {
  it("read scope allows only safe methods; write allows all", () => {
    expect(scopeAllows(["read"], "GET")).toBe(true);
    expect(scopeAllows(["read"], "HEAD")).toBe(true);
    expect(scopeAllows(["read"], "POST")).toBe(false);
    expect(scopeAllows(["read"], "DELETE")).toBe(false);
    expect(scopeAllows(["write"], "DELETE")).toBe(true);
    expect(scopeAllows(["read", "write"], "PATCH")).toBe(true);
    expect(scopeAllows([], "GET")).toBe(false);
  });
  it("normalizeScopes validates and deduplicates", () => {
    expect(normalizeScopes(["read", "read", "write"])).toEqual([
      "read",
      "write",
    ]);
    expect(() => normalizeScopes([])).toThrow();
    expect(() => normalizeScopes(["admin"])).toThrow();
    expect(() => normalizeScopes("read")).toThrow();
  });
});

describe("GET /me", () => {
  it("is 401 without credentials", async () => {
    const db = new FakeDb();
    const res = await app.request("https://kosu.0g0.xyz/me", {}, makeEnv(db));
    expect(res.status).toBe(401);
  });

  it("returns the internal account id for a valid session, never the sub", async () => {
    const db = new FakeDb();
    const { id } = await seedAccount(db);
    const cookie = await sessionCookieFor(id);
    const res = await app.request(
      "https://kosu.0g0.xyz/me",
      { headers: { cookie } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      account: { id: string; email: string };
    };
    expect(body.account.id).toBe(id);
    expect(body.account.email).toBe("user@example.com");
    expect(JSON.stringify(body)).not.toContain("sub-");
  });

  it("rejects a session cookie signed with another secret", async () => {
    const db = new FakeDb();
    const { id } = await seedAccount(db);
    const { signValue } = await import("../src/tokens");
    const forged = await signValue("attacker-secret", {
      kind: "session",
      accountId: id,
      epoch: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await app.request(
      "https://kosu.0g0.xyz/me",
      {
        headers: {
          cookie: `__Host-kosu_session=${encodeURIComponent(forged)}`,
        },
      },
      makeEnv(db),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an expired session cookie", async () => {
    const db = new FakeDb();
    const { id } = await seedAccount(db);
    const { signValue } = await import("../src/tokens");
    const expired = await signValue("test-session-secret", {
      kind: "session",
      accountId: id,
      epoch: 0,
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const res = await app.request(
      "https://kosu.0g0.xyz/me",
      {
        headers: {
          cookie: `__Host-kosu_session=${encodeURIComponent(expired)}`,
        },
      },
      makeEnv(db),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /auth/login", () => {
  it("redirects to the IdP authorize endpoint with PKCE parameters", async () => {
    const db = new FakeDb();
    const res = await app.request("https://kosu.0g0.xyz/auth/login", {}, makeEnv(db));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://id.0g0.xyz/auth/authorize?")).toBe(
      true,
    );
    const params = new URL(location).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("test-client");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("state")).toBeTruthy();
    expect(params.get("nonce")).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain("kosu_oidc_flow");
    // The state was registered for single-use consumption.
    expect(db.rows("oidc_states")).toHaveLength(1);
  });
});
