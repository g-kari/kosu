import { describe, expect, it } from "vitest";
import app from "../src/index";
import { OFFLINE_JS, OFFLINE_URL } from "../src/routes/pages";
import { FakeDb, makeEnv } from "./fake-db";
import { ORIGIN, buildHierarchy, call, setupOwner } from "./phase2-helpers";

type Json = Record<string, any>;

async function j(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

describe("phase 9: offline support", () => {
  it("serves the offline asset and loads it first on app pages", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const env = makeEnv(db);
    const asset = await app.request(`${ORIGIN}${OFFLINE_URL}`, {}, env);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(OFFLINE_JS).toContain("kosu-offline");
    expect(OFFLINE_JS).toContain("client_started_at");

    const page = await app.request(
      `${ORIGIN}/app`,
      { headers: { cookie: owner.cookie } },
      env,
    );
    const html = await page.text();
    const offlineAt = html.indexOf(OFFLINE_URL);
    expect(offlineAt).toBeGreaterThan(-1);
    expect(offlineAt).toBeLessThan(html.indexOf("/assets/ui-"));
  });

  it("service worker caches API GETs, denies sensitive paths, purges on logout", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const sw = await app.request(`${ORIGIN}/sw.js`, {}, env);
    const body = await sw.text();
    expect(body).toContain("kosu-shell-v3");
    expect(body).toContain("kosu-data-v2");
    expect(body).toContain("encryption-key");
    expect(body).toContain("/attachments/");
    expect(body).toContain("/auth/logout");
    expect(body).toContain(OFFLINE_URL);
  });

  it("timer accepts client timestamps from offline-queued calls", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const created = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "オフライン計測" },
    });
    const task = (await j(created)).task as { id: string };

    const startedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const start = await call(db, `${h.tenantPath}/timer/start`, {
      method: "POST",
      cookie: owner.cookie,
      body: { task_id: task.id, client_started_at: startedAt },
    });
    expect(start.status).toBe(201);
    const entry = (await j(start)).entry as { started_at: string };
    expect(entry.started_at).toBe(startedAt);

    const stoppedAt = new Date(Date.now() - 3600 * 1000).toISOString();
    const stop = await call(db, `${h.tenantPath}/timer/stop`, {
      method: "POST",
      cookie: owner.cookie,
      body: { client_stopped_at: stoppedAt },
    });
    expect(stop.status).toBe(200);
    const stopped = (await j(stop)).entry as {
      ended_at: string;
      duration_seconds: number;
    };
    expect(stopped.ended_at).toBe(stoppedAt);
    expect(stopped.duration_seconds).toBe(3600);
  });

  it("rejects future or stale client timestamps", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const future = await call(db, `${h.tenantPath}/timer/start`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        workspace_id: h.workspaceId,
        client_started_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    });
    expect(future.status).toBe(400);
    const stale = await call(db, `${h.tenantPath}/timer/start`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        workspace_id: h.workspaceId,
        client_started_at: new Date(
          Date.now() - 8 * 24 * 3600 * 1000,
        ).toISOString(),
      },
    });
    expect(stale.status).toBe(400);
  });
});

