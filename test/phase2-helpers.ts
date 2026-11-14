/** Shared helpers for the phase-2 API tests (mirrors api.test.ts style). */
import { expect } from "vitest";
import app from "../src/index";
import { FakeDb, makeEnv, seedAccount, sessionCookieFor } from "./fake-db";

export const ORIGIN = "https://kosu.0g0.xyz";

export interface CallOpts {
  method?: string;
  cookie?: string;
  apiKey?: string;
  body?: unknown;
  origin?: string | null;
}

export async function call(db: FakeDb, path: string, opts: CallOpts = {}) {
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

export async function setupOwner(db: FakeDb) {
  const { id } = await seedAccount(db);
  const cookie = await sessionCookieFor(id);
  return { accountId: id, cookie };
}

export async function setupSecondUser(
  db: FakeDb,
  email = "second@example.com",
) {
  const { id } = await seedAccount(db, { email });
  const cookie = await sessionCookieFor(id);
  return { accountId: id, cookie };
}

/** Build tenant -> workspace -> team -> project through the API. */
export async function buildHierarchy(db: FakeDb, cookie: string) {
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
  const projectId = project.project.id;
  return {
    tenantId,
    workspaceId,
    teamId,
    projectId,
    projectPath: `/api/v1/tenants/${tenantId}/workspaces/${workspaceId}/teams/${teamId}/projects/${projectId}`,
    tenantPath: `/api/v1/tenants/${tenantId}`,
  };
}
