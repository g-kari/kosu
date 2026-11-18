/**
 * Sync conflict inspection and resolution (phase 3).
 *
 * Phase 2 recorded losing pushes in sync_conflicts with both payloads
 * and let the server copy win by default. This module adds the human
 * step: a field-by-field diff of the two payloads, and a resolve
 * operation — keep the server copy (the default outcome, just closes
 * the conflict) or adopt the client copy (applied on top of the current
 * server state as a fresh change, so versions keep moving forward and
 * the change log stays truthful).
 */
import { guardSyncEntity } from "./sync-access";
import { nowIso } from "./accounts";
import { badRequest, notFound } from "./errors";
import { dispatchNotifications } from "./notify";
import {
  applyEntryPatch,
  applyMilestonePatch,
  applyTaskPatch,
  loadEntryAny,
  loadMilestoneAny,
  loadTaskAny,
  parseEntryInput,
  parseMilestoneInput,
  parseTaskInput,
  softDeleteEntry,
  softDeleteMilestone,
  softDeleteTask,
} from "./tasks";
import type {
  Env,
  Principal,
  SyncConflictRow,
} from "./types";

export interface ConflictDiff {
  field: string;
  server: unknown;
  client: unknown;
  differs: boolean;
}

export function diffPayloads(
  serverPayload: Record<string, unknown> | null,
  clientPayload: Record<string, unknown> | null,
): ConflictDiff[] {
  const server = serverPayload ?? {};
  const client = clientPayload ?? {};
  const fields = [...new Set([...Object.keys(server), ...Object.keys(client)])]
    .filter((f) => f !== "version")
    .sort();
  return fields.map((field) => {
    const s = server[field] ?? null;
    const cl = client[field] ?? null;
    return {
      field,
      server: s,
      client: cl,
      differs: JSON.stringify(s) !== JSON.stringify(cl),
    };
  });
}

export function publicConflict(row: SyncConflictRow, withDiff = false) {
  const serverPayload = row.server_payload
    ? (JSON.parse(row.server_payload) as Record<string, unknown>)
    : null;
  const clientPayload = row.client_payload
    ? (JSON.parse(row.client_payload) as Record<string, unknown>)
    : null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    server_version: Number(row.server_version),
    client_base_version: Number(row.client_base_version),
    server_payload: serverPayload,
    client_payload: clientPayload,
    ...(withDiff ? { diff: diffPayloads(serverPayload, clientPayload) } : {}),
    account_id: row.account_id,
    device_id: row.device_id,
    status: row.status,
    resolution: row.resolution,
    resolved_by: row.resolved_by_account_id,
    resolved_at: row.resolved_at,
    created_at: row.created_at,
  };
}

export async function loadConflict(
  env: Env,
  tenantId: string,
  conflictId: string,
): Promise<SyncConflictRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM sync_conflicts WHERE id = ?1 AND tenant_id = ?2",
  )
    .bind(conflictId, tenantId)
    .first<SyncConflictRow>();
  if (!row) throw notFound("Sync conflict not found");
  return row;
}

export async function resolveConflict(
  env: Env,
  principal: Principal,
  row: SyncConflictRow,
  choice: "server" | "client",
): Promise<SyncConflictRow> {
  await guardSyncEntity(env, principal, row.tenant_id, row.entity_type, row.entity_id, "write");
  if (row.status !== "open") {
    throw badRequest("This conflict is already resolved");
  }
  if (choice === "client") {
    await applyClientPayload(env, principal, row);
  }
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE sync_conflicts SET status = ?1, resolution = ?2, resolved_by_account_id = ?3, resolved_at = ?4 WHERE id = ?5",
  )
    .bind("resolved", choice, principal.accountId, now, row.id)
    .run();
  if (row.account_id && row.account_id !== principal.accountId) {
    await dispatchNotifications(env, {
      kind: "sync_conflict",
      tenantId: row.tenant_id,
      actorAccountId: principal.accountId,
      recipientIds: [row.account_id],
      title:
        choice === "client"
          ? "同期の競合があなたの変更を採用して解決されました"
          : "同期の競合がサーバー側を採用して解決されました",
      payload: { conflict_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id, resolution: choice },
      relatedType: "sync_conflict",
      relatedId: row.id,
    });
  }
  return {
    ...row,
    status: "resolved",
    resolution: choice,
    resolved_by_account_id: principal.accountId,
    resolved_at: now,
  };
}

/**
 * Apply the client payload on top of the current server entity. A null
 * client payload means the client pushed a delete.
 */
async function applyClientPayload(
  env: Env,
  principal: Principal,
  row: SyncConflictRow,
): Promise<void> {
  const clientPayload = row.client_payload
    ? (JSON.parse(row.client_payload) as Record<string, unknown>)
    : null;
  const { access } = await guardSyncEntity(env, principal, row.tenant_id, row.entity_type, row.entity_id, "write");
  const source = { accountId: principal.accountId, admin: access.admin };
  switch (row.entity_type) {
    case "task": {
      const current = await loadTaskAny(env, row.entity_id);
      if (!current) throw notFound("Task no longer exists");
      if (!clientPayload) {
        if (!current.deleted_at) await softDeleteTask(env, current, source);
        return;
      }
      await applyTaskPatch(
        env,
        current,
        parseTaskInput(clientPayload, true),
        source,
      );
      return;
    }
    case "time_entry": {
      const current = await loadEntryAny(env, row.entity_id);
      if (!current) throw notFound("Time entry no longer exists");
      if (!clientPayload) {
        if (!current.deleted_at) await softDeleteEntry(env, current, source);
        return;
      }
      await applyEntryPatch(
        env,
        current,
        parseEntryInput(clientPayload, true),
        source,
      );
      return;
    }
    case "milestone": {
      const current = await loadMilestoneAny(env, row.entity_id);
      if (!current) throw notFound("Milestone no longer exists");
      if (!clientPayload) {
        if (!current.deleted_at) {
          await softDeleteMilestone(env, current, source);
        }
        return;
      }
      await applyMilestonePatch(
        env,
        current,
        parseMilestoneInput(clientPayload, true),
        source,
      );
      return;
    }
    default:
      throw badRequest(
        `Conflicts of type "${row.entity_type}" cannot adopt the client copy`,
      );
  }
}

/** Tenant admins get notified when a new conflict is recorded. */
export async function notifyConflictRecorded(
  env: Env,
  tenantId: string,
  conflict: { id: string; entity_type: string; entity_id: string },
  adminIds: string[],
): Promise<void> {
  await dispatchNotifications(env, {
    kind: "sync_conflict",
    tenantId,
    recipientIds: adminIds,
    title: "同期の競合が発生しました",
    payload: {
      conflict_id: conflict.id,
      entity_type: conflict.entity_type,
      entity_id: conflict.entity_id,
    },
    relatedType: "sync_conflict",
    relatedId: conflict.id,
  });
}

