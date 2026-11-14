import { describe, expect, it } from "vitest";
import app from "../src/index";
import { FakeDb, makeEnv, seedAccount, sessionCookieFor } from "./fake-db";

const ORIGIN = "https://kosu.0g0.xyz";
const NOW = "2026-11-14T00:00:00.000Z";

interface CallOpts {
  method?: string;
  cookie?: string;
  apiKey?: string;
  body?: unknown;
  origin?: string | null;
}

async function call(db: FakeDb, path: string, opts: CallOpts = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;
  const method = opts.method ?? "GET";
  if (opts.cookie && method !== "GET" && opts.origin !== null) {
    headers["origin"] = opts.origin ?? ORIGIN;
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return app.request(`${ORIGIN}${path}`, init, makeEnv(db));
}

async function setupOwner(db: FakeDb) {
  const { id } = await seedAccount(db);
  const cookie = await sessionCookieFor(id);
  return { accountId: id, cookie };
}

/** Build tenant -> workspace -> team -> project through the API. */
async function buildHierarchy(db: FakeDb, cookie: string) {
  const t = await call(db, "/api/v1/tenants", {
    method: "POST",
    cookie,
    body: { name: "会社" },
  });
  expect(t.status).toBe(201);
  const tenant = (await t.json()) as { tenant: { id: string } };
  const tenantId = tenant.tenant.id;

  const w = await call(db, `/api/v1/tenants/${tenantId}/workspaces`, {
    method: "POST",
    cookie,
    body: { name: "開発" },
  });
  expect(w.status).toBe(201);
  const workspace = (await w.json()) as { workspace: { id: string } };
  const workspaceId = workspace.workspace.id;

  const tm = await call(
    db,
    `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/teams`,
    { method: "POST", cookie, body: { name: "チームA" } },
  );
  expect(tm.status).toBe(201);
  const team = (await tm.json()) as { team: { id: string } };
  const teamId = team.team.id;

  const p = await call(
    db,
    `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/teams/${teamId}/projects`,
    {
      method: "POST",
      cookie,
      body: { name: "プロジェクトX", color: "#1e4fd8", due_on: "2026-12-31" },
    },
  );
  expect(p.status).toBe(201);
  const project = (await p.json()) as { project: { id: string } };
  return { tenantId, workspaceId, teamId, projectId: project.project.id };
}

function addMember(
  db: FakeDb,
  table: string,
  idCol: string,
  resourceId: string,
  accountId: string,
  role: string,
) {
  db.seed(table, {
    [idCol]: resourceId,
    account_id: accountId,
    role,
    created_at: NOW,
  });
}

describe("hierarchy CRUD authorization", () => {
  it("rejects unauthenticated calls", async () => {
    const db = new FakeDb();
    const res = await call(db, "/api/v1/tenants");
    expect(res.status).toBe(401);
  });

  it("creates the full hierarchy and reads it back", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const ids = await buildHierarchy(db, cookie);

    const list = await call(db, "/api/v1/tenants", { cookie });
    expect(list.status).toBe(200);
    const tenants = (await list.json()) as {
      tenants: { id: string; access: { admin: boolean } }[];
    };
    expect(tenants.tenants).toHaveLength(1);
    expect(tenants.tenants[0]?.access.admin).toBe(true);

    const got = await call(
      db,
      `/api/v1/tenants/${ids.tenantId}/workspaces/${ids.workspaceId}/teams/${ids.teamId}/projects/${ids.projectId}`,
      { cookie },
    );
    expect(got.status).toBe(200);
    const project = (await got.json()) as {
      project: { name: string; color: string; due_on: string };
    };
    expect(project.project.name).toBe("プロジェクトX");
    expect(project.project.color).toBe("#1e4fd8");
    expect(project.project.due_on).toBe("2026-12-31");
  });

  it("hides other accounts' tenants (404, empty list)", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const ids = await buildHierarchy(db, owner.cookie);

    const stranger = await seedAccount(db);
    const strangerCookie = await sessionCookieFor(stranger.id);
    const list = await call(db, "/api/v1/tenants", { cookie: strangerCookie });
    const body = (await list.json()) as { tenants: unknown[] };
    expect(body.tenants).toHaveLength(0);

    const got = await call(db, `/api/v1/tenants/${ids.tenantId}`, {
      cookie: strangerCookie,
    });
    expect(got.status).toBe(404);
  });

  it("blocks cross-tenant ancestry mismatches", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const a = await buildHierarchy(db, owner.cookie);
    const b = await buildHierarchy(db, owner.cookie);
    // Workspace of tenant B addressed under tenant A.
    const res = await call(
      db,
      `/api/v1/tenants/${a.tenantId}/workspaces/${b.workspaceId}`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(404);
  });

  it("project viewer can read but not update or delete", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const ids = await buildHierarchy(db, owner.cookie);
    const viewer = await seedAccount(db);
    addMember(db, "tenant_members", "tenant_id", ids.tenantId, viewer.id, "member");
    addMember(db, "project_members", "project_id", ids.projectId, viewer.id, "viewer");
    const cookie = await sessionCookieFor(viewer.id);
    const path = `/api/v1/tenants/${ids.tenantId}/workspaces/${ids.workspaceId}/teams/${ids.teamId}/projects/${ids.projectId}`;

    expect((await call(db, path, { cookie })).status).toBe(200);
    const patch = await call(db, path, {
      method: "PATCH",
      cookie,
      body: { name: "改名" },
    });
    expect(patch.status).toBe(403);
    const del = await call(db, path, { method: "DELETE", cookie });
    expect(del.status).toBe(403);
  });

  it("team lead can delete a project by inheritance", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const ids = await buildHierarchy(db, owner.cookie);
    const lead = await seedAccount(db);
    addMember(db, "tenant_members", "tenant_id", ids.tenantId, lead.id, "member");
    addMember(db, "team_members", "team_id", ids.teamId, lead.id, "lead");
    const cookie = await sessionCookieFor(lead.id);
    const path = `/api/v1/tenants/${ids.tenantId}/workspaces/${ids.workspaceId}/teams/${ids.teamId}/projects/${ids.projectId}`;
    expect((await call(db, path, { method: "DELETE", cookie })).status).toBe(200);
    expect((await call(db, path, { cookie: owner.cookie })).status).toBe(404);
  });

  it("tenant admin can update a workspace they are not a member of", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const ids = await buildHierarchy(db, owner.cookie);
    const admin = await seedAccount(db);
    addMember(db, "tenant_members", "tenant_id", ids.tenantId, admin.id, "admin");
    const cookie = await sessionCookieFor(admin.id);
    const res = await call(
      db,
      `/api/v1/tenants/${ids.tenantId}/workspaces/${ids.workspaceId}`,
      { method: "PATCH", cookie, body: { name: "改名WS" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: { name: string } };
    expect(body.workspace.name).toBe("改名WS");
  });

  it("plain tenant member cannot delete a tenant; owner can (soft delete)", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const ids = await buildHierarchy(db, owner.cookie);
    const member = await seedAccount(db);
    addMember(db, "tenant_members", "tenant_id", ids.tenantId, member.id, "member");
    const memberCookie = await sessionCookieFor(member.id);
    const del = await call(db, `/api/v1/tenants/${ids.tenantId}`, {
      method: "DELETE",
      cookie: memberCookie,
    });
    expect(del.status).toBe(403);

    const ok = await call(db, `/api/v1/tenants/${ids.tenantId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(ok.status).toBe(200);
    const got = await call(db, `/api/v1/tenants/${ids.tenantId}`, {
      cookie: owner.cookie,
    });
    expect(got.status).toBe(404);
  });

  it("validates input", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const empty = await call(db, "/api/v1/tenants", {
      method: "POST",
      cookie,
      body: { name: "  " },
    });
    expect(empty.status).toBe(400);
    const ids = await buildHierarchy(db, cookie);
    const badColor = await call(
      db,
      `/api/v1/tenants/${ids.tenantId}/workspaces/${ids.workspaceId}/teams/${ids.teamId}/projects/${ids.projectId}`,
      { method: "PATCH", cookie, body: { color: "red" } },
    );
    expect(badColor.status).toBe(400);
  });

  it("rejects session mutations without a same-origin Origin header", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const noOrigin = await call(db, "/api/v1/tenants", {
      method: "POST",
      cookie,
      body: { name: "会社" },
      origin: null,
    });
    expect(noOrigin.status).toBe(403);
    const wrongOrigin = await call(db, "/api/v1/tenants", {
      method: "POST",
      cookie,
      body: { name: "会社" },
      origin: "https://evil.example.com",
    });
    expect(wrongOrigin.status).toBe(403);
  });
});

describe("API keys", () => {
  async function issueKey(
    db: FakeDb,
    cookie: string,
    tenantId: string,
    scopes: string[],
  ): Promise<string> {
    const res = await call(db, `/api/v1/tenants/${tenantId}/api-keys`, {
      method: "POST",
      cookie,
      body: { name: "テストキー", scopes },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { api_key: string };
    return body.api_key;
  }

  it("issues a key, returns plaintext once, lists metadata only", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const ids = await buildHierarchy(db, owner.cookie);
    const key = await issueKey(db, owner.cookie, ids.tenantId, ["read", "write"]);
    expect(key.startsWith("kosu_")).toBe(true);

    const list = await call(db, `/api/v1/tenants/${ids.tenantId}/api-keys`, {
      cookie: owner.cookie,
    });
    const body = (await list.json()) as {
      keys: { prefix: string; scopes: string[] }[];
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.prefix).toBe(key.slice(0, 12));
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it("read key can GET but not mutate; write key can mutate", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const ids = await buildHierarchy(db, owner.cookie);
    const readKey = await issueKey(db, owner.cookie, ids.tenantId, ["read"]);
    const writeKey = await issueKey(db, owner.cookie, ids.tenantId, ["write"]);

    const got = await call(db, `/api/v1/tenants/${ids.tenantId}`, {
      apiKey: readKey,
    });
    expect(got.status).toBe(200);

    const denied = await call(db, `/api/v1/tenants/${ids.tenantId}/workspaces`, {
      method: "POST",
      apiKey: readKey,
      body: { name: "だめ" },
    });
    expect(denied.status).toBe(403);

    const created = await call(db, `/api/v1/tenants/${ids.tenantId}/workspaces`, {
      method: "POST",
      apiKey: writeKey,
      body: { name: "キーで作成" },
    });
    expect(created.status).toBe(201);
  });

  it("key is bound to its tenant; revoked and invalid keys fail", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const a = await buildHierarchy(db, owner.cookie);
    const b = await buildHierarchy(db, owner.cookie);
    const key = await issueKey(db, owner.cookie, a.tenantId, ["read", "write"]);

    const cross = await call(db, `/api/v1/tenants/${b.tenantId}`, { apiKey: key });
    expect(cross.status).toBe(404);

    const invalid = await call(db, `/api/v1/tenants/${a.tenantId}`, {
      apiKey: "kosu_not-a-real-key",
    });
    expect(invalid.status).toBe(401);

    // Revoke via the keys list id.
    const list = await call(db, `/api/v1/tenants/${a.tenantId}/api-keys`, {
      cookie: owner.cookie,
    });
    const keys = (await list.json()) as { keys: { id: string }[] };
    const keyId = keys.keys[0]?.id as string;
    const revoke = await call(
      db,
      `/api/v1/tenants/${a.tenantId}/api-keys/${keyId}`,
      { method: "DELETE", cookie: owner.cookie },
    );
    expect(revoke.status).toBe(200);
    const after = await call(db, `/api/v1/tenants/${a.tenantId}`, { apiKey: key });
    expect(after.status).toBe(401);
  });
});
