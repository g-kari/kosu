/**
 * Planning helpers (phase 3): recurrence rule management, task
 * templates, task duplication and recently-viewed items.
 *
 * The recurrence *spawn* itself lives in tasks.ts (it hooks into the
 * task patch path); this module owns the rule CRUD and validation.
 * Templates store a blueprint as JSON: a root task plus subtasks, with
 * dates expressed as day offsets from an instantiation base date.
 */
import { nowIso } from "./accounts";
import { badRequest, notFound } from "./errors";
import { attachLabel, labelsOfTask } from "./labels";
import {
  insertTask,
  listTasks,
  type TaskInput,
} from "./tasks";
import { addDays, isDateString } from "./timecalc";
import { randomId } from "./tokens";
import type {
  Env,
  Principal,
  ProjectRow,
  RecurrenceRuleRow,
  TaskRow,
  TaskTemplateRow,
} from "./types";

/* ------------------------------------------------------------------ */
/* Recurrence rules                                                     */
/* ------------------------------------------------------------------ */

export interface RecurrenceInput {
  freq: "daily" | "weekly" | "monthly";
  interval: number;
  byWeekdays: number[] | null;
  endDate: string | null;
  maxCount: number | null;
}

export function parseRecurrenceInput(
  body: Record<string, unknown>,
): RecurrenceInput {
  const freq = body["freq"];
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly") {
    throw badRequest('"freq" must be daily, weekly or monthly');
  }
  const interval = body["interval"] ?? 1;
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 365
  ) {
    throw badRequest('"interval" must be an integer 1-365');
  }
  let byWeekdays: number[] | null = null;
  if (body["by_weekdays"] !== undefined && body["by_weekdays"] !== null) {
    const raw = body["by_weekdays"];
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.some(
        (n) => typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 7,
      )
    ) {
      throw badRequest('"by_weekdays" must be ISO weekdays (1-7)');
    }
    byWeekdays = [...new Set(raw as number[])].sort((a, b) => a - b);
  }
  let endDate: string | null = null;
  if (body["end_date"] !== undefined && body["end_date"] !== null) {
    if (!isDateString(body["end_date"])) {
      throw badRequest('"end_date" must be a YYYY-MM-DD date');
    }
    endDate = body["end_date"];
  }
  let maxCount: number | null = null;
  if (body["max_count"] !== undefined && body["max_count"] !== null) {
    const raw = body["max_count"];
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < 1 ||
      raw > 10000
    ) {
      throw badRequest('"max_count" must be an integer 1-10000');
    }
    maxCount = raw;
  }
  return { freq, interval, byWeekdays, endDate, maxCount };
}

export function publicRecurrence(row: RecurrenceRuleRow) {
  let byWeekdays: number[] | null = null;
  if (row.by_weekday_json) {
    try {
      const parsed: unknown = JSON.parse(row.by_weekday_json);
      if (Array.isArray(parsed)) byWeekdays = parsed as number[];
    } catch {
      byWeekdays = null;
    }
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    freq: row.freq,
    interval: Number(row.interval_count),
    by_weekdays: byWeekdays,
    end_date: row.end_date,
    max_count: row.max_count === null ? null : Number(row.max_count),
    generated_count: Number(row.generated_count),
    active: row.active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getRecurrenceRule(
  env: Env,
  taskId: string,
): Promise<RecurrenceRuleRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM recurrence_rules WHERE task_id = ?1",
  )
    .bind(taskId)
    .first<RecurrenceRuleRow>();
  return row ?? null;
}

/** Create or replace the rule for a task (one rule per task). */
export async function putRecurrenceRule(
  env: Env,
  principal: Principal,
  task: TaskRow,
  input: RecurrenceInput,
): Promise<RecurrenceRuleRow> {
  const now = nowIso();
  const existing = await getRecurrenceRule(env, task.id);
  if (existing) {
    await env.DB.prepare(
      "UPDATE recurrence_rules SET freq = ?1, interval_count = ?2, by_weekday_json = ?3, end_date = ?4, max_count = ?5, active = ?6, updated_at = ?7 WHERE id = ?8",
    )
      .bind(
        input.freq,
        input.interval,
        input.byWeekdays ? JSON.stringify(input.byWeekdays) : null,
        input.endDate,
        input.maxCount,
        1,
        now,
        existing.id,
      )
      .run();
    return {
      ...existing,
      freq: input.freq,
      interval_count: input.interval,
      by_weekday_json: input.byWeekdays
        ? JSON.stringify(input.byWeekdays)
        : null,
      end_date: input.endDate,
      max_count: input.maxCount,
      active: 1,
      updated_at: now,
    };
  }
  const row: RecurrenceRuleRow = {
    id: randomId(),
    tenant_id: task.tenant_id,
    task_id: task.id,
    freq: input.freq,
    interval_count: input.interval,
    by_weekday_json: input.byWeekdays
      ? JSON.stringify(input.byWeekdays)
      : null,
    end_date: input.endDate,
    max_count: input.maxCount,
    generated_count: 0,
    active: 1,
    created_by_account_id: principal.accountId,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO recurrence_rules (id, tenant_id, task_id, freq, interval_count, by_weekday_json, end_date, max_count, generated_count, active, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
  )
    .bind(
      row.id, row.tenant_id, row.task_id, row.freq, row.interval_count,
      row.by_weekday_json, row.end_date, row.max_count, 0, 1,
      row.created_by_account_id, now, now,
    )
    .run();
  return row;
}

export async function deleteRecurrenceRule(
  env: Env,
  taskId: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM recurrence_rules WHERE task_id = ?1")
    .bind(taskId)
    .run();
}

/* ------------------------------------------------------------------ */
/* Templates                                                            */
/* ------------------------------------------------------------------ */

export interface TemplateTask {
  title: string;
  description_enc?: string | null;
  status?: string;
  priority?: string;
  start_offset_days?: number | null;
  due_offset_days?: number | null;
  estimate_minutes?: number | null;
  subtasks?: TemplateTask[];
}

function validateTemplateTask(raw: unknown, path: string): TemplateTask {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw badRequest(`template ${path} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const title = r["title"];
  if (typeof title !== "string" || title.trim().length < 1 || title.length > 300) {
    throw badRequest(`template ${path}.title must be 1-300 characters`);
  }
  const out: TemplateTask = { title: title.trim() };
  for (const key of ["description_enc"] as const) {
    const v = r[key];
    if (v !== undefined && v !== null && typeof v !== "string") {
      throw badRequest(`template ${path}.${key} must be a string`);
    }
    out[key] = (v as string | null) ?? null;
  }
  for (const key of ["status", "priority"] as const) {
    const v = r[key];
    if (v !== undefined && v !== null) {
      if (typeof v !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(v)) {
        throw badRequest(`template ${path}.${key} must be a slug`);
      }
      out[key] = v;
    }
  }
  for (const key of ["start_offset_days", "due_offset_days", "estimate_minutes"] as const) {
    const v = r[key];
    if (v !== undefined && v !== null) {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        throw badRequest(`template ${path}.${key} must be an integer`);
      }
      out[key] = v;
    }
  }
  if (r["subtasks"] !== undefined) {
    if (!Array.isArray(r["subtasks"]) || r["subtasks"].length > 50) {
      throw badRequest(`template ${path}.subtasks must be an array (max 50)`);
    }
    out.subtasks = r["subtasks"].map((s, i) =>
      validateTemplateTask(s, `${path}.subtasks[${i}]`),
    );
  }
  return out;
}

export function parseTemplatePayload(body: Record<string, unknown>): TemplateTask {
  const payload = body["payload"];
  if (payload === undefined) throw badRequest('"payload" is required');
  return validateTemplateTask(payload, "payload");
}

export function publicTemplate(row: TaskTemplateRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    name: row.name,
    payload: JSON.parse(row.payload_json) as TemplateTask,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createTemplate(
  env: Env,
  principal: Principal,
  project: ProjectRow,
  name: string,
  payload: TemplateTask,
): Promise<TaskTemplateRow> {
  const now = nowIso();
  const row: TaskTemplateRow = {
    id: randomId(),
    tenant_id: project.tenant_id,
    project_id: project.id,
    name,
    payload_json: JSON.stringify(payload),
    created_by_account_id: principal.accountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO task_templates (id, tenant_id, project_id, name, payload_json, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      row.id, row.tenant_id, row.project_id, row.name, row.payload_json,
      row.created_by_account_id, now, now,
    )
    .run();
  return row;
}

export async function listTemplates(
  env: Env,
  projectId: string,
): Promise<TaskTemplateRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM task_templates WHERE project_id = ?1 AND deleted_at IS NULL",
  )
    .bind(projectId)
    .all<TaskTemplateRow>();
  return res.results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadTemplate(
  env: Env,
  projectId: string,
  templateId: string,
): Promise<TaskTemplateRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM task_templates WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL",
  )
    .bind(templateId, projectId)
    .first<TaskTemplateRow>();
  if (!row) throw notFound("Template not found");
  return row;
}

export async function deleteTemplate(
  env: Env,
  row: TaskTemplateRow,
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE task_templates SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(now, now, row.id)
    .run();
}

async function instantiateOne(
  env: Env,
  principal: Principal,
  project: ProjectRow,
  node: TemplateTask,
  baseDate: string,
  parentTaskId: string | null,
  assigneeAccountId: string | null,
): Promise<TaskRow[]> {
  const created = await insertTask(
    env,
    project,
    {
      title: node.title,
      descriptionEnc: node.description_enc ?? null,
      status: node.status ?? "todo",
      priority: node.priority ?? "medium",
      assigneeAccountId,
      parentTaskId,
      startDate:
        node.start_offset_days !== undefined && node.start_offset_days !== null
          ? addDays(baseDate, node.start_offset_days)
          : null,
      dueDate:
        node.due_offset_days !== undefined && node.due_offset_days !== null
          ? addDays(baseDate, node.due_offset_days)
          : null,
      sortOrder: 0,
      estimateMinutes: node.estimate_minutes ?? null,
    },
    { accountId: principal.accountId },
  );
  const out = [created];
  for (const sub of node.subtasks ?? []) {
    out.push(
      ...(await instantiateOne(env, principal, project, sub, baseDate, created.id, assigneeAccountId)),
    );
  }
  return out;
}

export async function instantiateTemplate(
  env: Env,
  principal: Principal,
  project: ProjectRow,
  template: TaskTemplateRow,
  baseDate: string,
  assigneeAccountId: string | null,
): Promise<TaskRow[]> {
  const payload = JSON.parse(template.payload_json) as TemplateTask;
  return instantiateOne(env, principal, project, payload, baseDate, null, assigneeAccountId);
}

/* ------------------------------------------------------------------ */
/* Duplication                                                          */
/* ------------------------------------------------------------------ */

/**
 * Deep-copy a task (optionally with its subtask subtree). Labels and
 * custom field values are copied; dependencies are recreated when both
 * ends are inside the copied set. Time entries are never copied.
 */
export async function duplicateTask(
  env: Env,
  principal: Principal,
  project: ProjectRow,
  root: TaskRow,
  opts: { includeSubtasks: boolean; title?: string },
): Promise<{ root: TaskRow; created: TaskRow[]; idMap: Map<string, string> }> {
  const source = { accountId: principal.accountId };
  const idMap = new Map<string, string>();
  const created: TaskRow[] = [];

  const copyOne = async (
    original: TaskRow,
    parentCopyId: string | null,
    isRoot: boolean,
  ): Promise<TaskRow> => {
    const input: TaskInput = {
      title:
        isRoot && opts.title
          ? opts.title
          : isRoot
            ? `${original.title}（コピー）`
            : original.title,
      descriptionEnc: original.description_enc,
      status: original.status,
      priority: original.priority ?? "medium",
      assigneeAccountId: original.assignee_account_id,
      parentTaskId: parentCopyId,
      startDate: original.start_date,
      dueDate: original.due_date,
      sortOrder: original.sort_order,
      estimateMinutes: original.estimate_minutes,
    };
    const copy = await insertTask(env, project, input, source);
    idMap.set(original.id, copy.id);
    created.push(copy);
    // Labels.
    for (const label of await labelsOfTask(env, original.id)) {
      await attachLabel(env, copy, label);
    }
    // Custom field values.
    const values = await env.DB.prepare(
      "SELECT field_id, value_text FROM task_custom_values WHERE task_id = ?1",
    )
      .bind(original.id)
      .all<{ field_id: string; value_text: string | null }>();
    for (const v of values.results) {
      await env.DB.prepare(
        "INSERT INTO task_custom_values (task_id, field_id, tenant_id, value_text, updated_by_account_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
        .bind(copy.id, v.field_id, copy.tenant_id, v.value_text, principal.accountId, nowIso())
        .run();
    }
    return copy;
  };

  const rootCopy = await copyOne(root, root.parent_task_id, true);
  if (opts.includeSubtasks) {
    const all = await listTasks(env, project.id, { includeArchived: true });
    const childrenOf = new Map<string, TaskRow[]>();
    for (const t of all) {
      if (t.parent_task_id) {
        const list = childrenOf.get(t.parent_task_id) ?? [];
        list.push(t);
        childrenOf.set(t.parent_task_id, list);
      }
    }
    const walk = async (originalId: string, parentCopyId: string) => {
      for (const child of childrenOf.get(originalId) ?? []) {
        const childCopy = await copyOne(child, parentCopyId, false);
        await walk(child.id, childCopy.id);
      }
    };
    await walk(root.id, rootCopy.id);
  }
  return { root: rootCopy, created, idMap };
}

/* ------------------------------------------------------------------ */
/* Recently viewed                                                      */
/* ------------------------------------------------------------------ */

export async function recordView(
  env: Env,
  accountId: string,
  tenantId: string,
  entityType: "task" | "project",
  entityId: string,
): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT account_id FROM recent_views WHERE account_id = ?1 AND entity_type = ?2 AND entity_id = ?3",
  )
    .bind(accountId, entityType, entityId)
    .first<{ account_id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE recent_views SET viewed_at = ?1, tenant_id = ?2 WHERE account_id = ?3 AND entity_type = ?4 AND entity_id = ?5",
    )
      .bind(nowIso(), tenantId, accountId, entityType, entityId)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO recent_views (account_id, tenant_id, entity_type, entity_id, viewed_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(accountId, tenantId, entityType, entityId, nowIso())
      .run();
  }
}

export interface RecentItem {
  entity_type: string;
  entity_id: string;
  tenant_id: string;
  viewed_at: string;
  title: string | null;
}

export async function listRecent(
  env: Env,
  accountId: string,
  tenantId: string | null,
  limit = 20,
): Promise<RecentItem[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM recent_views WHERE account_id = ?1",
  )
    .bind(accountId)
    .all<{
      tenant_id: string;
      entity_type: string;
      entity_id: string;
      viewed_at: string;
    }>();
  const rows = res.results
    .filter((r) => tenantId === null || r.tenant_id === tenantId)
    .sort((a, b) => b.viewed_at.localeCompare(a.viewed_at))
    .slice(0, limit);
  const out: RecentItem[] = [];
  for (const row of rows) {
    let title: string | null = null;
    if (row.entity_type === "task") {
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?1")
        .bind(row.entity_id)
        .first<TaskRow>();
      if (!task || task.deleted_at) continue;
      title = task.title;
    } else {
      const project = await env.DB.prepare(
        "SELECT * FROM projects WHERE id = ?1 AND deleted_at IS NULL",
      )
        .bind(row.entity_id)
        .first<ProjectRow>();
      if (!project) continue;
      title = project.name;
    }
    out.push({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      tenant_id: row.tenant_id,
      viewed_at: row.viewed_at,
      title,
    });
  }
  return out;
}
