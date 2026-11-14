/**
 * Server side of the local-first sync change log.
 *
 * Every mutation of a syncable entity — whether it arrives through the
 * REST API or through a sync push — appends one row to sync_changes with
 * the next per-tenant sequence number, so any client can catch up with
 * `GET .../sync/pull?since_seq=N`. The serialized payload is the entity's
 * public shape; client-encrypted fields stay ciphertext end to end.
 */
import { nowIso } from "./accounts";
import type { Env } from "./types";

export const SYNC_ENTITY_TYPES = [
  "task",
  "time_entry",
  "task_dependency",
  "milestone",
] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export function isSyncEntityType(value: unknown): value is SyncEntityType {
  return (
    typeof value === "string" &&
    (SYNC_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

export interface ChangeRecord {
  tenant_id: string;
  seq: number;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string | null;
  account_id: string | null;
  device_id: string | null;
  created_at: string;
}

/** Current last_seq for a tenant (0 when nothing was ever recorded). */
export async function lastSeq(env: Env, tenantId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT last_seq FROM sync_counters WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<{ last_seq: number }>();
  return row ? Number(row.last_seq) : 0;
}

/**
 * Append a change and return its seq. The counter read-modify-write is
 * not atomic across concurrent requests; a lost race can only produce a
 * duplicate seq rejected by the (tenant_id, seq) primary key, which the
 * caller surfaces as an error rather than silent corruption.
 */
export async function recordChange(
  env: Env,
  input: {
    tenantId: string;
    entityType: SyncEntityType;
    entityId: string;
    op: "upsert" | "delete";
    payload: unknown;
    accountId?: string | null;
    deviceId?: string | null;
  },
): Promise<number> {
  const existing = await env.DB.prepare(
    "SELECT last_seq FROM sync_counters WHERE tenant_id = ?1",
  )
    .bind(input.tenantId)
    .first<{ last_seq: number }>();
  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO sync_counters (tenant_id, last_seq) VALUES (?1, ?2)",
    )
      .bind(input.tenantId, 0)
      .run();
  }
  const seq = Number(existing?.last_seq ?? 0) + 1;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE sync_counters SET last_seq = ?1 WHERE tenant_id = ?2",
    ).bind(seq, input.tenantId),
    env.DB.prepare(
      "INSERT INTO sync_changes (tenant_id, seq, entity_type, entity_id, op, payload, account_id, device_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    ).bind(
      input.tenantId,
      seq,
      input.entityType,
      input.entityId,
      input.op,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.accountId ?? null,
      input.deviceId ?? null,
      now,
    ),
  ]);
  return seq;
}

/** Changes after `sinceSeq`, oldest first, capped by `limit` in memory. */
export async function pullChanges(
  env: Env,
  tenantId: string,
  sinceSeq: number,
  limit: number,
): Promise<{ changes: ChangeRecord[]; lastSeq: number; hasMore: boolean }> {
  const res = await env.DB.prepare(
    "SELECT * FROM sync_changes WHERE tenant_id = ?1 AND seq > ?2 ORDER BY seq ASC",
  )
    .bind(tenantId, sinceSeq)
    .all<ChangeRecord>();
  const all = res.results;
  return {
    changes: all.slice(0, limit),
    lastSeq: await lastSeq(env, tenantId),
    hasMore: all.length > limit,
  };
}
