import { describe, expect, it } from "vitest";
import { MemoryLocalDb, openLocalDb } from "../client/local-db.js";
import { SyncEngine } from "../client/sync-engine.js";

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

describe("MemoryLocalDb", () => {
  it("stores entities, outbox entries and meta", async () => {
    const db = new MemoryLocalDb();
    await db.putEntity("task", { id: "t1", title: "A", version: 1 });
    expect((await db.getEntity("task", "t1")).title).toBe("A");
    expect(await db.listEntities("task")).toHaveLength(1);
    expect(await db.listEntities("milestone")).toHaveLength(0);

    const id = await db.enqueue({
      entity_type: "task",
      entity_id: "t1",
      op: "upsert",
      base_version: 1,
      payload: { id: "t1", title: "B" },
    });
    expect(await db.listOutbox()).toHaveLength(1);
    await db.removeOutbox([id]);
    expect(await db.listOutbox()).toHaveLength(0);

    await db.setMeta("device_id", "dev-1");
    expect(await db.getMeta("device_id")).toBe("dev-1");
    expect(await db.getMeta("missing")).toBeNull();
  });

  it("openLocalDb falls back to memory without IndexedDB", async () => {
    const db = await openLocalDb("kosu-test");
    expect(db).toBeInstanceOf(MemoryLocalDb);
  });
});

describe("SyncEngine", () => {
  function makeEngine(fetchFn) {
    return new SyncEngine({ db: new MemoryLocalDb(), fetchFn });
  }

  it("registers a device, pushes a queued change and bumps the local version", async () => {
    const calls = [];
    const engine = makeEngine(async (path, opts) => {
      calls.push({ path, opts });
      if (path === "/api/v1/sync/devices") {
        return jsonResponse(201, { device: { id: "dev-1", name: "x" } });
      }
      if (path.endsWith("/sync/push")) {
        const body = JSON.parse(opts.body);
        expect(body.device_id).toBe("dev-1");
        return jsonResponse(200, {
          results: body.changes.map((ch) => ({
            entity_type: ch.entity_type,
            entity_id: ch.entity_id,
            status: "applied",
            version: ch.base_version + 1,
          })),
          last_seq: 1,
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    await engine.db.putEntity("task", { id: "t1", title: "A", version: 0 });
    await engine.queueChange({
      entity_type: "task",
      entity_id: "t1",
      op: "upsert",
      base_version: 0,
      payload: { id: "t1", title: "A", version: 0 },
    });
    const result = await engine.push("tenant-1");
    expect(result.applied).toBe(1);
    expect(result.conflicts).toBe(0);
    expect((await engine.db.getEntity("task", "t1")).version).toBe(1);
    expect(await engine.db.listOutbox()).toHaveLength(0);
    expect(calls.map((c) => c.path)).toContain("/api/v1/sync/devices");
  });

  it("applies the server copy and records the conflict on a stale push", async () => {
    const engine = makeEngine(async (path, opts) => {
      if (path === "/api/v1/sync/devices") {
        return jsonResponse(201, { device: { id: "dev-1" } });
      }
      if (path.endsWith("/sync/push")) {
        return jsonResponse(200, {
          results: [
            {
              entity_type: "task",
              entity_id: "t1",
              status: "conflict",
              server_version: 3,
              server_payload: { id: "t1", title: "サーバー版", version: 3 },
            },
          ],
          last_seq: 5,
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    await engine.queueChange({
      entity_type: "task",
      entity_id: "t1",
      op: "upsert",
      base_version: 1,
      payload: { id: "t1", title: "古い版", version: 1 },
    });
    const result = await engine.push("tenant-1");
    expect(result.conflicts).toBe(1);
    expect((await engine.db.getEntity("task", "t1")).title).toBe("サーバー版");
    expect(await engine.db.listConflicts()).toHaveLength(1);
    expect(await engine.db.listOutbox()).toHaveLength(0);
  });

  it("pulls changes in pages and tracks last_seq via next_since", async () => {
    const engine = makeEngine(async (path) => {
      if (path === "/api/v1/sync/devices") {
        return jsonResponse(201, { device: { id: "dev-1" } });
      }
      if (path.includes("/sync/pull")) {
        if (path.includes("since_seq=0")) {
          return jsonResponse(200, {
            changes: [
              { seq: 1, entity_type: "task", entity_id: "t1", op: "upsert", payload: { id: "t1", title: "A", version: 1 } },
              { seq: 2, entity_type: "task", entity_id: "t2", op: "upsert", payload: { id: "t2", title: "B", version: 1 } },
            ],
            next_since: 2,
            last_seq: 3,
            has_more: true,
          });
        }
        return jsonResponse(200, {
          changes: [
            { seq: 3, entity_type: "task", entity_id: "t3", op: "upsert", payload: { id: "t3", title: "C", version: 1 } },
          ],
          next_since: 3,
          last_seq: 3,
          has_more: false,
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const pulled = await engine.pull("tenant-1", { limit: 2 });
    expect(pulled.applied).toBe(3);
    expect(pulled.last_seq).toBe(3);
    expect(await engine.db.listEntities("task")).toHaveLength(3);
  });
});
