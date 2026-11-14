/**
 * Task attachments (phase 3): bytes live in R2, metadata in D1.
 *
 * The R2 key is namespaced per tenant/task and never guessable beyond
 * the random attachment id. Downloads always go through the API so the
 * caller's project read access is checked; there are no public URLs.
 */
import { nowIso } from "./accounts";
import { badRequest, notFound } from "./errors";
import { randomId } from "./tokens";
import type { AttachmentRow, Env } from "./types";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB

export function publicAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    account_id: row.account_id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    created_at: row.created_at,
  };
}

export function attachmentKey(
  tenantId: string,
  taskId: string,
  attachmentId: string,
): string {
  return `att/${tenantId}/${taskId}/${attachmentId}`;
}

export async function createAttachment(
  env: Env,
  input: {
    tenantId: string;
    taskId: string;
    accountId: string;
    filename: string;
    contentType: string | null;
    bytes: Uint8Array;
  },
): Promise<AttachmentRow> {
  if (input.bytes.length === 0) {
    throw badRequest("Attachment body is empty");
  }
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw badRequest(
      `Attachment is too large (max ${MAX_ATTACHMENT_BYTES} bytes)`,
    );
  }
  const filename = input.filename.trim();
  if (filename.length < 1 || filename.length > 200) {
    throw badRequest('"filename" must be 1-200 characters');
  }
  const id = randomId();
  const key = attachmentKey(input.tenantId, input.taskId, id);
  await env.FILES.put(key, input.bytes, {
    httpMetadata: { contentType: input.contentType ?? undefined },
  });
  const row: AttachmentRow = {
    id,
    tenant_id: input.tenantId,
    task_id: input.taskId,
    account_id: input.accountId,
    filename,
    content_type: input.contentType,
    size_bytes: input.bytes.length,
    r2_key: key,
    created_at: nowIso(),
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO attachments (id, tenant_id, task_id, account_id, filename, content_type, size_bytes, r2_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      row.id, row.tenant_id, row.task_id, row.account_id, row.filename,
      row.content_type, row.size_bytes, row.r2_key, row.created_at,
    )
    .run();
  return row;
}

export async function listAttachments(
  env: Env,
  taskId: string,
): Promise<AttachmentRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM attachments WHERE task_id = ?1 AND deleted_at IS NULL",
  )
    .bind(taskId)
    .all<AttachmentRow>();
  return res.results.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function loadAttachment(
  env: Env,
  attachmentId: string,
): Promise<AttachmentRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM attachments WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(attachmentId)
    .first<AttachmentRow>();
  if (!row) throw notFound("Attachment not found");
  return row;
}

export async function readAttachmentBytes(
  env: Env,
  row: AttachmentRow,
): Promise<Uint8Array> {
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) throw notFound("Attachment content is missing");
  return new Uint8Array(await obj.arrayBuffer());
}

export async function deleteAttachment(
  env: Env,
  row: AttachmentRow,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE attachments SET deleted_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), row.id)
    .run();
  await env.FILES.delete(row.r2_key);
}
