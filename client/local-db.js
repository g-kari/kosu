/**
 * Kosu client local database (phase 2).
 *
 * A thin store with one interface and two implementations:
 *  - IndexedDbLocalDb for browsers (durable, per-origin)
 *  - MemoryLocalDb for tests and non-browser runtimes
 *
 * Contents:
 *  - entities: the local mirror of synced entities, keyed by type + id.
 *    Records are stored exactly as the API returns them (snake_case).
 *  - outbox: queued local changes waiting to be pushed, in order.
 *  - conflicts: conflicts reported by the server during push, kept so
 *    the UI can show them (resolution UI arrives in phase 3).
 *  - meta: small key/value state (device id, per-tenant last_seq).
 */

const ENTITY_TYPES = ["task", "time_entry", "task_dependency", "milestone"];

function entityKey(type, id) {
  return `${type}:${id}`;
}

export class MemoryLocalDb {
  constructor() {
    this.entities = new Map();
    this.outbox = [];
    this.outboxSeq = 0;
    this.conflicts = new Map();
    this.meta = new Map();
  }

  async putEntity(type, record) {
    this.entities.set(entityKey(type, record.id), { ...record });
  }

  async getEntity(type, id) {
    const found = this.entities.get(entityKey(type, id));
    return found ? { ...found } : null;
  }

  async deleteEntity(type, id) {
    this.entities.delete(entityKey(type, id));
  }

  async listEntities(type) {
    const out = [];
    for (const [key, value] of this.entities) {
      if (key.startsWith(`${type}:`)) out.push({ ...value });
    }
    return out;
  }

  async enqueue(change) {
    const id = ++this.outboxSeq;
    this.outbox.push({ id, ...change });
    return id;
  }

  async listOutbox() {
    return this.outbox.map((entry) => ({ ...entry }));
  }

  async removeOutbox(ids) {
    const drop = new Set(ids);
    this.outbox = this.outbox.filter((entry) => !drop.has(entry.id));
  }

  async putConflict(record) {
    this.conflicts.set(record.id, { ...record });
  }

  async listConflicts() {
    return [...this.conflicts.values()].map((c) => ({ ...c }));
  }

  async clearConflicts() {
    this.conflicts.clear();
  }

  async getMeta(key) {
    return this.meta.has(key) ? this.meta.get(key) : null;
  }

  async setMeta(key, value) {
    this.meta.set(key, value);
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB implementation                                             */
/* ------------------------------------------------------------------ */

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTx(db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const out = run(tx);
    tx.oncomplete = () => resolve(out.value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export class IndexedDbLocalDb {
  constructor(db) {
    this.db = db;
  }

  static async open(name = "kosu") {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not available in this environment");
    }
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const handle = request.result;
        handle.createObjectStore("entities", { keyPath: "_key" });
        handle.createObjectStore("outbox", {
          keyPath: "id",
          autoIncrement: true,
        });
        handle.createObjectStore("conflicts", { keyPath: "id" });
        handle.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new IndexedDbLocalDb(db);
  }

  async putEntity(type, record) {
    const value = { ...record, _key: entityKey(type, record.id), _type: type };
    await idbTx(this.db, ["entities"], "readwrite", (tx) => {
      tx.objectStore("entities").put(value);
      return { value: undefined };
    });
  }

  async getEntity(type, id) {
    const found = await idbRequest(
      this.db
        .transaction("entities", "readonly")
        .objectStore("entities")
        .get(entityKey(type, id)),
    );
    if (!found) return null;
    const { _key, _type, ...record } = found;
    return record;
  }

  async deleteEntity(type, id) {
    await idbTx(this.db, ["entities"], "readwrite", (tx) => {
      tx.objectStore("entities").delete(entityKey(type, id));
      return { value: undefined };
    });
  }

  async listEntities(type) {
    const all = await idbRequest(
      this.db
        .transaction("entities", "readonly")
        .objectStore("entities")
        .getAll(),
    );
    return all
      .filter((row) => row._type === type)
      .map(({ _key, _type, ...record }) => record);
  }

  async enqueue(change) {
    let assigned = null;
    await idbTx(this.db, ["outbox"], "readwrite", (tx) => {
      const request = tx.objectStore("outbox").add({ ...change });
      request.onsuccess = () => {
        assigned = request.result;
      };
      return { value: undefined };
    });
    // The transaction completion resolves after onsuccess handlers run.
    const rows = await this.listOutbox();
    return assigned ?? (rows.length ? rows[rows.length - 1].id : null);
  }

  async listOutbox() {
    return idbRequest(
      this.db
        .transaction("outbox", "readonly")
        .objectStore("outbox")
        .getAll(),
    );
  }

  async removeOutbox(ids) {
    await idbTx(this.db, ["outbox"], "readwrite", (tx) => {
      const store = tx.objectStore("outbox");
      for (const id of ids) store.delete(id);
      return { value: undefined };
    });
  }

  async putConflict(record) {
    await idbTx(this.db, ["conflicts"], "readwrite", (tx) => {
      tx.objectStore("conflicts").put({ ...record });
      return { value: undefined };
    });
  }

  async listConflicts() {
    return idbRequest(
      this.db
        .transaction("conflicts", "readonly")
        .objectStore("conflicts")
        .getAll(),
    );
  }

  async clearConflicts() {
    await idbTx(this.db, ["conflicts"], "readwrite", (tx) => {
      tx.objectStore("conflicts").clear();
      return { value: undefined };
    });
  }

  async getMeta(key) {
    const row = await idbRequest(
      this.db.transaction("meta", "readonly").objectStore("meta").get(key),
    );
    return row ? row.value : null;
  }

  async setMeta(key, value) {
    await idbTx(this.db, ["meta"], "readwrite", (tx) => {
      tx.objectStore("meta").put({ key, value });
      return { value: undefined };
    });
  }
}

/** Open the best available local DB: IndexedDB in browsers, memory elsewhere. */
export async function openLocalDb(name = "kosu") {
  if (typeof indexedDB !== "undefined") {
    return IndexedDbLocalDb.open(name);
  }
  return new MemoryLocalDb();
}

export { ENTITY_TYPES };
