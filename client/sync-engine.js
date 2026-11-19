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
      cache: "no-store",
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

  async verifyAccount() {
    const me = await this.request("/me");
    const accountId = me?.account?.id;
    if (typeof accountId !== "string") throw new Error("Current account could not be verified");
    const owner = await this.db.getMeta("sync_account_id");
    if (owner && owner !== accountId) throw new Error("Local sync storage belongs to another account; use an account-specific database");
    if (!owner) {
      const hasRows = (await Promise.all(["task","time_entry","task_dependency","milestone"].map(type=>this.db.listEntities(type)))).some(rows=>rows.length);
      if (hasRows || (await this.db.listOutbox()).length || (await this.db.listConflicts()).length || (await this.db.getMeta("sync_quarantine"))?.length) throw new Error("Existing local data has no verified owner; manual recovery required");
    }
    await this.db.setMeta("sync_account_id",accountId);
    return accountId;
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
    const owner = await this.db.getMeta("sync_account_id") ?? await this.verifyAccount();
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
    return this.db.enqueue({...change, account_id:owner});
  }

  /* ------------------------------ push ---------------------------- */

  async push(tenantId) {
    await this.pull(tenantId);
    const deviceId = await this.ensureDevice();
    const queued = await this.db.listOutbox();
    if (queued.length === 0) {
      return { applied: 0, conflicts: 0, results: [] };
    }
    const accountId = await this.verifyAccount();
    if (queued.some(row=>row.account_id !== accountId)) throw new Error("Unowned local edits require manual recovery");
    const changes = queued.map(({ id, account_id, ...change }) => change);
    const scope_token = await this.db.getMeta(`scope:${tenantId}`);
    const data = await this.request(
      `/api/v1/tenants/${tenantId}/sync/push`,
      {
        method: "POST",
        body: JSON.stringify({ device_id: deviceId, changes, protocol: 2, scope_token }),
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

  async invalidateMirror(tenantId, accountId) {
    // Preserve unsent work but never automatically replay it after an access
    // change. A host may offer explicit owner-reviewed recovery from quarantine.
    const pending = await this.db.listOutbox();
    if (pending.length) {
      const quarantine = await this.db.getMeta("sync_quarantine") ?? [];
      await this.db.setMeta("sync_quarantine", [...quarantine, {account_id:accountId, tenant_id:tenantId, changes:pending}]);
      await this.db.removeOutbox(pending.map(row=>row.id));
    }
    for (const type of ["task","time_entry","task_dependency","milestone"]) {
      for (const row of await this.db.listEntities(type)) {
        if (row.tenant_id === tenantId) await this.db.deleteEntity(type,row.id);
      }
    }
    await this.db.clearConflicts();
  }

  async quarantinedChanges() {
    const accountId = await this.verifyAccount();
    return (await this.db.getMeta("sync_quarantine") ?? []).filter(item=>item.account_id===accountId);
  }

  async pull(tenantId, { limit = 500 } = {}) {
    const accountId = await this.verifyAccount();
    const deviceId = await this.ensureDevice();
    let since = Number((await this.db.getMeta(`last_seq:${tenantId}`)) ?? 0);
    let applied = 0;
    let resets = 0;
    for (;;) {
      const scope = await this.db.getMeta(`scope:${tenantId}`) ?? "";
      const data = await this.request(
        `/api/v1/tenants/${tenantId}/sync/pull?device_id=${encodeURIComponent(deviceId)}&since_seq=${since}&limit=${limit}&protocol=2&scope_token=${encodeURIComponent(scope)}`,
      ).catch(async(error)=>{
        if(error.status===403 || error.status===404) await this.invalidateMirror(tenantId,accountId);
        throw error;
      });
      if (accountId !== await this.verifyAccount()) throw new Error("Account changed during synchronization");
      if (typeof data.scope_token !== "string") throw new Error("Sync server upgrade required");
      if (data.reset) {
        if (++resets > 3) throw new Error("Access is changing; synchronization paused");
        // The initial handshake of a verified, freshly initialized store
        // is not a permission change and must retain newly queued edits.
        if (scope) await this.invalidateMirror(tenantId,accountId);
        since = 0;
        await this.db.setMeta(`last_seq:${tenantId}`,0);
        await this.db.setMeta(`scope:${tenantId}`,data.scope_token);
        continue;
      }
      if (data.scope_token !== scope) throw new Error("Unexpected access token; synchronization paused");
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

