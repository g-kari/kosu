import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { buildHierarchy, call, setupOwner } from "./phase2-helpers";

async function registerDevice(db: FakeDb, cookie: string): Promise<string> {
  const res = await call(db, "/api/v1/sync/devices", {
    method: "POST",
    cookie,
    body: { name: "テスト端末", platform: "test" },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { device: { id: string } }).device.id;
}

async function push(
  db: FakeDb,
  cookie: string,
  tenantId: string,
  deviceId: string,
  changes: unknown[],
) {
  return call(db, `/api/v1/tenants/${tenantId}/sync/push`, {
    method: "POST",
    cookie,
    body: { device_id: deviceId, changes },
  });
}

describe("sync push/pull", () => {
  it("pushes a new task, pulls it back from seq 0, then updates it", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const deviceId = await registerDevice(db, cookie);
    const taskId = crypto.randomUUID();

    const created = await push(db, cookie, h.tenantId, deviceId, [
      {
        entity_type: "task",
        entity_id: taskId,
        op: "upsert",
        base_version: 0,
        payload: { project_id: h.projectId, title: "同期タスク", status: "todo" },
      },
    ]);
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      results: { status: string; version: number }[];
      last_seq: number;
    };
    expect(createdBody.results[0]?.status).toBe("applied");
    expect(createdBody.results[0]?.version).toBe(1);

    // The task is visible through the plain REST API too.
    const viaRest = await call(db, `${h.projectPath}/tasks/${taskId}`, {
      cookie,
    });
    expect(viaRest.status).toBe(200);

    const pull = await call(
      db,
      `${h.tenantPath}/sync/pull?device_id=${deviceId}&since_seq=0`,
      { cookie },
    );
    expect(pull.status).toBe(200);
    const pullBody = (await pull.json()) as {
      changes: { entity_type: string; entity_id: string; payload: { title: string } }[];
      last_seq: number;
    };
    const taskChange = pullBody.changes.find(
      (ch) => ch.entity_type === "task" && ch.entity_id === taskId,
    );
    expect(taskChange?.payload.title).toBe("同期タスク");

    const updated = await push(db, cookie, h.tenantId, deviceId, [
      {
        entity_type: "task",
        entity_id: taskId,
        op: "upsert",
        base_version: 1,
        payload: { title: "同期タスク改" },
      },
    ]);
    const updatedBody = (await updated.json()) as {
      results: { status: string; version: number }[];
    };
    expect(updatedBody.results[0]?.status).toBe("applied");
    expect(updatedBody.results[0]?.version).toBe(2);
  });

  it("records a conflict when base_version is stale and reports it in status", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const deviceId = await registerDevice(db, cookie);

    const created = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie,
      body: { title: "元タスク" },
    });
    const task = ((await created.json()) as { task: { id: string } }).task;

    // Server-side edit bumps the version to 2.
    await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "PATCH",
      cookie,
      body: { title: "サーバー側の編集" },
    });

    const stale = await push(db, cookie, h.tenantId, deviceId, [
      {
        entity_type: "task",
        entity_id: task.id,
        op: "upsert",
        base_version: 1,
        payload: { title: "古いクライアントの編集" },
      },
    ]);
    expect(stale.status).toBe(200);
    const staleBody = (await stale.json()) as {
      results: {
        status: string;
        server_version: number;
        server_payload: { title: string };
      }[];
    };
    expect(staleBody.results[0]?.status).toBe("conflict");
    expect(staleBody.results[0]?.server_version).toBe(2);
    expect(staleBody.results[0]?.server_payload.title).toBe("サーバー側の編集");

    const status = await call(
      db,
      `${h.tenantPath}/sync/status?device_id=${deviceId}`,
      { cookie },
    );
    const statusBody = (await status.json()) as { open_conflicts: number };
    expect(statusBody.open_conflicts).toBe(1);

    const conflicts = await call(db, `${h.tenantPath}/sync/conflicts`, {
      cookie,
    });
    expect(conflicts.status).toBe(200);
    const list = (
      (await conflicts.json()) as {
        conflicts: { client_payload: { title: string } }[];
      }
    ).conflicts;
    expect(list).toHaveLength(1);
    expect(list[0]?.client_payload.title).toBe("古いクライアントの編集");

    // The server's version is untouched.
    const after = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      cookie,
    });
    expect(((await after.json()) as { task: { title: string } }).task.title).toBe(
      "サーバー側の編集",
    );
  });

  it("rejects push/pull from a revoked device", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const deviceId = await registerDevice(db, cookie);
    const revoke = await call(db, `/api/v1/sync/devices/${deviceId}`, {
      method: "DELETE",
      cookie,
    });
    expect(revoke.status).toBe(200);
    const pull = await call(
      db,
      `${h.tenantPath}/sync/pull?device_id=${deviceId}&since_seq=0`,
      { cookie },
    );
    expect(pull.status).toBe(403);
    const pushRes = await push(db, cookie, h.tenantId, deviceId, [
      {
        entity_type: "task",
        entity_id: crypto.randomUUID(),
        op: "upsert",
        base_version: 0,
        payload: { project_id: h.projectId, title: "x" },
      },
    ]);
    expect(pushRes.status).toBe(403);
  });

  it("pull pages stay ordered past seq 9", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const deviceId = await registerDevice(db, cookie);
    for (let i = 0; i < 12; i++) {
      const res = await call(db, `${h.projectPath}/tasks`, {
        method: "POST",
        cookie,
        body: { title: `タスク${i}` },
      });
      expect(res.status).toBe(201);
    }
    const pull = await call(
      db,
      `${h.tenantPath}/sync/pull?device_id=${deviceId}&since_seq=0&limit=100`,
      { cookie },
    );
    const body = (await pull.json()) as {
      changes: { seq: number }[];
      has_more: boolean;
    };
    const seqs = body.changes.map((c) => c.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(seqs.length).toBeGreaterThanOrEqual(12);
    expect(body.has_more).toBe(false);
  });

  it("pushes time entries and deletes through sync", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const deviceId = await registerDevice(db, owner.cookie);
    const taskRes = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "対象" },
    });
    const task = ((await taskRes.json()) as { task: { id: string } }).task;
    const entryId = crypto.randomUUID();
    const created = await push(db, owner.cookie, h.tenantId, deviceId, [
      {
        entity_type: "time_entry",
        entity_id: entryId,
        op: "upsert",
        base_version: 0,
        payload: {
          task_id: task.id,
          started_at: "2026-11-14T02:00:00.000Z",
          ended_at: "2026-11-14T03:00:00.000Z",
        },
      },
    ]);
    const createdBody = (await created.json()) as {
      results: { status: string }[];
    };
    expect(createdBody.results[0]?.status).toBe("applied");

    const deleted = await push(db, owner.cookie, h.tenantId, deviceId, [
      {
        entity_type: "time_entry",
        entity_id: entryId,
        op: "delete",
        base_version: 1,
      },
    ]);
    const deletedBody = (await deleted.json()) as {
      results: { status: string }[];
    };
    expect(deletedBody.results[0]?.status).toBe("applied");
    const list = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/time-entries`,
      { cookie: owner.cookie },
    );
    expect(((await list.json()) as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("requires a device for sync endpoints", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const pull = await call(db, `${h.tenantPath}/sync/pull?since_seq=0`, {
      cookie,
    });
    expect(pull.status).toBe(400);
  });
});
