/**
 * Task comments and watchers (phase 3).
 *
 * Comment bodies are client-encrypted (`body_enc`), exactly like task
 * descriptions: the server stores ciphertext and can never read it.
 * Consequences, by design:
 *  - mentions are supplied by the client as account ids and validated
 *    against tenant membership here;
 *  - comment text is not server-searchable (client-side search only).
 *
 * Watchers subscribe to task updates. Commenting auto-watches the
 * author; assignment does not (the assignee is notified through the
 * task_assigned / comment fan-out regardless).
 */
import { nowIso } from "./accounts";
import { badRequest, notFound } from "./errors";
import { dispatchNotifications } from "./notify";
import { randomId } from "./tokens";
import type { Env, Principal, TaskCommentRow, TaskRow } from "./types";

export function publicComment(row: TaskCommentRow) {
  let mentions: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.mentions_json);
    if (Array.isArray(parsed)) mentions = parsed as string[];
  } catch {
    mentions = [];
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    account_id: row.account_id,
    body_enc: row.body_enc,
    mentions,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

export function parseCommentBody(
  body: Record<string, unknown>,
): { bodyEnc: string; mentions: string[] } {
  const bodyEnc = body["body_enc"];
  if (
    typeof bodyEnc !== "string" ||
    bodyEnc.length < 1 ||
    bodyEnc.length > 128 * 1024
  ) {
    throw badRequest('"body_enc" must be an encrypted string (<= 128 KiB)');
  }
  let mentions: string[] = [];
  if (body["mentions"] !== undefined) {
    const raw = body["mentions"];
    if (
      !Array.isArray(raw) ||
      raw.length > 50 ||
      raw.some((m) => typeof m !== "string")
    ) {
      throw badRequest('"mentions" must be an array of up to 50 account ids');
    }
    mentions = [...new Set(raw as string[])];
  }
  return { bodyEnc, mentions };
}

/** Every mentioned id must belong to the tenant; returns valid ids. */
export async function validateMentions(
  env: Env,
  tenantId: string,
  mentions: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of mentions) {
    const row = await env.DB.prepare(
      "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
    )
      .bind(tenantId, id)
      .first<{ account_id: string }>();
    if (!row) throw badRequest(`Mentioned account ${id} is not a tenant member`);
    out.push(id);
  }
  return out;
}

export async function listComments(
  env: Env,
  taskId: string,
): Promise<TaskCommentRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM task_comments WHERE task_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC",
  )
    .bind(taskId)
    .all<TaskCommentRow>();
  return res.results.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function loadComment(
  env: Env,
  taskId: string,
  commentId: string,
): Promise<TaskCommentRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM task_comments WHERE id = ?1 AND task_id = ?2 AND deleted_at IS NULL",
  )
    .bind(commentId, taskId)
    .first<TaskCommentRow>();
  if (!row) throw notFound("Comment not found");
  return row;
}

export async function createComment(
  env: Env,
  principal: Principal,
  task: TaskRow,
  bodyEnc: string,
  mentions: string[],
): Promise<TaskCommentRow> {
  const now = nowIso();
  const row: TaskCommentRow = {
    id: randomId(),
    tenant_id: task.tenant_id,
    task_id: task.id,
    account_id: principal.accountId,
    body_enc: bodyEnc,
    mentions_json: JSON.stringify(mentions),
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO task_comments (id, tenant_id, task_id, account_id, body_enc, mentions_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      row.id, row.tenant_id, row.task_id, row.account_id, row.body_enc,
      row.mentions_json, now, now,
    )
    .run();
  // Commenting subscribes the author to further updates.
  await addWatcher(env, task, principal.accountId);
  // Fan-out: mentions get a dedicated kind; watchers and the assignee
  // get the generic comment notification.
  if (mentions.length > 0) {
    await dispatchNotifications(env, {
      kind: "mention",
      tenantId: task.tenant_id,
      actorAccountId: principal.accountId,
      recipientIds: mentions,
      title: `「${task.title}」のコメントでメンションされました`,
      payload: { task_id: task.id, comment_id: row.id },
      relatedType: "task",
      relatedId: task.id,
    });
  }
  const watchers = await listWatcherIds(env, task.id);
  const others = watchers.filter((id) => !mentions.includes(id));
  if (task.assignee_account_id && !others.includes(task.assignee_account_id)) {
    others.push(task.assignee_account_id);
  }
  await dispatchNotifications(env, {
    kind: "comment",
    tenantId: task.tenant_id,
    actorAccountId: principal.accountId,
    recipientIds: others,
    title: `「${task.title}」にコメントが付きました`,
    payload: { task_id: task.id, comment_id: row.id },
    relatedType: "task",
    relatedId: task.id,
  });
  return row;
}

export async function updateComment(
  env: Env,
  current: TaskCommentRow,
  bodyEnc: string,
  mentions: string[],
): Promise<TaskCommentRow> {
  const next: TaskCommentRow = {
    ...current,
    body_enc: bodyEnc,
    mentions_json: JSON.stringify(mentions),
    updated_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE task_comments SET body_enc = ?1, mentions_json = ?2, updated_at = ?3 WHERE id = ?4",
  )
    .bind(next.body_enc, next.mentions_json, next.updated_at, next.id)
    .run();
  return next;
}

export async function deleteComment(
  env: Env,
  current: TaskCommentRow,
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE task_comments SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(now, now, current.id)
    .run();
}

/* ------------------------------------------------------------------ */
/* Watchers                                                             */
/* ------------------------------------------------------------------ */

export async function listWatcherIds(
  env: Env,
  taskId: string,
): Promise<string[]> {
  const res = await env.DB.prepare(
    "SELECT account_id FROM task_watchers WHERE task_id = ?1",
  )
    .bind(taskId)
    .all<{ account_id: string }>();
  return res.results.map((r) => r.account_id);
}

export async function addWatcher(
  env: Env,
  task: TaskRow,
  accountId: string,
): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT task_id FROM task_watchers WHERE task_id = ?1 AND account_id = ?2",
  )
    .bind(task.id, accountId)
    .first<{ task_id: string }>();
  if (existing) return;
  await env.DB.prepare(
    "INSERT INTO task_watchers (task_id, account_id, tenant_id, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(task.id, accountId, task.tenant_id, nowIso())
    .run();
}

export async function removeWatcher(
  env: Env,
  taskId: string,
  accountId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM task_watchers WHERE task_id = ?1 AND account_id = ?2",
  )
    .bind(taskId, accountId)
    .run();
}

export async function isWatching(
  env: Env,
  taskId: string,
  accountId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT task_id FROM task_watchers WHERE task_id = ?1 AND account_id = ?2",
  )
    .bind(taskId, accountId)
    .first<{ task_id: string }>();
  return row !== null;
}
