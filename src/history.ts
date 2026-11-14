/**
 * Task history and the trash (phase 3).
 *
 * Every task mutation appends one history row carrying the full public
 * snapshot of the task after the change, so any earlier state can be
 * restored exactly. `changes_json` records per-field from/to for the
 * fields that changed (for the encrypted description only a boolean
 * "changed" flag — ciphertext diffs are noise). Restore lives in
 * tasks.ts because it reuses the patch machinery.
 *
 * The trash lists soft-deleted tasks and time entries of a tenant.
 * Restore clears deleted_at; purge removes the row (and its dependent
 * phase-3 rows) for good and appends a final delete to the sync log.
 */
import { nowIso } from "./accounts";
import { notFound } from "./errors";
import { recordChange } from "./sync-core";
import { randomId } from "./tokens";
import type {
  Env,
  TaskHistoryRow,
  TaskRow,
  TimeEntryRow,
} from "./types";

export async function recordTaskHistory(
  env: Env,
  input: {
    tenantId: string;
    taskId: string;
    accountId: string | null;
    action: string;
    changes: Record<string, unknown>;
    snapshot: unknown;
    version: number;
  },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO task_history (id, tenant_id, task_id, account_id, action, changes_json, snapshot_json, version, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      randomId(),
      input.tenantId,
      input.taskId,
      input.accountId,
      input.action,
      JSON.stringify(input.changes),
      JSON.stringify(input.snapshot),
      input.version,
      nowIso(),
    )
    .run();
}

export function publicHistory(row: TaskHistoryRow) {
  return {
    id: row.id,
    task_id: row.task_id,
    account_id: row.account_id,
    action: row.action,
    changes: JSON.parse(row.changes_json) as Record<string, unknown>,
    snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>,
    version: Number(row.version),
    created_at: row.created_at,
  };
}

export async function listTaskHistory(
  env: Env,
  taskId: string,
): Promise<TaskHistoryRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM task_history WHERE task_id = ?1 ORDER BY created_at DESC",
  )
    .bind(taskId)
    .all<TaskHistoryRow>();
  // Stable order for equal timestamps: newest version first.
  return res.results.sort(
    (a, b) =>
      b.created_at.localeCompare(a.created_at) ||
      Number(b.version) - Number(a.version),
  );
}

export async function loadHistoryRow(
  env: Env,
  taskId: string,
  historyId: string,
): Promise<TaskHistoryRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM task_history WHERE id = ?1 AND task_id = ?2",
  )
    .bind(historyId, taskId)
    .first<TaskHistoryRow>();
  if (!row) throw notFound("History entry not found");
  return row;
}

/* ------------------------------------------------------------------ */
/* Trash                                                                */
/* ------------------------------------------------------------------ */

export async function listTrashedTasks(
  env: Env,
  tenantId: string,
): Promise<TaskRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM tasks WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<TaskRow>();
  return res.results
    .filter((r) => r.deleted_at !== null)
    .sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? ""));
}

export async function listTrashedEntries(
  env: Env,
  tenantId: string,
): Promise<TimeEntryRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM time_entries WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<TimeEntryRow>();
  return res.results
    .filter((r) => r.deleted_at !== null)
    .sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? ""));
}

export async function loadTrashedTask(
  env: Env,
  taskId: string,
): Promise<TaskRow> {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?1")
    .bind(taskId)
    .first<TaskRow>();
  if (!row || !row.deleted_at) throw notFound("Trashed task not found");
  return row;
}

export async function loadTrashedEntry(
  env: Env,
  entryId: string,
): Promise<TimeEntryRow> {
  const row = await env.DB.prepare("SELECT * FROM time_entries WHERE id = ?1")
    .bind(entryId)
    .first<TimeEntryRow>();
  if (!row || !row.deleted_at) throw notFound("Trashed time entry not found");
  return row;
}

/** Hard-delete a task and its phase-3 dependents. Irreversible. */
export async function purgeTask(
  env: Env,
  task: TaskRow,
  actorAccountId: string,
): Promise<void> {
  const dependents: [string, string][] = [
    ["task_labels", "task_id"],
    ["task_custom_values", "task_id"],
    ["task_comments", "task_id"],
    ["task_watchers", "task_id"],
    ["task_history", "task_id"],
    ["attachments", "task_id"],
    ["recurrence_rules", "task_id"],
  ];
  for (const [table, col] of dependents) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE ${col} = ?1`)
      .bind(task.id)
      .run();
  }
  // Subtasks keep living but lose their parent link.
  const subtasks = await env.DB.prepare(
    "SELECT * FROM tasks WHERE parent_task_id = ?1",
  )
    .bind(task.id)
    .all<TaskRow>();
  for (const sub of subtasks.results) {
    await env.DB.prepare("UPDATE tasks SET parent_task_id = ?1 WHERE id = ?2")
      .bind(null, sub.id)
      .run();
  }
  await env.DB.prepare("DELETE FROM tasks WHERE id = ?1").bind(task.id).run();
  await recordChange(env, {
    tenantId: task.tenant_id,
    entityType: "task",
    entityId: task.id,
    op: "delete",
    payload: null,
    accountId: actorAccountId,
  });
}

/** Hard-delete a time entry. Irreversible. */
export async function purgeEntry(
  env: Env,
  entry: TimeEntryRow,
  actorAccountId: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM time_entries WHERE id = ?1")
    .bind(entry.id)
    .run();
  await recordChange(env, {
    tenantId: entry.tenant_id,
    entityType: "time_entry",
    entityId: entry.id,
    op: "delete",
    payload: null,
    accountId: actorAccountId,
  });
}
