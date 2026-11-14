/**
 * Tenant usage accounting and limits (phase 5 item 11).
 *
 * Usage = accepted members, live tasks and stored attachment bytes.
 * Limits are opt-in rows in tenant_limits; a NULL column means that
 * dimension is unlimited. Reaching a limit rejects the creating call
 * with 422 (limit_exceeded).
 */

import { ApiError } from "./errors";
import { nowIso } from "./accounts";
import { tenantMemberIds } from "./members";
import type { Env, TenantLimitsRow } from "./types";

export interface TenantUsage {
  members: number;
  tasks: number;
  attachment_bytes: number;
}

export interface TenantLimits {
  max_members: number | null;
  max_tasks: number | null;
  max_attachment_bytes: number | null;
}

export async function getTenantUsage(
  env: Env,
  tenantId: string,
): Promise<TenantUsage> {
  const memberIds = await tenantMemberIds(env, tenantId);

  const tasks = await env.DB.prepare(
    "SELECT id FROM tasks WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<{ id: string }>();

  const attachments = await env.DB.prepare(
    "SELECT size_bytes FROM attachments WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<{ size_bytes: number }>();
  let bytes = 0;
  for (const a of attachments.results ?? []) bytes += Number(a.size_bytes) || 0;

  return {
    members: memberIds.length,
    tasks: (tasks.results ?? []).length,
    attachment_bytes: bytes,
  };
}

export async function getTenantLimits(
  env: Env,
  tenantId: string,
): Promise<TenantLimits> {
  const row = await env.DB.prepare(
    "SELECT * FROM tenant_limits WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<TenantLimitsRow>();
  if (!row) {
    return { max_members: null, max_tasks: null, max_attachment_bytes: null };
  }
  return {
    max_members: row.max_members === null ? null : Number(row.max_members),
    max_tasks: row.max_tasks === null ? null : Number(row.max_tasks),
    max_attachment_bytes:
      row.max_attachment_bytes === null
        ? null
        : Number(row.max_attachment_bytes),
  };
}

export async function saveTenantLimits(
  env: Env,
  tenantId: string,
  limits: TenantLimits,
): Promise<TenantLimits> {
  const now = nowIso();
  const existing = await env.DB.prepare(
    "SELECT tenant_id FROM tenant_limits WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<{ tenant_id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE tenant_limits SET max_members = ?1, max_tasks = ?2, max_attachment_bytes = ?3, updated_at = ?4 WHERE tenant_id = ?5",
    )
      .bind(
        limits.max_members,
        limits.max_tasks,
        limits.max_attachment_bytes,
        now,
        tenantId,
      )
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO tenant_limits (tenant_id, max_members, max_tasks, max_attachment_bytes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(
        tenantId,
        limits.max_members,
        limits.max_tasks,
        limits.max_attachment_bytes,
        now,
      )
      .run();
  }
  return limits;
}

/**
 * Reject the current operation when the tenant is at (or over) the
 * limit for the given resource. `incomingBytes` counts a pending
 * attachment upload against the byte limit.
 */
export async function assertWithinLimits(
  env: Env,
  tenantId: string,
  kind: "member" | "task" | "attachment",
  incomingBytes = 0,
): Promise<void> {
  const limits = await getTenantLimits(env, tenantId);
  const limit =
    kind === "member"
      ? limits.max_members
      : kind === "task"
        ? limits.max_tasks
        : limits.max_attachment_bytes;
  if (limit === null) return;
  const usage = await getTenantUsage(env, tenantId);
  const current =
    kind === "member"
      ? usage.members
      : kind === "task"
        ? usage.tasks
        : usage.attachment_bytes + incomingBytes;
  if (current >= limit) {
    throw new ApiError(
      422,
      "limit_exceeded",
      `Tenant limit reached for ${kind} (limit: ${limit})`,
    );
  }
}
