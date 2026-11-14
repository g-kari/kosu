/**
 * Tasks, time entries, timers, dependencies and milestones (phase 2 core).
 *
 * Bodies (task description, entry note) travel as `*_enc` ciphertext: the
 * client encrypts with the account key before anything is sent, and this
 * layer treats the values as opaque strings. Titles and schedule metadata
 * stay plaintext because lists, the Gantt chart and aggregates need them.
 *
 * Every mutation appends to the sync change log (src/sync-core.ts) so
 * local-first clients can pull what changed. Timers: at most one running
 * entry per account per tenant; anything past 12 hours is flagged
 * `long_running` for the UI warning.
 */
import { nowIso } from "./accounts";
import { recordAudit } from "./audit";
import { ApiError, badRequest, conflict, notFound } from "./errors";
import { cleanName } from "./hierarchy";
import { recordChange } from "./sync-core";
import { isDateString, roundSeconds, secondsBetween, weekStart, localDayRangeUtc } from "./timecalc";
import { resolveRounding } from "./settings";
import { randomId } from "./tokens";
import type {
  Env,
  MilestoneRow,
  Principal,
  ProjectRow,
  TaskDependencyRow,
  TaskRow,
  TimeEntryRow,
} from "./types";

export const LONG_RUNNING_THRESHOLD_SECONDS = 12 * 60 * 60;

/* ------------------------------------------------------------------ */
/* Serializers                                                          */
/* ------------------------------------------------------------------ */

export function publicTask(row: TaskRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    team_id: row.team_id,
    project_id: row.project_id,
    parent_task_id: row.parent_task_id,
    title: row.title,
    description_enc: row.description_enc,
    status: row.status,
    assignee_account_id: row.assignee_account_id,
    start_date: row.start_date,
    due_date: row.due_date,
    sort_order: Number(row.sort_order),
    estimate_minutes:
      row.estimate_minutes === null ? null : Number(row.estimate_minutes),
    version: Number(row.version),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

export type PublicTask = ReturnType<typeof publicTask>;

export function entryDurationSeconds(
  row: TimeEntryRow,
  now: string,
): number {
  if (row.duration_seconds !== null) return Number(row.duration_seconds);
  if (row.ended_at) return secondsBetween(row.started_at, row.ended_at);
  return secondsBetween(row.started_at, now);
}

export function publicEntry(row: TimeEntryRow, now: string = nowIso()) {
  const running = row.ended_at === null;
  const duration = entryDurationSeconds(row, now);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    task_id: row.task_id,
    account_id: row.account_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_seconds: duration,
    running,
    note_enc: row.note_enc,
    long_running:
      row.long_running === 1 || duration > LONG_RUNNING_THRESHOLD_SECONDS,
    version: Number(row.version),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

export type PublicEntry = ReturnType<typeof publicEntry>;

export function publicDependency(row: TaskDependencyRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    task_id: row.task_id,
    depends_on_task_id: row.depends_on_task_id,
    version: Number(row.version),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

export function publicMilestone(row: MilestoneRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    name: row.name,
    date: row.date,
    version: Number(row.version),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

/* ------------------------------------------------------------------ */
/* Input parsing (shared by REST bodies and sync payloads)              */
/* ------------------------------------------------------------------ */

function optionalEnc(input: unknown, field: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || input.length > 128 * 1024) {
    throw badRequest(`"${field}" must be an encrypted string (<= 128 KiB)`);
  }
  return input;
}

function optionalDateField(input: unknown, field: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (!isDateString(input)) {
    throw badRequest(`"${field}" must be a YYYY-MM-DD date`);
  }
  return input;
}

function optionalInstant(input: unknown, field: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input))) {
    throw badRequest(`"${field}" must be an ISO 8601 timestamp`);
  }
  return new Date(Date.parse(input)).toISOString();
}

function optionalId(input: unknown, field: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || input.length > 200) {
    throw badRequest(`"${field}" must be an id string`);
  }
  return input;
}

function optionalInt(
  input: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (input === undefined || input === null) return null;
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < min ||
    input > max
  ) {
    throw badRequest(`"${field}" must be an integer ${min}-${max}`);
  }
  return input;
}

export interface TaskInput {
  title: string;
  descriptionEnc: string | null;
  status: string;
  assigneeAccountId: string | null;
  parentTaskId: string | null;
  startDate: string | null;
  dueDate: string | null;
  sortOrder: number;
  estimateMinutes: number | null;
}

export function parseTaskInput(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<TaskInput> {
  const out: Partial<TaskInput> = {};
  if (!partial || body["title"] !== undefined) {
    const title = body["title"];
    if (typeof title !== "string" || title.trim().length < 1 || title.trim().length > 300) {
      throw badRequest('"title" must be 1-300 characters');
    }
    out.title = title.trim();
  }
  if (body["description_enc"] !== undefined) {
    out.descriptionEnc = optionalEnc(body["description_enc"], "description_enc");
  }
  if (body["status"] !== undefined) {
    const status = body["status"];
    if (typeof status !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(status)) {
      throw badRequest('"status" must be a short slug (todo, doing, done, ...)');
    }
    out.status = status;
  }
  if (body["assignee_account_id"] !== undefined) {
    out.assigneeAccountId = optionalId(
      body["assignee_account_id"],
      "assignee_account_id",
    );
  }
  if (body["parent_task_id"] !== undefined) {
    out.parentTaskId = optionalId(body["parent_task_id"], "parent_task_id");
  }
  if (body["start_date"] !== undefined) {
    out.startDate = optionalDateField(body["start_date"], "start_date");
  }
  if (body["due_date"] !== undefined) {
    out.dueDate = optionalDateField(body["due_date"], "due_date");
  }
  if (body["sort_order"] !== undefined) {
    out.sortOrder = optionalInt(body["sort_order"], "sort_order", -1_000_000, 1_000_000) ?? 0;
  }
  if (body["estimate_minutes"] !== undefined) {
    out.estimateMinutes = optionalInt(
      body["estimate_minutes"],
      "estimate_minutes",
      0,
      525_600,
    );
  }
  return out;
}

export interface EntryInput {
  taskId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  noteEnc: string | null;
}

export function parseEntryInput(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<EntryInput> {
  const out: Partial<EntryInput> = {};
  if (body["task_id"] !== undefined) {
    out.taskId = optionalId(body["task_id"], "task_id");
  }
  if (!partial || body["started_at"] !== undefined) {
    const started = optionalInstant(body["started_at"], "started_at");
    if (!started) throw badRequest('"started_at" is required');
    out.startedAt = started;
  }
  if (body["ended_at"] !== undefined) {
    out.endedAt = optionalInstant(body["ended_at"], "ended_at");
  }
  if (body["duration_seconds"] !== undefined) {
    out.durationSeconds = optionalInt(
      body["duration_seconds"],
      "duration_seconds",
      0,
      31_536_000,
    );
  }
  if (body["note_enc"] !== undefined) {
    out.noteEnc = optionalEnc(body["note_enc"], "note_enc");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Loaders                                                              */
/* ------------------------------------------------------------------ */

export async function loadTask(
  env: Env,
  projectId: string,
  taskId: string,
): Promise<TaskRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM tasks WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL",
  )
    .bind(taskId, projectId)
    .first<TaskRow>();
  if (!row) throw notFound("Task not found");
  return row;
}

export async function loadTaskAny(
  env: Env,
  taskId: string,
): Promise<TaskRow | null> {
  return env.DB.prepare("SELECT * FROM tasks WHERE id = ?1")
    .bind(taskId)
    .first<TaskRow>();
}

export async function loadEntry(
  env: Env,
  entryId: string,
): Promise<TimeEntryRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM time_entries WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(entryId)
    .first<TimeEntryRow>();
  if (!row) throw notFound("Time entry not found");
  return row;
}

async function assertAssigneeIsMember(
  env: Env,
  tenantId: string,
  assigneeAccountId: string | null,
): Promise<void> {
  if (!assigneeAccountId) return;
  const row = await env.DB.prepare(
    "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
  )
    .bind(tenantId, assigneeAccountId)
    .first<{ account_id: string }>();
  if (!row) throw badRequest("Assignee is not a member of this tenant");
}

async function assertParentValid(
  env: Env,
  projectId: string,
  parentTaskId: string | null,
  selfTaskId?: string,
): Promise<void> {
  if (!parentTaskId) return;
  if (selfTaskId && parentTaskId === selfTaskId) {
    throw badRequest("A task cannot be its own parent");
  }
  const parent = await env.DB.prepare(
    "SELECT id FROM tasks WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL",
  )
    .bind(parentTaskId, projectId)
    .first<{ id: string }>();
  if (!parent) throw badRequest("Parent task is not in this project");
}

/* ------------------------------------------------------------------ */
/* Tasks                                                                */
/* ------------------------------------------------------------------ */

export interface ChangeSource {
  accountId: string;
  deviceId?: string | null;
}

export async function insertTask(
  env: Env,
  project: ProjectRow,
  input: TaskInput,
  source: ChangeSource,
  id?: string,
): Promise<TaskRow> {
  await assertAssigneeIsMember(env, project.tenant_id, input.assigneeAccountId);
  await assertParentValid(env, project.id, input.parentTaskId, id);
  const now = nowIso();
  const row: TaskRow = {
    id: id ?? randomId(),
    tenant_id: project.tenant_id,
    workspace_id: project.workspace_id,
    team_id: project.team_id,
    project_id: project.id,
    parent_task_id: input.parentTaskId,
    title: input.title,
    description_enc: input.descriptionEnc,
    status: input.status,
    assignee_account_id: input.assigneeAccountId,
    start_date: input.startDate,
    due_date: input.dueDate,
    sort_order: input.sortOrder,
    estimate_minutes: input.estimateMinutes,
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO tasks (id, tenant_id, workspace_id, team_id, project_id, parent_task_id, title, description_enc, status, assignee_account_id, start_date, due_date, sort_order, estimate_minutes, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
  )
    .bind(
      row.id, row.tenant_id, row.workspace_id, row.team_id, row.project_id,
      row.parent_task_id, row.title, row.description_enc, row.status,
      row.assignee_account_id, row.start_date, row.due_date, row.sort_order,
      row.estimate_minutes, row.version, now, now,
    )
    .run();
  await recordChange(env, {
    tenantId: row.tenant_id,
    entityType: "task",
    entityId: row.id,
    op: "upsert",
    payload: publicTask(row),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return row;
}

export async function applyTaskPatch(
  env: Env,
  current: TaskRow,
  patch: Partial<TaskInput>,
  source: ChangeSource,
): Promise<TaskRow> {
  const next: TaskRow = {
    ...current,
    title: patch.title ?? current.title,
    description_enc:
      patch.descriptionEnc !== undefined
        ? patch.descriptionEnc
        : current.description_enc,
    status: patch.status ?? current.status,
    assignee_account_id:
      patch.assigneeAccountId !== undefined
        ? patch.assigneeAccountId
        : current.assignee_account_id,
    parent_task_id:
      patch.parentTaskId !== undefined
        ? patch.parentTaskId
        : current.parent_task_id,
    start_date:
      patch.startDate !== undefined ? patch.startDate : current.start_date,
    due_date: patch.dueDate !== undefined ? patch.dueDate : current.due_date,
    sort_order:
      patch.sortOrder !== undefined ? patch.sortOrder : current.sort_order,
    estimate_minutes:
      patch.estimateMinutes !== undefined
        ? patch.estimateMinutes
        : current.estimate_minutes,
    version: Number(current.version) + 1,
    updated_at: nowIso(),
    deleted_at: current.deleted_at,
  };
  await assertAssigneeIsMember(env, next.tenant_id, next.assignee_account_id);
  if (next.project_id) {
    await assertParentValid(env, next.project_id, next.parent_task_id, next.id);
  }
  await env.DB.prepare(
    "UPDATE tasks SET title = ?1, description_enc = ?2, status = ?3, assignee_account_id = ?4, parent_task_id = ?5, start_date = ?6, due_date = ?7, sort_order = ?8, estimate_minutes = ?9, version = ?10, updated_at = ?11 WHERE id = ?12",
  )
    .bind(
      next.title, next.description_enc, next.status, next.assignee_account_id,
      next.parent_task_id, next.start_date, next.due_date, next.sort_order,
      next.estimate_minutes, next.version, next.updated_at, next.id,
    )
    .run();
  await recordChange(env, {
    tenantId: next.tenant_id,
    entityType: "task",
    entityId: next.id,
    op: next.deleted_at ? "delete" : "upsert",
    payload: publicTask(next),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return next;
}

export async function softDeleteTask(
  env: Env,
  current: TaskRow,
  source: ChangeSource,
): Promise<TaskRow> {
  const next: TaskRow = {
    ...current,
    version: Number(current.version) + 1,
    updated_at: nowIso(),
    deleted_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE tasks SET version = ?1, updated_at = ?2, deleted_at = ?3 WHERE id = ?4",
  )
    .bind(next.version, next.updated_at, next.deleted_at, next.id)
    .run();
  await recordChange(env, {
    tenantId: next.tenant_id,
    entityType: "task",
    entityId: next.id,
    op: "delete",
    payload: publicTask(next),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return next;
}

export async function listTasks(
  env: Env,
  projectId: string,
): Promise<TaskRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY sort_order ASC",
  )
    .bind(projectId)
    .all<TaskRow>();
  return res.results.sort(
    (a, b) =>
      Number(a.sort_order) - Number(b.sort_order) ||
      a.created_at.localeCompare(b.created_at),
  );
}

/* ------------------------------------------------------------------ */
/* Time entries and timers                                              */
/* ------------------------------------------------------------------ */

function finalizeEntryTimes(input: {
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}): { endedAt: string | null; durationSeconds: number | null } {
  let { endedAt, durationSeconds } = input;
  if (endedAt && durationSeconds === null) {
    durationSeconds = secondsBetween(input.startedAt, endedAt);
  }
  if (!endedAt && durationSeconds !== null) {
    endedAt = new Date(
      Date.parse(input.startedAt) + durationSeconds * 1000,
    ).toISOString();
  }
  if (endedAt && endedAt < input.startedAt) {
    throw badRequest('"ended_at" must not be before "started_at"');
  }
  return { endedAt, durationSeconds };
}

export async function insertEntry(
  env: Env,
  input: {
    tenantId: string;
    workspaceId: string;
    taskId: string | null;
    accountId: string;
    startedAt: string;
    endedAt: string | null;
    durationSeconds: number | null;
    noteEnc: string | null;
  },
  source: ChangeSource,
  id?: string,
): Promise<TimeEntryRow> {
  const times = finalizeEntryTimes(input);
  const now = nowIso();
  const duration = times.durationSeconds ?? 0;
  const row: TimeEntryRow = {
    id: id ?? randomId(),
    tenant_id: input.tenantId,
    workspace_id: input.workspaceId,
    task_id: input.taskId,
    account_id: input.accountId,
    started_at: input.startedAt,
    ended_at: times.endedAt,
    duration_seconds: times.durationSeconds,
    note_enc: input.noteEnc,
    version: 1,
    long_running:
      times.endedAt && duration > LONG_RUNNING_THRESHOLD_SECONDS ? 1 : 0,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO time_entries (id, tenant_id, workspace_id, task_id, account_id, started_at, ended_at, duration_seconds, note_enc, version, long_running, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
  )
    .bind(
      row.id, row.tenant_id, row.workspace_id, row.task_id, row.account_id,
      row.started_at, row.ended_at, row.duration_seconds, row.note_enc,
      row.version, row.long_running, now, now,
    )
    .run();
  await recordChange(env, {
    tenantId: row.tenant_id,
    entityType: "time_entry",
    entityId: row.id,
    op: "upsert",
    payload: publicEntry(row),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return row;
}

export async function applyEntryPatch(
  env: Env,
  current: TimeEntryRow,
  patch: Partial<EntryInput>,
  source: ChangeSource,
): Promise<TimeEntryRow> {
  const startedAt = patch.startedAt ?? current.started_at;
  const endedAt =
    patch.endedAt !== undefined ? patch.endedAt : current.ended_at;
  const durationSeconds =
    patch.durationSeconds !== undefined
      ? patch.durationSeconds
      : patch.startedAt !== undefined || patch.endedAt !== undefined
        ? null
        : current.duration_seconds;
  const times = finalizeEntryTimes({ startedAt, endedAt, durationSeconds });
  const next: TimeEntryRow = {
    ...current,
    task_id: patch.taskId !== undefined ? patch.taskId : current.task_id,
    started_at: startedAt,
    ended_at: times.endedAt,
    duration_seconds: times.durationSeconds,
    note_enc: patch.noteEnc !== undefined ? patch.noteEnc : current.note_enc,
    long_running:
      times.endedAt &&
      (times.durationSeconds ?? 0) > LONG_RUNNING_THRESHOLD_SECONDS
        ? 1
        : 0,
    version: Number(current.version) + 1,
    updated_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE time_entries SET task_id = ?1, started_at = ?2, ended_at = ?3, duration_seconds = ?4, note_enc = ?5, long_running = ?6, version = ?7, updated_at = ?8 WHERE id = ?9",
  )
    .bind(
      next.task_id, next.started_at, next.ended_at, next.duration_seconds,
      next.note_enc, next.long_running, next.version, next.updated_at, next.id,
    )
    .run();
  await recordChange(env, {
    tenantId: next.tenant_id,
    entityType: "time_entry",
    entityId: next.id,
    op: next.deleted_at ? "delete" : "upsert",
    payload: publicEntry(next),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return next;
}

export async function softDeleteEntry(
  env: Env,
  current: TimeEntryRow,
  source: ChangeSource,
): Promise<TimeEntryRow> {
  const next: TimeEntryRow = {
    ...current,
    version: Number(current.version) + 1,
    updated_at: nowIso(),
    deleted_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE time_entries SET version = ?1, updated_at = ?2, deleted_at = ?3 WHERE id = ?4",
  )
    .bind(next.version, next.updated_at, next.deleted_at, next.id)
    .run();
  await recordChange(env, {
    tenantId: next.tenant_id,
    entityType: "time_entry",
    entityId: next.id,
    op: "delete",
    payload: publicEntry(next),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return next;
}

export async function loadEntryAny(
  env: Env,
  entryId: string,
): Promise<TimeEntryRow | null> {
  return env.DB.prepare("SELECT * FROM time_entries WHERE id = ?1")
    .bind(entryId)
    .first<TimeEntryRow>();
}

/** The account's currently running entry in a tenant, if any. */
export async function findRunningEntry(
  env: Env,
  tenantId: string,
  accountId: string,
): Promise<TimeEntryRow | null> {
  const res = await env.DB.prepare(
    "SELECT * FROM time_entries WHERE tenant_id = ?1 AND account_id = ?2 AND deleted_at IS NULL",
  )
    .bind(tenantId, accountId)
    .all<TimeEntryRow>();
  return res.results.find((r) => r.ended_at === null) ?? null;
}

export async function startTimer(
  env: Env,
  principal: Principal,
  input: { tenantId: string; workspaceId: string; taskId: string | null },
): Promise<TimeEntryRow> {
  const running = await findRunningEntry(
    env,
    input.tenantId,
    principal.accountId,
  );
  if (running) {
    throw conflict(
      "TIMER_RUNNING",
      `Another timer is already running (${running.id})`,
    );
  }
  return insertEntry(
    env,
    {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      accountId: principal.accountId,
      startedAt: nowIso(),
      endedAt: null,
      durationSeconds: null,
      noteEnc: null,
    },
    { accountId: principal.accountId },
  );
}

export async function stopTimer(
  env: Env,
  principal: Principal,
  tenantId: string,
): Promise<TimeEntryRow> {
  const running = await findRunningEntry(env, tenantId, principal.accountId);
  if (!running) throw conflict("TIMER_NOT_RUNNING", "No timer is running");
  const now = nowIso();
  const duration = secondsBetween(running.started_at, now);
  const next: TimeEntryRow = {
    ...running,
    ended_at: now,
    duration_seconds: duration,
    long_running: duration > LONG_RUNNING_THRESHOLD_SECONDS ? 1 : 0,
    version: Number(running.version) + 1,
    updated_at: now,
  };
  await env.DB.prepare(
    "UPDATE time_entries SET ended_at = ?1, duration_seconds = ?2, long_running = ?3, version = ?4, updated_at = ?5 WHERE id = ?6",
  )
    .bind(
      next.ended_at, next.duration_seconds, next.long_running, next.version,
      next.updated_at, next.id,
    )
    .run();
  await recordChange(env, {
    tenantId,
    entityType: "time_entry",
    entityId: next.id,
    op: "upsert",
    payload: publicEntry(next),
    accountId: principal.accountId,
  });
  return next;
}

export async function listEntriesForTask(
  env: Env,
  taskId: string,
): Promise<TimeEntryRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM time_entries WHERE task_id = ?1 AND deleted_at IS NULL ORDER BY started_at ASC",
  )
    .bind(taskId)
    .all<TimeEntryRow>();
  return res.results;
}

export async function listEntriesForAccount(
  env: Env,
  tenantId: string,
  accountId: string,
): Promise<TimeEntryRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM time_entries WHERE tenant_id = ?1 AND account_id = ?2 AND deleted_at IS NULL ORDER BY started_at ASC",
  )
    .bind(tenantId, accountId)
    .all<TimeEntryRow>();
  return res.results;
}

/* ------------------------------------------------------------------ */
/* Dependencies and milestones                                          */
/* ------------------------------------------------------------------ */

export async function listDependencies(
  env: Env,
  projectId: string,
): Promise<TaskDependencyRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM task_dependencies WHERE project_id = ?1 AND deleted_at IS NULL",
  )
    .bind(projectId)
    .all<TaskDependencyRow>();
  return res.results;
}

/** Would adding taskId -> dependsOnId close a cycle? Follows depends-on edges. */
export function createsCycle(
  edges: { task_id: string; depends_on_task_id: string }[],
  taskId: string,
  dependsOnId: string,
): boolean {
  const byTask = new Map<string, string[]>();
  for (const e of edges) {
    const list = byTask.get(e.task_id) ?? [];
    list.push(e.depends_on_task_id);
    byTask.set(e.task_id, list);
  }
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of byTask.get(cur) ?? []) stack.push(next);
  }
  return false;
}

export async function insertDependency(
  env: Env,
  project: ProjectRow,
  taskId: string,
  dependsOnId: string,
  source: ChangeSource,
  id?: string,
): Promise<TaskDependencyRow> {
  if (taskId === dependsOnId) {
    throw badRequest("A task cannot depend on itself");
  }
  await loadTask(env, project.id, taskId);
  await loadTask(env, project.id, dependsOnId);
  const existing = await listDependencies(env, project.id);
  if (
    existing.some(
      (d) => d.task_id === taskId && d.depends_on_task_id === dependsOnId,
    )
  ) {
    throw conflict("DEPENDENCY_EXISTS", "This dependency already exists");
  }
  if (createsCycle(existing, taskId, dependsOnId)) {
    throw new ApiError(
      400,
      "DEPENDENCY_CYCLE",
      "This dependency would create a cycle",
    );
  }
  const now = nowIso();
  const row: TaskDependencyRow = {
    id: id ?? randomId(),
    tenant_id: project.tenant_id,
    workspace_id: project.workspace_id,
    project_id: project.id,
    task_id: taskId,
    depends_on_task_id: dependsOnId,
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO task_dependencies (id, tenant_id, workspace_id, project_id, task_id, depends_on_task_id, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      row.id, row.tenant_id, row.workspace_id, row.project_id, row.task_id,
      row.depends_on_task_id, row.version, now, now,
    )
    .run();
  await recordChange(env, {
    tenantId: row.tenant_id,
    entityType: "task_dependency",
    entityId: row.id,
    op: "upsert",
    payload: publicDependency(row),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return row;
}

export async function loadDependencyAny(
  env: Env,
  dependencyId: string,
): Promise<TaskDependencyRow | null> {
  return env.DB.prepare("SELECT * FROM task_dependencies WHERE id = ?1")
    .bind(dependencyId)
    .first<TaskDependencyRow>();
}

export async function softDeleteDependency(
  env: Env,
  current: TaskDependencyRow,
  source: ChangeSource,
): Promise<TaskDependencyRow> {
  const next: TaskDependencyRow = {
    ...current,
    version: Number(current.version) + 1,
    updated_at: nowIso(),
    deleted_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE task_dependencies SET version = ?1, updated_at = ?2, deleted_at = ?3 WHERE id = ?4",
  )
    .bind(next.version, next.updated_at, next.deleted_at, next.id)
    .run();
  await recordChange(env, {
    tenantId: next.tenant_id,
    entityType: "task_dependency",
    entityId: next.id,
    op: "delete",
    payload: publicDependency(next),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return next;
}

export async function listMilestones(
  env: Env,
  projectId: string,
): Promise<MilestoneRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM milestones WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY date ASC",
  )
    .bind(projectId)
    .all<MilestoneRow>();
  return res.results.sort((a, b) => a.date.localeCompare(b.date));
}

export async function insertMilestone(
  env: Env,
  project: ProjectRow,
  input: { name: string; date: string },
  source: ChangeSource,
  id?: string,
): Promise<MilestoneRow> {
  const now = nowIso();
  const row: MilestoneRow = {
    id: id ?? randomId(),
    tenant_id: project.tenant_id,
    workspace_id: project.workspace_id,
    project_id: project.id,
    name: input.name,
    date: input.date,
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO milestones (id, tenant_id, workspace_id, project_id, name, date, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      row.id, row.tenant_id, row.workspace_id, row.project_id, row.name,
      row.date, row.version, now, now,
    )
    .run();
  await recordChange(env, {
    tenantId: row.tenant_id,
    entityType: "milestone",
    entityId: row.id,
    op: "upsert",
    payload: publicMilestone(row),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return row;
}

export async function loadMilestoneAny(
  env: Env,
  milestoneId: string,
): Promise<MilestoneRow | null> {
  return env.DB.prepare("SELECT * FROM milestones WHERE id = ?1")
    .bind(milestoneId)
    .first<MilestoneRow>();
}

export async function applyMilestonePatch(
  env: Env,
  current: MilestoneRow,
  patch: { name?: string; date?: string },
  source: ChangeSource,
): Promise<MilestoneRow> {
  const next: MilestoneRow = {
    ...current,
    name: patch.name ?? current.name,
    date: patch.date ?? current.date,
    version: Number(current.version) + 1,
    updated_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE milestones SET name = ?1, date = ?2, version = ?3, updated_at = ?4 WHERE id = ?5",
  )
    .bind(next.name, next.date, next.version, next.updated_at, next.id)
    .run();
  await recordChange(env, {
    tenantId: next.tenant_id,
    entityType: "milestone",
    entityId: next.id,
    op: next.deleted_at ? "delete" : "upsert",
    payload: publicMilestone(next),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return next;
}

export async function softDeleteMilestone(
  env: Env,
  current: MilestoneRow,
  source: ChangeSource,
): Promise<MilestoneRow> {
  const next: MilestoneRow = {
    ...current,
    version: Number(current.version) + 1,
    updated_at: nowIso(),
    deleted_at: nowIso(),
  };
  await env.DB.prepare(
    "UPDATE milestones SET version = ?1, updated_at = ?2, deleted_at = ?3 WHERE id = ?4",
  )
    .bind(next.version, next.updated_at, next.deleted_at, next.id)
    .run();
  await recordChange(env, {
    tenantId: next.tenant_id,
    entityType: "milestone",
    entityId: next.id,
    op: "delete",
    payload: publicMilestone(next),
    accountId: source.accountId,
    deviceId: source.deviceId ?? null,
  });
  return next;
}

export function parseMilestoneInput(
  body: Record<string, unknown>,
  partial: boolean,
): { name?: string; date?: string } {
  const out: { name?: string; date?: string } = {};
  if (!partial || body["name"] !== undefined) {
    out.name = cleanName(body["name"]);
  }
  if (!partial || body["date"] !== undefined) {
    const date = optionalDateField(body["date"], "date");
    if (!date) throw badRequest('"date" is required');
    out.date = date;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Estimates vs actuals                                                 */
/* ------------------------------------------------------------------ */

export async function estimateVsActual(
  env: Env,
  project: ProjectRow,
  now: string = nowIso(),
) {
  const tasks = await listTasks(env, project.id);
  const rounding = await resolveRounding(
    env,
    project.tenant_id,
    project.workspace_id,
  );
  const rows = [];
  let totalEstimate = 0;
  let totalActual = 0;
  let totalRounded = 0;
  for (const task of tasks) {
    const entries = await listEntriesForTask(env, task.id);
    let actual = 0;
    let rounded = 0;
    for (const entry of entries) {
      const seconds = entryDurationSeconds(entry, now);
      actual += seconds;
      rounded += roundSeconds(seconds, rounding.minutes, rounding.mode);
    }
    const estimate =
      task.estimate_minutes === null ? null : Number(task.estimate_minutes);
    if (estimate !== null) totalEstimate += estimate;
    totalActual += actual;
    totalRounded += rounded;
    rows.push({
      task_id: task.id,
      title: task.title,
      status: task.status,
      estimate_minutes: estimate,
      actual_seconds: actual,
      actual_rounded_seconds: rounded,
      over_estimate:
        estimate !== null && actual > estimate * 60,
    });
  }
  return {
    project_id: project.id,
    rounding,
    tasks: rows,
    totals: {
      estimate_minutes: totalEstimate,
      actual_seconds: totalActual,
      actual_rounded_seconds: totalRounded,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                            */
/* ------------------------------------------------------------------ */

/**
 * Personal dashboard for one tenant: my time today and this week
 * (attributed by entry start, in the caller's local date/timezone), my
 * running timer, and my in-progress tasks.
 */
export async function dashboard(
  env: Env,
  principal: Principal,
  tenantId: string,
  localDate: string,
  tzOffsetMinutes: number,
  now: string = nowIso(),
) {
  const entries = await listEntriesForAccount(
    env,
    tenantId,
    principal.accountId,
  );
  // Rounding resolves per entry workspace (workspace override wins).
  const roundingCache = new Map<string, { minutes: number; mode: "nearest" | "up" | "down" }>();
  const roundingFor = async (workspaceId: string) => {
    let r = roundingCache.get(workspaceId);
    if (!r) {
      r = await resolveRounding(env, tenantId, workspaceId);
      roundingCache.set(workspaceId, r);
    }
    return r;
  };
  const day = localDayRangeUtc(localDate, tzOffsetMinutes);
  const weekFrom = weekStart(localDate);
  const week = localDayRangeUtc(weekFrom, tzOffsetMinutes);
  const weekEnd = new Date(
    Date.parse(week.start) + 7 * 24 * 60 * 60_000,
  ).toISOString();

  let todaySeconds = 0;
  let todayRounded = 0;
  let weekSeconds = 0;
  let weekRounded = 0;
  let running: TimeEntryRow | null = null;
  for (const entry of entries) {
    const seconds = entryDurationSeconds(entry, now);
    const entryRounding = await roundingFor(entry.workspace_id);
    const rounded = roundSeconds(seconds, entryRounding.minutes, entryRounding.mode);
    if (entry.started_at >= day.start && entry.started_at < day.end) {
      todaySeconds += seconds;
      todayRounded += rounded;
    }
    if (entry.started_at >= week.start && entry.started_at < weekEnd) {
      weekSeconds += seconds;
      weekRounded += rounded;
    }
    if (entry.ended_at === null) running = entry;
  }

  const taskRes = await env.DB.prepare(
    "SELECT * FROM tasks WHERE tenant_id = ?1 AND assignee_account_id = ?2 AND status = ?3 AND deleted_at IS NULL",
  )
    .bind(tenantId, principal.accountId, "doing")
    .all<TaskRow>();
  const doing = taskRes.results
    .sort(
      (a, b) =>
        Number(a.sort_order) - Number(b.sort_order) ||
        a.created_at.localeCompare(b.created_at),
    )
    .slice(0, 50);

  return {
    date: localDate,
    week_start: weekFrom,
    today: { seconds: todaySeconds, rounded_seconds: todayRounded },
    week: { seconds: weekSeconds, rounded_seconds: weekRounded },
    running_entry: running ? publicEntry(running, now) : null,
    doing_tasks: doing.map(publicTask),
  };
}

