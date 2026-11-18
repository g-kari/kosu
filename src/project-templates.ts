/**
 * Project templates (phase 5 item 2).
 *
 * A template captures a whole project — its tasks (with relative
 * dates), dependencies and milestones — as a JSON blueprint stored in
 * project_templates. Dates are stored as day offsets from the capture
 * base date (the earliest task/milestone date, or the project start),
 * so instantiating shifts every date by (start date - base date).
 * Instantiating creates a fresh project under a chosen team and
 * rebuilds the tasks, dependency graph and milestones inside it,
 * reusing the phase-2 insert functions so sync changes are recorded.
 */

import { guardAutomationScope, guardStoredAutomationScope } from "./automation-access";
import { randomId } from "./tokens";
import { badRequest, notFound } from "./errors";
import { nowIso } from "./accounts";
import { addDays, isDateString } from "./timecalc";
import {
  createProject,
  guard as hierarchyGuard,
  loadProject,
  loadWorkspace,
} from "./hierarchy";
import type { TeamRow } from "./types";
import {
  insertDependency,
  insertMilestone,
  insertTask,
  type TaskInput,
} from "./tasks";
import type {
  Env,
  MilestoneRow,
  Principal,
  ProjectRow,
  ProjectTemplateRow,
  TaskDependencyRow,
  TaskRow,
} from "./types";

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) /
      86_400_000,
  );
}

interface TemplateTask {
  key: string;
  title: string;
  description_enc: string | null;
  status: string;
  priority: string;
  parent_key: string | null;
  start_offset: number | null;
  due_offset: number | null;
  sort_order: number;
  estimate_minutes: number | null;
  estimate_points: number | null;
  estimate_size: string | null;
}

interface TemplatePayload {
  version: 1;
  source_project_id?: string;
  project: { name: string; color: string | null };
  base_date: string;
  tasks: TemplateTask[];
  /** task_key depends on depends_on_key. */
  dependencies: { task_key: string; depends_on_key: string }[];
  milestones: { name: string; offset: number }[];
}

export function publicTemplate(
  row: ProjectTemplateRow,
): Record<string, unknown> {
  let taskCount = 0;
  try {
    const payload = JSON.parse(row.payload_json) as TemplatePayload;
    taskCount = payload.tasks?.length ?? 0;
  } catch {
    taskCount = 0;
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    task_count: taskCount,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Legacy templates without source evidence are available only to tenant administrators. */
export async function guardTemplateAccess(env:Env,principal:Principal,row:ProjectTemplateRow,need:"read"|"admin") {
  const tenant = await hierarchyGuard(env,principal,{tenantId:row.tenant_id},"read");
  if (tenant.access.admin) return guardStoredAutomationScope(env,principal,row.tenant_id,null,need);
  let source: unknown;
  try { source = JSON.parse(row.payload_json).source_project_id; } catch { throw badRequest("Template payload is corrupted"); }
  return guardAutomationScope(env,principal,row.tenant_id,typeof source === "string" ? source : null,need);
}

export async function listProjectTemplates(
  env: Env,
  tenantId: string,
): Promise<ProjectTemplateRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM project_templates WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<ProjectTemplateRow>();
  return results ?? [];
}

export async function getProjectTemplate(
  env: Env,
  tenantId: string,
  id: string,
): Promise<ProjectTemplateRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM project_templates WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(id, tenantId)
    .first<ProjectTemplateRow>();
  if (!row) throw notFound("Project template not found");
  return row;
}

/** Capture a project's structure as a new template. */
export async function captureProjectTemplate(
  env: Env,
  project: ProjectRow,
  name: string,
  createdBy: string,
): Promise<ProjectTemplateRow> {
  await guardAutomationScope(env,{kind:"session",accountId:createdBy},project.tenant_id,project.id,"admin");
  const { results: taskRows } = await env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL",
  )
    .bind(project.id)
    .all<TaskRow>();
  const tasks = taskRows ?? [];
  const { results: milestoneRows } = await env.DB.prepare(
    "SELECT * FROM milestones WHERE project_id = ?1 AND deleted_at IS NULL",
  )
    .bind(project.id)
    .all<MilestoneRow>();
  const milestones = milestoneRows ?? [];
  const dates = [
    ...tasks.flatMap((t) => [t.start_date, t.due_date]),
    ...milestones.map((m) => m.date),
  ]
    .filter((d): d is string => typeof d === "string")
    .sort();
  const baseDate = dates[0] ?? project.starts_on ?? nowIso().slice(0, 10);
  const offset = (d: string | null): number | null =>
    d ? daysBetween(baseDate, d) : null;

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const templateTasks: TemplateTask[] = tasks.map((t) => ({
    key: t.id,
    title: t.title,
    description_enc: t.description_enc,
    status: t.status,
    priority: t.priority ?? "medium",
    parent_key:
      t.parent_task_id && byId.has(t.parent_task_id) ? t.parent_task_id : null,
    start_offset: offset(t.start_date),
    due_offset: offset(t.due_date),
    sort_order: Number(t.sort_order),
    estimate_minutes: t.estimate_minutes,
    estimate_points: t.estimate_points ?? null,
    estimate_size: t.estimate_size ?? null,
  }));

  const { results: depRows } = await env.DB.prepare(
    "SELECT * FROM task_dependencies WHERE project_id = ?1 AND deleted_at IS NULL",
  )
    .bind(project.id)
    .all<TaskDependencyRow>();
  const dependencies = (depRows ?? [])
    .filter((d) => byId.has(d.task_id) && byId.has(d.depends_on_task_id))
    .map((d) => ({
      task_key: d.task_id,
      depends_on_key: d.depends_on_task_id,
    }));

  const payload: TemplatePayload = {
    version: 1,
    source_project_id: project.id,
    project: { name: project.name, color: project.color },
    base_date: baseDate,
    tasks: templateTasks,
    dependencies,
    milestones: milestones.map((m) => ({
      name: m.name,
      offset: daysBetween(baseDate, m.date),
    })),
  };
  const now = nowIso();
  const row: ProjectTemplateRow = {
    id: randomId(),
    tenant_id: project.tenant_id,
    name,
    payload_json: JSON.stringify(payload),
    created_by_account_id: createdBy,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO project_templates (id, tenant_id, name, payload_json, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(row.id, row.tenant_id, row.name, row.payload_json, createdBy, now, now)
    .run();
  return row;
}

export async function deleteProjectTemplate(
  env: Env,
  row: ProjectTemplateRow,
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE project_templates SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(now, now, row.id)
    .run();
}

/** Instantiate a template as a new project under the given team. */
export async function instantiateProjectTemplate(
  env: Env,
  principal: Principal,
  args: {
    tenantId: string;
    templateId: string;
    teamId: string;
    name?: string;
    startDate?: string;
  },
): Promise<{ project: ProjectRow; taskCount: number }> {
  const template = await getProjectTemplate(env, args.tenantId, args.templateId);
  await guardTemplateAccess(env,principal,template,"read");
  let payload: TemplatePayload;
  try {
    payload = JSON.parse(template.payload_json) as TemplatePayload;
  } catch {
    throw badRequest("Template payload is corrupted");
  }
  const team = await env.DB.prepare(
    "SELECT * FROM teams WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(args.teamId, args.tenantId)
    .first<TeamRow>();
  if (!team) throw notFound("Team not found");
  const workspace = await loadWorkspace(env, args.tenantId, team.workspace_id);
  await hierarchyGuard(env,principal,{tenantId:args.tenantId,workspaceId:workspace.id,teamId:team.id},"write");
  const startDate =
    args.startDate && isDateString(args.startDate)
      ? args.startDate
      : nowIso().slice(0, 10);
  const shift = daysBetween(payload.base_date, startDate);
  const shifted = (off: number | null): string | null =>
    off === null ? null : addDays(payload.base_date, off + shift);

  const project = await createProject(
    env,
    principal,
    args.tenantId,
    workspace.id,
    team.id,
    {
      name: args.name?.trim() ? args.name.trim() : payload.project.name,
      color: payload.project.color,
      startsOn: startDate,
      dueOn: null,
    },
  );

  const idByKey = new Map<string, string>();
  // Parents first: iterate until every task is placed (template tasks
  // form a tree, so this terminates).
  const remaining = [...payload.tasks];
  let guard = 0;
  while (remaining.length > 0 && guard++ <= payload.tasks.length + 1) {
    for (let i = remaining.length - 1; i >= 0; i--) {
      const t = remaining[i] as TemplateTask;
      if (t.parent_key && !idByKey.has(t.parent_key)) continue;
      const input: TaskInput = {
        title: t.title,
        descriptionEnc: t.description_enc,
        status: t.status,
        priority: t.priority,
        assigneeAccountId: null,
        parentTaskId: t.parent_key
          ? (idByKey.get(t.parent_key) as string)
          : null,
        startDate: shifted(t.start_offset),
        dueDate: shifted(t.due_offset),
        sortOrder: t.sort_order,
        estimateMinutes: t.estimate_minutes,
        estimatePoints: t.estimate_points,
        estimateSize: t.estimate_size,
      };
      const row = await insertTask(env, project, input, {
        accountId: principal.accountId,
      });
      idByKey.set(t.key, row.id);
      remaining.splice(i, 1);
    }
  }

  const source = { accountId: principal.accountId };
  for (const dep of payload.dependencies) {
    const taskId = idByKey.get(dep.task_key);
    const dependsOnId = idByKey.get(dep.depends_on_key);
    if (!taskId || !dependsOnId) continue;
    await insertDependency(env, project, taskId, dependsOnId, source);
  }
  for (const m of payload.milestones) {
    await insertMilestone(
      env,
      project,
      { name: m.name, date: addDays(payload.base_date, m.offset + shift) },
      source,
    );
  }
  const fresh = await loadProject(env, team.id, project.id);
  return { project: fresh, taskCount: idByKey.size };
}

