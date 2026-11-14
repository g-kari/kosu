/**
 * Labels, saved filters and plaintext search (phase 3).
 *
 * Labels are defined at a scope (tenant, workspace or project) and can
 * be attached to any task in that scope. A project's visible labels are
 * the union of its own, its workspace's and its tenant's labels.
 *
 * Saved filters store the task-list query parameter set under a name,
 * per account.
 *
 * Search is server-side over plaintext metadata only (task titles,
 * project and milestone names, label names). Encrypted bodies (task
 * descriptions, entry notes, comments) never reach the server in
 * plaintext, so they are searched on the client after decryption —
 * see docs/DESIGN.md and client/search.js.
 */
import { nowIso } from "./accounts";
import { badRequest, notFound } from "./errors";
import { cleanName } from "./hierarchy";
import { accessForRef, loadRoleChain } from "./permissions";
import { randomId } from "./tokens";
import type {
  Env,
  LabelRow,
  MilestoneRow,
  Principal,
  ProjectRow,
  SavedFilterRow,
  TaskRow,
} from "./types";
import type { ScopeLevel } from "./workflow";

export interface LabelScope {
  level: ScopeLevel;
  workspaceId: string | null;
  projectId: string | null;
}

export function publicLabel(row: LabelRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    scope_level: row.scope_level,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    name: row.name,
    color: row.color,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function parseLabelInput(
  body: Record<string, unknown>,
  partial: boolean,
): { name?: string; color?: string | null } {
  const out: { name?: string; color?: string | null } = {};
  if (!partial || body["name"] !== undefined) {
    out.name = cleanName(body["name"]);
  }
  if (body["color"] !== undefined) {
    const color = body["color"];
    if (color === null || color === "") out.color = null;
    else if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
      out.color = color;
    } else {
      throw badRequest('"color" must be a #RRGGBB hex color');
    }
  }
  return out;
}

export async function createLabel(
  env: Env,
  input: {
    tenantId: string;
    scope: LabelScope;
    name: string;
    color: string | null;
    createdByAccountId: string;
  },
): Promise<LabelRow> {
  const now = nowIso();
  const row: LabelRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    scope_level: input.scope.level,
    workspace_id: input.scope.workspaceId,
    project_id: input.scope.projectId,
    name: input.name,
    color: input.color,
    created_by_account_id: input.createdByAccountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO labels (id, tenant_id, scope_level, workspace_id, project_id, name, color, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(
      row.id, row.tenant_id, row.scope_level, row.workspace_id,
      row.project_id, row.name, row.color, row.created_by_account_id,
      now, now,
    )
    .run();
  return row;
}

/** Labels visible in a project context (project + workspace + tenant). */
export async function listLabelsForProject(
  env: Env,
  project: ProjectRow,
): Promise<LabelRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM labels WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(project.tenant_id)
    .all<LabelRow>();
  return res.results
    .filter(
      (r) =>
        (r.scope_level === "tenant" && r.workspace_id === null && r.project_id === null) ||
        (r.scope_level === "workspace" && r.workspace_id === project.workspace_id) ||
        (r.scope_level === "project" && r.project_id === project.id),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listLabelsAtScope(
  env: Env,
  tenantId: string,
  scope: LabelScope,
): Promise<LabelRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM labels WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<LabelRow>();
  return res.results
    .filter(
      (r) =>
        r.scope_level === scope.level &&
        r.workspace_id === scope.workspaceId &&
        r.project_id === scope.projectId,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadLabel(
  env: Env,
  labelId: string,
): Promise<LabelRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM labels WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(labelId)
    .first<LabelRow>();
  if (!row) throw notFound("Label not found");
  return row;
}

/** A label can be attached to a task when its scope covers the task. */
export function labelAppliesTo(label: LabelRow, task: TaskRow): boolean {
  if (label.tenant_id !== task.tenant_id) return false;
  if (label.scope_level === "tenant") return true;
  if (label.scope_level === "workspace") {
    return label.workspace_id === task.workspace_id;
  }
  return label.project_id === task.project_id;
}

export async function labelsOfTask(
  env: Env,
  taskId: string,
): Promise<LabelRow[]> {
  const links = await env.DB.prepare(
    "SELECT label_id FROM task_labels WHERE task_id = ?1",
  )
    .bind(taskId)
    .all<{ label_id: string }>();
  const out: LabelRow[] = [];
  for (const link of links.results) {
    const row = await env.DB.prepare(
      "SELECT * FROM labels WHERE id = ?1 AND deleted_at IS NULL",
    )
      .bind(link.label_id)
      .first<LabelRow>();
    if (row) out.push(row);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function attachLabel(
  env: Env,
  task: TaskRow,
  label: LabelRow,
): Promise<void> {
  if (!labelAppliesTo(label, task)) {
    throw badRequest("Label scope does not cover this task");
  }
  const existing = await env.DB.prepare(
    "SELECT task_id FROM task_labels WHERE task_id = ?1 AND label_id = ?2",
  )
    .bind(task.id, label.id)
    .first<{ task_id: string }>();
  if (existing) return;
  await env.DB.prepare(
    "INSERT INTO task_labels (task_id, label_id, tenant_id, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(task.id, label.id, task.tenant_id, nowIso())
    .run();
}

export async function detachLabel(
  env: Env,
  taskId: string,
  labelId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM task_labels WHERE task_id = ?1 AND label_id = ?2",
  )
    .bind(taskId, labelId)
    .run();
}

export async function taskIdsWithLabel(
  env: Env,
  labelId: string,
): Promise<Set<string>> {
  const res = await env.DB.prepare(
    "SELECT task_id FROM task_labels WHERE label_id = ?1",
  )
    .bind(labelId)
    .all<{ task_id: string }>();
  return new Set(res.results.map((r) => r.task_id));
}

/* ------------------------------------------------------------------ */
/* Saved filters                                                        */
/* ------------------------------------------------------------------ */

export interface TaskFilterQuery {
  q?: string;
  status?: string[];
  priority?: string[];
  assignee_account_id?: string | null;
  label_ids?: string[];
  due_from?: string | null;
  due_to?: string | null;
  include_archived?: boolean;
}

export function parseFilterQuery(input: unknown): TaskFilterQuery {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw badRequest('"query" must be an object of filter parameters');
  }
  const r = input as Record<string, unknown>;
  const out: TaskFilterQuery = {};
  if (typeof r["q"] === "string") out.q = r["q"].slice(0, 200);
  for (const key of ["status", "priority", "label_ids"] as const) {
    const v = r[key];
    if (v !== undefined) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        throw badRequest(`"${key}" must be an array of strings`);
      }
      out[key] = (v as string[]).slice(0, 100);
    }
  }
  if (typeof r["assignee_account_id"] === "string") {
    out.assignee_account_id = r["assignee_account_id"];
  } else if (r["assignee_account_id"] === null) {
    out.assignee_account_id = null;
  }
  for (const key of ["due_from", "due_to"] as const) {
    const v = r[key];
    if (v !== undefined) {
      if (v !== null && typeof v !== "string") {
        throw badRequest(`"${key}" must be a YYYY-MM-DD date`);
      }
      out[key] = v as string | null;
    }
  }
  if (typeof r["include_archived"] === "boolean") {
    out.include_archived = r["include_archived"];
  }
  return out;
}

/** Apply a filter query to a task list (server-side, plaintext fields). */
export function applyTaskFilter(
  tasks: TaskRow[],
  filter: TaskFilterQuery,
  labelMap?: Map<string, Set<string>>,
): TaskRow[] {
  return tasks.filter((t) => {
    if (!filter.include_archived && t.archived_at) return false;
    if (filter.q && !t.title.toLowerCase().includes(filter.q.toLowerCase())) {
      return false;
    }
    if (filter.status && filter.status.length > 0 && !filter.status.includes(t.status)) {
      return false;
    }
    if (
      filter.priority &&
      filter.priority.length > 0 &&
      !filter.priority.includes(t.priority ?? "medium")
    ) {
      return false;
    }
    if (filter.assignee_account_id !== undefined && t.assignee_account_id !== filter.assignee_account_id) {
      return false;
    }
    if (filter.due_from && (!t.due_date || t.due_date < filter.due_from)) return false;
    if (filter.due_to && (!t.due_date || t.due_date > filter.due_to)) return false;
    if (filter.label_ids && filter.label_ids.length > 0 && labelMap) {
      const mine = labelMap.get(t.id) ?? new Set<string>();
      if (!filter.label_ids.some((id) => mine.has(id))) return false;
    }
    return true;
  });
}

export function publicSavedFilter(row: SavedFilterRow) {
  let query: TaskFilterQuery = {};
  try {
    query = parseFilterQuery(JSON.parse(row.query_json));
  } catch {
    query = {};
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    project_id: row.project_id,
    query,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createSavedFilter(
  env: Env,
  input: {
    tenantId: string;
    accountId: string;
    name: string;
    projectId: string | null;
    query: TaskFilterQuery;
  },
): Promise<SavedFilterRow> {
  const now = nowIso();
  const row: SavedFilterRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    account_id: input.accountId,
    name: input.name,
    project_id: input.projectId,
    query_json: JSON.stringify(input.query),
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO saved_filters (id, tenant_id, account_id, name, project_id, query_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      row.id, row.tenant_id, row.account_id, row.name, row.project_id,
      row.query_json, now, now,
    )
    .run();
  return row;
}

export async function listSavedFilters(
  env: Env,
  tenantId: string,
  accountId: string,
): Promise<SavedFilterRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM saved_filters WHERE tenant_id = ?1 AND account_id = ?2",
  )
    .bind(tenantId, accountId)
    .all<SavedFilterRow>();
  return res.results.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSavedFilter(
  env: Env,
  tenantId: string,
  accountId: string,
  filterId: string,
): Promise<SavedFilterRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM saved_filters WHERE id = ?1 AND tenant_id = ?2 AND account_id = ?3",
  )
    .bind(filterId, tenantId, accountId)
    .first<SavedFilterRow>();
  if (!row) throw notFound("Saved filter not found");
  return row;
}

/* ------------------------------------------------------------------ */
/* Search (plaintext metadata only)                                     */
/* ------------------------------------------------------------------ */

export interface SearchResults {
  tasks: TaskRow[];
  projects: ProjectRow[];
  milestones: MilestoneRow[];
  labels: LabelRow[];
}

/**
 * Search readable content of a tenant. Readability is resolved per
 * project through the caller's role chain, so other teams' private
 * projects never leak through titles.
 */
export async function searchTenant(
  env: Env,
  principal: Principal,
  tenantId: string,
  query: string,
): Promise<SearchResults> {
  const q = query.trim().toLowerCase();
  const empty: SearchResults = { tasks: [], projects: [], milestones: [], labels: [] };
  if (!q) return empty;
  const projectsRes = await env.DB.prepare(
    "SELECT * FROM projects WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<ProjectRow>();
  const readable = new Map<string, ProjectRow>();
  for (const project of projectsRes.results) {
    const chain = await loadRoleChain(env, principal.accountId, {
      tenantId,
      workspaceId: project.workspace_id,
      teamId: project.team_id,
      projectId: project.id,
    });
    const access = accessForRef(chain, {
      tenantId,
      workspaceId: project.workspace_id,
      teamId: project.team_id,
      projectId: project.id,
    });
    if (access.read) readable.set(project.id, project);
  }
  const projects = [...readable.values()]
    .filter((p) => p.name.toLowerCase().includes(q))
    .slice(0, 50);

  const tasksRes = await env.DB.prepare(
    "SELECT * FROM tasks WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<TaskRow>();
  const tasks = tasksRes.results
    .filter(
      (t) =>
        t.project_id !== null &&
        readable.has(t.project_id) &&
        t.title.toLowerCase().includes(q),
    )
    .slice(0, 50);

  const milestonesRes = await env.DB.prepare(
    "SELECT * FROM milestones WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<MilestoneRow>();
  const milestones = milestonesRes.results
    .filter((m) => readable.has(m.project_id) && m.name.toLowerCase().includes(q))
    .slice(0, 50);

  const labelsRes = await env.DB.prepare(
    "SELECT * FROM labels WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<LabelRow>();
  const labels = labelsRes.results
    .filter(
      (l) =>
        l.name.toLowerCase().includes(q) &&
        (l.scope_level === "tenant" ||
          (l.project_id !== null && readable.has(l.project_id)) ||
          (l.workspace_id !== null &&
            [...readable.values()].some(
              (p) => p.workspace_id === l.workspace_id,
            ))),
    )
    .slice(0, 50);

  return { tasks, projects, milestones, labels };
}
