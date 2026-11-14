/**
 * Kosu sync engine (phase 2).
 *
 * Local-first flow against the server's change-log API:
 *  - Local edits are applied to the local DB immediately and queued in
 *    the outbox (see queueChange).
 *  - push() sends the outbox in order. The server applies changes whose
 *    base_version matches; on a mismatch the server copy wins, the
 *    local record is overwritten with the server payload, and the
 *    conflict is stored locally and counted in status().
 *  - pull() fetches the tenant change log since the stored last_seq and
 *    mirrors every change into the local DB, newest state included.
 *  - status() merges the server view (last_seq, open conflicts, device
 *    list) with local counts (pending outbox entries).
 *
 * The host app provides fetch (authenticated by session cookie) via the
 * constructor; tests inject a stub.
 */

export class SyncEngine {
  constructor({ db, fetchFn, baseUrl = "" }) {
    if (!db) throw new Error("SyncEngine requires a local db");
    this.db = db;
    this.fetchFn =
      fetchFn ??
      ((path, opts) => fetch(path, { credentials: "same-origin", ...opts }));
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request(path, opts = {}) {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      headers: { "content-type": "application/json" },
      ...opts,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data?.error?.message ?? `sync request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    return data;
  }

  /* ------------------------------ devices ------------------------- */

  async deviceId() {
    return this.db.getMeta("device_id");
  }

  async registerDevice(name = "Web browser", platform = "web") {
    const data = await this.request("/api/v1/sync/devices", {
      method: "POST",
      body: JSON.stringify({ name, platform }),
    });
    await this.db.setMeta("device_id", data.device.id);
    return data.device;
  }

  async ensureDevice(name, platform) {
    const existing = await this.deviceId();
    if (existing) return existing;
    const device = await this.registerDevice(name, platform);
    return device.id;
  }

  async listDevices() {
    const data = await this.request("/api/v1/sync/devices");
    return data.devices;
  }

  async revokeDevice(deviceId) {
    await this.request(
      `/api/v1/sync/devices/${encodeURIComponent(deviceId)}`,
      { method: "DELETE" },
    );
    if ((await this.deviceId()) === deviceId) {
      await this.db.setMeta("device_id", null);
    }
  }

  /* ------------------------------ local edits --------------------- */

  /**
   * Apply a local edit: store the record locally right away and queue
   * the change for the next push.
   * change: { entity_type, entity_id, op: "upsert"|"delete",
   *           base_version, payload }
   */
  async queueChange(change) {
    if (change.op === "upsert" && change.payload) {
      await this.db.putEntity(change.entity_type, {
        ...change.payload,
        id: change.entity_id,
      });
    }
    if (change.op === "delete") {
      const current = await this.db.getEntity(
        change.entity_type,
        change.entity_id,
      );
      if (current) {
        await this.db.putEntity(change.entity_type, {
          ...current,
          deleted_at: new Date().toISOString(),
        });
      }
    }
    return this.db.enqueue(change);
  }

  /* ------------------------------ push ---------------------------- */

  async push(tenantId) {
    const deviceId = await this.ensureDevice();
    const queued = await this.db.listOutbox();
    if (queued.length === 0) {
      return { applied: 0, conflicts: 0, results: [] };
    }
    const changes = queued.map(({ id, ...change }) => change);
    const data = await this.request(
      `/api/v1/tenants/${tenantId}/sync/push`,
      {
        method: "POST",
        body: JSON.stringify({ device_id: deviceId, changes }),
      },
    );
    let applied = 0;
    let conflicts = 0;
    const consumed = [];
    for (let i = 0; i < data.results.length; i++) {
      const result = data.results[i];
      const queuedEntry = queued[i];
      if (!queuedEntry) break;
      consumed.push(queuedEntry.id);
      if (result.status === "applied") {
        applied++;
        const local = await this.db.getEntity(
          result.entity_type,
          result.entity_id,
        );
        if (local && typeof result.version === "number") {
          await this.db.putEntity(result.entity_type, {
            ...local,
            version: result.version,
          });
        }
      } else if (result.status === "conflict") {
        conflicts++;
        // Server wins: overwrite the local record with the server copy.
        if (result.server_payload) {
          await this.db.putEntity(result.entity_type, result.server_payload);
        }
        await this.db.putConflict({
          id: `${result.entity_type}:${result.entity_id}:${result.server_version}`,
          entity_type: result.entity_type,
          entity_id: result.entity_id,
          server_version: result.server_version,
          server_payload: result.server_payload ?? null,
          client_payload: queuedEntry.payload ?? null,
          detected_at: new Date().toISOString(),
        });
      }
    }
    await this.db.removeOutbox(consumed);
    return { applied, conflicts, results: data.results };
  }

  /* ------------------------------ pull ---------------------------- */

  async pull(tenantId, { limit = 500 } = {}) {
    const deviceId = await this.ensureDevice();
    let since = Number((await this.db.getMeta(`last_seq:${tenantId}`)) ?? 0);
    let applied = 0;
    for (;;) {
      const data = await this.request(
        `/api/v1/tenants/${tenantId}/sync/pull?device_id=${encodeURIComponent(deviceId)}&since_seq=${since}&limit=${limit}`,
      );
      for (const change of data.changes) {
        if (change.payload) {
          await this.db.putEntity(change.entity_type, change.payload);
        } else if (change.op === "delete") {
          await this.db.deleteEntity(change.entity_type, change.entity_id);
        }
        applied++;
      }
      since = typeof data.next_since === "number" ? data.next_since : data.last_seq;
      await this.db.setMeta(`last_seq:${tenantId}`, since);
      if (!data.has_more) break;
    }
    return { applied, last_seq: since };
  }

  /* ------------------------------ status -------------------------- */

  async status(tenantId) {
    const deviceId = await this.ensureDevice();
    const server = await this.request(
      `/api/v1/tenants/${tenantId}/sync/status?device_id=${encodeURIComponent(deviceId)}`,
    );
    const outbox = await this.db.listOutbox();
    const localConflicts = await this.db.listConflicts();
    return {
      tenant_id: tenantId,
      pending_changes: outbox.length,
      local_conflicts: localConflicts.length,
      server_last_seq: server.last_seq,
      local_last_seq:
        Number((await this.db.getMeta(`last_seq:${tenantId}`)) ?? 0),
      server_open_conflicts: server.open_conflicts,
      devices: server.devices,
      server_time: server.server_time,
    };
  }

  /** Full round: push local edits, pull remote changes, report status. */
  async sync(tenantId) {
    const pushed = await this.push(tenantId);
    const pulled = await this.pull(tenantId);
    const status = await this.status(tenantId);
    return { pushed, pulled, status };
  }
}
