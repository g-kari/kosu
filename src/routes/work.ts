/**
 * Phase-3 work API: labels & saved filters & search, workflow
 * (status/priority) definitions, custom fields, comments & watchers,
 * attachments, task history & trash, recurrence, templates,
 * duplication, bulk edit and recently-viewed items.
 *
 * Paths (all under /api/v1, project paths abbreviated):
 *   .../projects/:projectId/labels                 visible labels
 *   /tenants/:tenantId/labels[/:labelId]            scoped label CRUD
 *   .../tasks/:taskId/labels[/:labelId]             attach / detach
 *   /tenants/:tenantId/saved-filters[/:filterId]    saved filters (+ /apply)
 *   /tenants/:tenantId/search?q=                    plaintext search
 *   .../workflow/statuses|priorities               tenant/workspace/project
 *   .../projects/:projectId/custom-fields[/:fieldId]
 *   .../tasks/:taskId/custom-fields                 values
 *   .../tasks/:taskId/comments[/:commentId]
 *   .../tasks/:taskId/watchers, .../tasks/:taskId/watch
 *   .../tasks/:taskId/attachments, /tenants/:tenantId/attachments/:id
 *   .../tasks/:taskId/history[/:historyId/restore]
 *   /tenants/:tenantId/trash[/tasks/:id|/time-entries/:id]
 *   .../tasks/:taskId/recurrence
 *   .../projects/:projectId/task-templates[/:id[/instantiate]]
 *   .../tasks/:taskId/duplicate, .../projects/:projectId/tasks/bulk
 *   /me/recent
 */
import { Hono } from "hono";
import { recordAudit } from "../audit";
import {
  createAttachment,
  deleteAttachment,
  listAttachments,
  loadAttachment,
  publicAttachment,
  readAttachmentBytes,
  MAX_ATTACHMENT_BYTES,
} from "../attachments";
import {
  createComment,
  deleteComment,
  isWatching,
  listComments,
  listWatcherIds,
  loadComment,
  parseCommentBody,
  publicComment,
  updateComment,
  validateMentions,
  addWatcher,
  removeWatcher,
} from "../comments";
import { badRequest, forbidden, notFound } from "../errors";
import {
  createFieldDef,
  deleteFieldDef,
  listFieldDefs,
  listTaskFieldValues,
  loadFieldDef,
  parseFieldDefInput,
  publicFieldDef,
  setTaskFieldValue,
} from "../fields";
import {
  guard,
  loadProject,
  loadTeam,
  loadTenant,
  loadWorkspace,
} from "../hierarchy";
import {
  listTaskHistory,
  listTrashedEntries,
  listTrashedTasks,
  loadHistoryRow,
  loadTrashedEntry,
  loadTrashedTask,
  publicHistory,
  purgeEntry,
  purgeTask,
} from "../history";
import {
  attachLabel,
  createSavedFilter,
  createLabel,
  detachLabel,
  labelsOfTask,
  listLabelsAtScope,
  listLabelsForProject,
  listSavedFilters,
  loadLabel,
  loadSavedFilter,
  parseFilterQuery,
  parseLabelInput,
  publicLabel,
  publicSavedFilter,
  searchTenant,
  taskIdsWithLabel,
  applyTaskFilter,
  type LabelScope,
} from "../labels";
import { dispatchNotifications } from "../notify";
import { assertWithinLimits } from "../usage";
import {
  deleteRecurrenceRule,
  deleteTemplate,
  duplicateTask,
  getRecurrenceRule,
  instantiateTemplate,
  listRecent,
  listTemplates,
  loadTemplate,
  parseRecurrenceInput,
  parseTemplatePayload,
  createTemplate,
  publicRecurrence,
  publicTemplate,
  putRecurrenceRule,
} from "../planning";
import {
  applyTaskPatch,
  listTasks,
  loadTask,
  loadTaskAny,
  parseTaskInput,
  publicEntry,
  publicMilestone,
  publicTask,
  restoreDeletedEntry,
  restoreDeletedTask,
  restoreTaskFromSnapshot,
  setTaskArchived,
} from "../tasks";
import { isDateString } from "../timecalc";
import type { Env, Principal, ProjectRow, Variables } from "../types";
import {
  clearPriorityDefs,
  clearStatusDefs,
  parsePriorityDefs,
  parseRenames,
  parseStatusDefs,
  replacePriorityDefs,
  replaceStatusDefs,
  resolvePriorities,
  resolveStatuses,
  type DefScope,
} from "../workflow";
import { auth, readJsonBody, type Ctx } from "./http";

export const workRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const PROJECT_PATH =
  "/api/v1/tenants/:tenantId/workspaces/:workspaceId/teams/:teamId/projects/:projectId";
const TASK_PATH = `${PROJECT_PATH}/tasks`;
const TENANT_PATH = "/api/v1/tenants/:tenantId";
const WS_PATH = `${TENANT_PATH}/workspaces/:workspaceId`;

interface Ancestry {
  tenantId: string;
  workspaceId: string;
  teamId: string;
  projectId: string;
}

function params(c: Ctx): Ancestry {
  return {
    tenantId: c.req.param("tenantId") as string,
    workspaceId: c.req.param("workspaceId") as string,
    teamId: c.req.param("teamId") as string,
    projectId: c.req.param("projectId") as string,
  };
}

async function loadAncestry(c: Ctx, a: Ancestry): Promise<ProjectRow> {
  await loadTenant(c.env, a.tenantId);
  await loadWorkspace(c.env, a.tenantId, a.workspaceId);
  await loadTeam(c.env, a.workspaceId, a.teamId);
  return loadProject(c.env, a.teamId, a.projectId);
}

async function guardProject(
  c: Ctx,
  principal: Principal,
  a: Ancestry,
  need: "read" | "write" | "admin",
) {
  return guard(
    c.env,
    principal,
    {
      tenantId: a.tenantId,
      workspaceId: a.workspaceId,
      teamId: a.teamId,
      projectId: a.projectId,
    },
    need,
  );
}

async function isTenantAdmin(
  c: Ctx,
  principal: Principal,
  tenantId: string,
): Promise<boolean> {
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  return chain.tenant === "owner" || chain.tenant === "admin";
}

/** Resolve a project row by id alone (tenant-scoped routes). */
async function loadProjectScoped(c: Ctx, projectId: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(projectId)
    .first<ProjectRow>();
  if (!row) throw notFound("Project not found");
  await loadTenant(c.env, row.tenant_id);
  await loadWorkspace(c.env, row.tenant_id, row.workspace_id);
  await loadTeam(c.env, row.workspace_id, row.team_id);
  return row;
}

async function guardProjectRow(
  c: Ctx,
  principal: Principal,
  project: ProjectRow,
  need: "read" | "write" | "admin",
) {
  return guard(
    c.env,
    principal,
    {
      tenantId: project.tenant_id,
      workspaceId: project.workspace_id,
      teamId: project.team_id,
      projectId: project.id,
    },
    need,
  );
}

/* ------------------------------------------------------------------ */
/* Labels                                                               */
/* ------------------------------------------------------------------ */

workRoutes.get(`${PROJECT_PATH}/labels`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const labels = await listLabelsForProject(c.env, project);
  return c.json({ labels: labels.map(publicLabel) });
});

function parseLabelScope(
  body: Record<string, unknown>,
  tenantId: string,
): { scope: LabelScope; scopeProject: ProjectRow | null } {
  const level = body["scope_level"] ?? "project";
  if (level !== "tenant" && level !== "workspace" && level !== "project") {
    throw badRequest('"scope_level" must be tenant, workspace or project');
  }
  const workspaceId =
    typeof body["workspace_id"] === "string" ? body["workspace_id"] : null;
  const projectId =
    typeof body["project_id"] === "string" ? body["project_id"] : null;
  if (level === "workspace" && !workspaceId) {
    throw badRequest('"workspace_id" is required for a workspace label');
  }
  if (level === "project" && !projectId) {
    throw badRequest('"project_id" is required for a project label');
  }
  void tenantId;
  return {
    scope: {
      level,
      workspaceId: level === "tenant" ? null : workspaceId,
      projectId: level === "project" ? projectId : null,
    },
    scopeProject: null,
  };
}

async function guardLabelScope(
  c: Ctx,
  principal: Principal,
  tenantId: string,
  scope: LabelScope,
  need: "read" | "write" | "admin",
) {
  if (scope.level === "tenant") {
    return guard(c.env, principal, { tenantId }, need);
  }
  if (scope.level === "workspace") {
    await loadWorkspace(c.env, tenantId, scope.workspaceId as string);
    return guard(
      c.env,
      principal,
      { tenantId, workspaceId: scope.workspaceId as string },
      need,
    );
  }
  const project = await loadProjectScoped(c, scope.projectId as string);
  if (project.tenant_id !== tenantId) throw notFound("Project not found");
  return guardProjectRow(c, principal, project, need);
}

workRoutes.post(`${TENANT_PATH}/labels`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const { scope } = parseLabelScope(body, tenantId);
  await guardLabelScope(c, principal, tenantId, scope, "write");
  const parsed = parseLabelInput(body, false);
  const row = await createLabel(c.env, {
    tenantId,
    scope,
    name: parsed.name as string,
    color: parsed.color ?? null,
    createdByAccountId: principal.accountId,
  });
  return c.json({ label: publicLabel(row) }, 201);
});

workRoutes.get(`${TENANT_PATH}/labels`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const level = (c.req.query("scope_level") ?? "tenant") as LabelScope["level"];
  if (level !== "tenant" && level !== "workspace" && level !== "project") {
    throw badRequest('"scope_level" must be tenant, workspace or project');
  }
  const scope: LabelScope = {
    level,
    workspaceId: c.req.query("workspace_id") ?? null,
    projectId: c.req.query("project_id") ?? null,
  };
  const labels = await listLabelsAtScope(c.env, tenantId, scope);
  return c.json({ labels: labels.map(publicLabel) });
});

workRoutes.patch(`${TENANT_PATH}/labels/:labelId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const label = await loadLabel(c.env, c.req.param("labelId") as string);
  if (label.tenant_id !== tenantId) throw notFound("Label not found");
  await guardLabelScope(
    c,
    principal,
    tenantId,
    {
      level: label.scope_level as LabelScope["level"],
      workspaceId: label.workspace_id,
      projectId: label.project_id,
    },
    "write",
  );
  const parsed = parseLabelInput(body, true);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE labels SET name = ?1, color = ?2, updated_at = ?3 WHERE id = ?4",
  )
    .bind(
      parsed.name ?? label.name,
      parsed.color !== undefined ? parsed.color : label.color,
      now,
      label.id,
    )
    .run();
  const updated = await loadLabel(c.env, label.id);
  return c.json({ label: publicLabel(updated) });
});

workRoutes.delete(`${TENANT_PATH}/labels/:labelId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const label = await loadLabel(c.env, c.req.param("labelId") as string);
  if (label.tenant_id !== tenantId) throw notFound("Label not found");
  await guardLabelScope(
    c,
    principal,
    tenantId,
    {
      level: label.scope_level as LabelScope["level"],
      workspaceId: label.workspace_id,
      projectId: label.project_id,
    },
    "write",
  );
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE labels SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(now, now, label.id)
    .run();
  await c.env.DB.prepare("DELETE FROM task_labels WHERE label_id = ?1")
    .bind(label.id)
    .run();
  return c.json({ ok: true });
});

workRoutes.get(`${TASK_PATH}/:taskId/labels`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const labels = await labelsOfTask(c.env, task.id);
  return c.json({ labels: labels.map(publicLabel) });
});

workRoutes.post(`${TASK_PATH}/:taskId/labels`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const labelId = body["label_id"];
  if (typeof labelId !== "string" || !labelId) {
    throw badRequest('"label_id" is required');
  }
  const label = await loadLabel(c.env, labelId);
  await attachLabel(c.env, task, label);
  const labels = await labelsOfTask(c.env, task.id);
  return c.json({ labels: labels.map(publicLabel) });
});

workRoutes.delete(`${TASK_PATH}/:taskId/labels/:labelId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  await detachLabel(c.env, task.id, c.req.param("labelId") as string);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Saved filters and search                                             */
/* ------------------------------------------------------------------ */

workRoutes.post(`${TENANT_PATH}/saved-filters`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const name = body["name"];
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 120) {
    throw badRequest('"name" must be 1-120 characters');
  }
  const projectId =
    typeof body["project_id"] === "string" ? body["project_id"] : null;
  if (projectId) {
    const project = await loadProjectScoped(c, projectId);
    if (project.tenant_id !== tenantId) throw notFound("Project not found");
    await guardProjectRow(c, principal, project, "read");
  }
  const query = parseFilterQuery(body["query"] ?? {});
  const row = await createSavedFilter(c.env, {
    tenantId,
    accountId: principal.accountId,
    name: name.trim(),
    projectId,
    query,
  });
  return c.json({ filter: publicSavedFilter(row) }, 201);
});

workRoutes.get(`${TENANT_PATH}/saved-filters`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const filters = await listSavedFilters(c.env, tenantId, principal.accountId);
  return c.json({ filters: filters.map(publicSavedFilter) });
});

workRoutes.delete(`${TENANT_PATH}/saved-filters/:filterId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const row = await loadSavedFilter(
    c.env,
    tenantId,
    principal.accountId,
    c.req.param("filterId") as string,
  );
  await c.env.DB.prepare("DELETE FROM saved_filters WHERE id = ?1")
    .bind(row.id)
    .run();
  return c.json({ ok: true });
});

/** Apply a saved filter to its project and return the matching tasks. */
workRoutes.get(`${TENANT_PATH}/saved-filters/:filterId/apply`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const row = await loadSavedFilter(
    c.env,
    tenantId,
    principal.accountId,
    c.req.param("filterId") as string,
  );
  const filter = publicSavedFilter(row);
  const projectId = c.req.query("project_id") ?? row.project_id;
  if (!projectId) {
    throw badRequest("This filter has no project; pass ?project_id=");
  }
  const project = await loadProjectScoped(c, projectId);
  if (project.tenant_id !== tenantId) throw notFound("Project not found");
  await guardProjectRow(c, principal, project, "read");
  const all = await listTasks(c.env, project.id, { includeArchived: true });
  const labelMap = new Map<string, Set<string>>();
  if (filter.query.label_ids && filter.query.label_ids.length > 0) {
    for (const labelId of filter.query.label_ids) {
      const ids = await taskIdsWithLabel(c.env, labelId);
      for (const id of ids) {
        const set = labelMap.get(id) ?? new Set<string>();
        set.add(labelId);
        labelMap.set(id, set);
      }
    }
  }
  const tasks = applyTaskFilter(all, filter.query, labelMap);
  return c.json({ filter, tasks: tasks.map(publicTask) });
});

workRoutes.get(`${TENANT_PATH}/search`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const q = c.req.query("q") ?? "";
  const results = await searchTenant(c.env, principal, tenantId, q);
  return c.json({
    query: q,
    tasks: results.tasks.map(publicTask),
    projects: results.projects.map((p) => ({
      id: p.id,
      tenant_id: p.tenant_id,
      workspace_id: p.workspace_id,
      team_id: p.team_id,
      name: p.name,
      color: p.color,
      starts_on: p.starts_on,
      due_on: p.due_on,
    })),
    milestones: results.milestones.map(publicMilestone),
    labels: results.labels.map(publicLabel),
  });
});

/* ------------------------------------------------------------------ */
/* Workflow definitions (statuses / priorities at three scopes)         */
/* ------------------------------------------------------------------ */

async function workflowGet(
  c: Ctx,
  scope: DefScope,
  kind: "statuses" | "priorities",
) {
  const ctx = {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId ?? null,
    projectId: scope.projectId ?? null,
  };
  if (kind === "statuses") {
    const { defs, source } = await resolveStatuses(c.env, ctx);
    return c.json({ scope: scope.level, source, statuses: defs });
  }
  const { defs, source } = await resolvePriorities(c.env, ctx);
  return c.json({ scope: scope.level, source, priorities: defs });
}

async function workflowPut(
  c: Ctx,
  scope: DefScope,
  kind: "statuses" | "priorities",
) {
  const body = await readJsonBody(c);
  const renames = parseRenames(body["renames"]);
  if (kind === "statuses") {
    const defs = parseStatusDefs(body["statuses"]);
    if (renames.size > 0) {
      const slugs = new Set(defs.map((d) => d.slug));
      for (const to of renames.values()) {
        if (!slugs.has(to)) {
          throw badRequest(`rename target "${to}" is not in the new statuses`);
        }
      }
    }
    const { migrated_tasks } = await replaceStatusDefs(c.env, scope, defs, renames);
    return c.json({ scope: scope.level, source: scope.level, statuses: defs, migrated_tasks });
  }
  const defs = parsePriorityDefs(body["priorities"]);
  if (renames.size > 0) {
    const slugs = new Set(defs.map((d) => d.slug));
    for (const to of renames.values()) {
      if (!slugs.has(to)) {
        throw badRequest(`rename target "${to}" is not in the new priorities`);
      }
    }
  }
  const { migrated_tasks } = await replacePriorityDefs(c.env, scope, defs, renames);
  return c.json({ scope: scope.level, source: scope.level, priorities: defs, migrated_tasks });
}

async function workflowDelete(
  c: Ctx,
  scope: DefScope,
  kind: "statuses" | "priorities",
) {
  if (kind === "statuses") await clearStatusDefs(c.env, scope);
  else await clearPriorityDefs(c.env, scope);
  return workflowGet(c, scope, kind);
}

function tenantScope(c: Ctx): DefScope {
  return { tenantId: c.req.param("tenantId") as string, level: "tenant" };
}

function workspaceScope(c: Ctx): DefScope {
  return {
    tenantId: c.req.param("tenantId") as string,
    level: "workspace",
    workspaceId: c.req.param("workspaceId") as string,
  };
}

function projectScope(c: Ctx): DefScope {
  const a = params(c);
  return {
    tenantId: a.tenantId,
    level: "project",
    workspaceId: a.workspaceId,
    projectId: a.projectId,
  };
}

async function guardScope(
  c: Ctx,
  principal: Principal,
  scope: DefScope,
  need: "read" | "write" | "admin",
) {
  if (scope.level === "tenant") {
    await loadTenant(c.env, scope.tenantId);
    return guard(c.env, principal, { tenantId: scope.tenantId }, need);
  }
  if (scope.level === "workspace") {
    await loadTenant(c.env, scope.tenantId);
    await loadWorkspace(c.env, scope.tenantId, scope.workspaceId as string);
    return guard(
      c.env,
      principal,
      { tenantId: scope.tenantId, workspaceId: scope.workspaceId as string },
      need,
    );
  }
  const a = params(c);
  await loadAncestry(c, a);
  return guardProject(c, principal, a, need);
}

for (const kind of ["statuses", "priorities"] as const) {
  workRoutes.get(`${TENANT_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = tenantScope(c);
    await guardScope(c, principal, scope, "read");
    return workflowGet(c, scope, kind);
  });
  workRoutes.put(`${TENANT_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = tenantScope(c);
    await guardScope(c, principal, scope, "admin");
    return workflowPut(c, scope, kind);
  });
  workRoutes.delete(`${TENANT_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = tenantScope(c);
    await guardScope(c, principal, scope, "admin");
    return workflowDelete(c, scope, kind);
  });
  workRoutes.get(`${WS_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = workspaceScope(c);
    await guardScope(c, principal, scope, "read");
    return workflowGet(c, scope, kind);
  });
  workRoutes.put(`${WS_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = workspaceScope(c);
    await guardScope(c, principal, scope, "admin");
    return workflowPut(c, scope, kind);
  });
  workRoutes.delete(`${WS_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = workspaceScope(c);
    await guardScope(c, principal, scope, "admin");
    return workflowDelete(c, scope, kind);
  });
  workRoutes.get(`${PROJECT_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = projectScope(c);
    await guardScope(c, principal, scope, "read");
    return workflowGet(c, scope, kind);
  });
  workRoutes.put(`${PROJECT_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = projectScope(c);
    await guardScope(c, principal, scope, "admin");
    return workflowPut(c, scope, kind);
  });
  workRoutes.delete(`${PROJECT_PATH}/workflow/${kind}`, async (c) => {
    const principal = await auth(c, c.req.param("tenantId") as string);
    const scope = projectScope(c);
    await guardScope(c, principal, scope, "admin");
    return workflowDelete(c, scope, kind);
  });
}

/* ------------------------------------------------------------------ */
/* Custom fields                                                        */
/* ------------------------------------------------------------------ */

workRoutes.post(`${PROJECT_PATH}/custom-fields`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "admin");
  const parsed = parseFieldDefInput(body, false);
  const row = await createFieldDef(c.env, {
    tenantId: a.tenantId,
    projectId: project.id,
    name: parsed.name as string,
    fieldType: parsed.fieldType as "text" | "number" | "date" | "select",
    options: parsed.options ?? [],
    sortOrder: parsed.sortOrder ?? 0,
    createdByAccountId: principal.accountId,
  });
  return c.json({ field: publicFieldDef(row) }, 201);
});

workRoutes.get(`${PROJECT_PATH}/custom-fields`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const defs = await listFieldDefs(c.env, a.projectId);
  return c.json({ fields: defs.map(publicFieldDef) });
});

workRoutes.delete(`${PROJECT_PATH}/custom-fields/:fieldId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "admin");
  const def = await loadFieldDef(c.env, a.projectId, c.req.param("fieldId") as string);
  await deleteFieldDef(c.env, def);
  return c.json({ ok: true });
});

workRoutes.get(`${TASK_PATH}/:taskId/custom-fields`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const defs = await listFieldDefs(c.env, a.projectId);
  const values = await listTaskFieldValues(c.env, task.id);
  const byField = new Map(values.map((v) => [v.field_id, v.value]));
  return c.json({
    fields: defs.map((d) => ({
      ...publicFieldDef(d),
      value: byField.get(d.id) ?? null,
    })),
  });
});

workRoutes.put(`${TASK_PATH}/:taskId/custom-fields`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const values = body["values"];
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw badRequest('"values" must be an object of field_id -> value');
  }
  for (const [fieldId, value] of Object.entries(values)) {
    const def = await loadFieldDef(c.env, a.projectId, fieldId);
    await setTaskFieldValue(c.env, {
      tenantId: a.tenantId,
      taskId: task.id,
      def,
      value,
      accountId: principal.accountId,
    });
  }
  const defs = await listFieldDefs(c.env, a.projectId);
  const stored = await listTaskFieldValues(c.env, task.id);
  const byField = new Map(stored.map((v) => [v.field_id, v.value]));
  return c.json({
    fields: defs.map((d) => ({
      ...publicFieldDef(d),
      value: byField.get(d.id) ?? null,
    })),
  });
});

/* ------------------------------------------------------------------ */
/* Comments and watchers                                                */
/* ------------------------------------------------------------------ */

workRoutes.post(`${TASK_PATH}/:taskId/comments`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const parsed = parseCommentBody(body);
  const mentions = await validateMentions(c.env, a.tenantId, parsed.mentions);
  const row = await createComment(c.env, principal, task, parsed.bodyEnc, mentions);
  return c.json({ comment: publicComment(row) }, 201);
});

workRoutes.get(`${TASK_PATH}/:taskId/comments`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const comments = await listComments(c.env, task.id);
  return c.json({ comments: comments.map(publicComment) });
});

workRoutes.patch(`${TASK_PATH}/:taskId/comments/:commentId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const current = await loadComment(c.env, task.id, c.req.param("commentId") as string);
  if (current.account_id !== principal.accountId) {
    throw forbidden("Only the author can edit a comment");
  }
  const parsed = parseCommentBody(body);
  const mentions = await validateMentions(c.env, a.tenantId, parsed.mentions);
  const row = await updateComment(c.env, current, parsed.bodyEnc, mentions);
  return c.json({ comment: publicComment(row) });
});

workRoutes.delete(`${TASK_PATH}/:taskId/comments/:commentId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  const { access } = await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const current = await loadComment(c.env, task.id, c.req.param("commentId") as string);
  if (current.account_id !== principal.accountId && !access.admin) {
    throw forbidden("Only the author or a project admin can delete a comment");
  }
  await deleteComment(c.env, current);
  return c.json({ ok: true });
});

workRoutes.get(`${TASK_PATH}/:taskId/watchers`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const watchers = await listWatcherIds(c.env, task.id);
  return c.json({
    watchers,
    watching: watchers.includes(principal.accountId),
  });
});

workRoutes.post(`${TASK_PATH}/:taskId/watch`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const target =
    typeof body["account_id"] === "string" && body["account_id"]
      ? (body["account_id"] as string)
      : principal.accountId;
  if (target !== principal.accountId) {
    const { access } = await guardProject(c, principal, a, "write");
    if (!access.admin) {
      throw forbidden("Adding another watcher requires a project admin");
    }
    const member = await c.env.DB.prepare(
      "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
    )
      .bind(a.tenantId, target)
      .first<{ account_id: string }>();
    if (!member) throw badRequest("Watcher is not a tenant member");
  }
  await addWatcher(c.env, task, target);
  return c.json({ watching: await isWatching(c.env, task.id, principal.accountId), watchers: await listWatcherIds(c.env, task.id) });
});

workRoutes.delete(`${TASK_PATH}/:taskId/watch`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  await removeWatcher(c.env, task.id, principal.accountId);
  return c.json({ watching: false, watchers: await listWatcherIds(c.env, task.id) });
});

/* ------------------------------------------------------------------ */
/* Attachments                                                          */
/* ------------------------------------------------------------------ */

workRoutes.post(`${TASK_PATH}/:taskId/attachments`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const rawName = c.req.header("x-file-name");
  if (!rawName) throw badRequest('"x-file-name" header is required');
  let filename: string;
  try {
    filename = decodeURIComponent(rawName);
  } catch {
    filename = rawName;
  }
  const buffer = await c.req.arrayBuffer();
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw badRequest("Attachment is too large");
  }
  await assertWithinLimits(c.env, a.tenantId, "attachment", buffer.byteLength);
  const row = await createAttachment(c.env, {
    tenantId: a.tenantId,
    taskId: task.id,
    accountId: principal.accountId,
    filename,
    contentType: c.req.header("content-type") ?? null,
    bytes: new Uint8Array(buffer),
  });
  await recordAudit(c.env, {
    tenantId: a.tenantId,
    workspaceId: a.workspaceId,
    accountId: principal.accountId,
    action: "attachment.create",
    targetType: "task",
    targetId: task.id,
    detail: filename.slice(0, 80),
  });
  return c.json({ attachment: publicAttachment(row) }, 201);
});

workRoutes.get(`${TASK_PATH}/:taskId/attachments`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const attachments = await listAttachments(c.env, task.id);
  return c.json({ attachments: attachments.map(publicAttachment) });
});

workRoutes.get(`${TENANT_PATH}/attachments/:attachmentId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const row = await loadAttachment(c.env, c.req.param("attachmentId") as string);
  if (row.tenant_id !== tenantId) throw notFound("Attachment not found");
  const task = await loadTaskAny(c.env, row.task_id);
  if (!task || !task.project_id || !task.team_id) throw notFound("Task not found");
  const project = await loadProjectScoped(c, task.project_id);
  await guardProjectRow(c, principal, project, "read");
  const bytes = await readAttachmentBytes(c.env, row);
  c.header("content-type", row.content_type ?? "application/octet-stream");
  c.header(
    "content-disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
  );
  return c.body(bytes.buffer as ArrayBuffer);
});

workRoutes.delete(`${TENANT_PATH}/attachments/:attachmentId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const row = await loadAttachment(c.env, c.req.param("attachmentId") as string);
  if (row.tenant_id !== tenantId) throw notFound("Attachment not found");
  const task = await loadTaskAny(c.env, row.task_id);
  if (!task || !task.project_id) throw notFound("Task not found");
  const project = await loadProjectScoped(c, task.project_id);
  await guardProjectRow(c, principal, project,
    row.account_id === principal.accountId ? "write" : "admin");
  await deleteAttachment(c.env, row);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* History and trash                                                    */
/* ------------------------------------------------------------------ */

workRoutes.get(`${TASK_PATH}/:taskId/history`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const history = await listTaskHistory(c.env, task.id);
  return c.json({ history: history.map((h) => publicHistory(h)) });
});

workRoutes.post(`${TASK_PATH}/:taskId/history/:historyId/restore`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  const { access } = await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const historyRow = await loadHistoryRow(
    c.env,
    task.id,
    c.req.param("historyId") as string,
  );
  const snapshot = JSON.parse(historyRow.snapshot_json) as Record<string, unknown>;
  const row = await restoreTaskFromSnapshot(c.env, task, snapshot, {
    accountId: principal.accountId,
    admin: access.admin,
  });
  return c.json({ task: publicTask(row) });
});

workRoutes.get(`${TENANT_PATH}/trash`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const admin = await isTenantAdmin(c, principal, tenantId);
  const trashedTasks = await listTrashedTasks(c.env, tenantId);
  const visibleTasks = [];
  for (const task of trashedTasks) {
    if (!task.project_id) continue;
    try {
      const project = await loadProjectScoped(c, task.project_id);
      await guardProjectRow(c, principal, project, "read");
      visibleTasks.push(task);
    } catch {
      // Not readable by this caller: skip silently.
    }
  }
  const trashedEntries = await listTrashedEntries(c.env, tenantId);
  const visibleEntries = admin
    ? trashedEntries
    : trashedEntries.filter((e) => e.account_id === principal.accountId);
  return c.json({
    tasks: visibleTasks.map(publicTask),
    time_entries: visibleEntries.map((e) => publicEntry(e)),
  });
});

workRoutes.post(`${TENANT_PATH}/trash/tasks/:taskId/restore`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const task = await loadTrashedTask(c.env, c.req.param("taskId") as string);
  if (task.tenant_id !== tenantId) throw notFound("Trashed task not found");
  if (!task.project_id) throw notFound("Task not found");
  const project = await loadProjectScoped(c, task.project_id);
  await guardProjectRow(c, principal, project, "write");
  const row = await restoreDeletedTask(c.env, task, {
    accountId: principal.accountId,
  });
  return c.json({ task: publicTask(row) });
});

workRoutes.delete(`${TENANT_PATH}/trash/tasks/:taskId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  if (!(await isTenantAdmin(c, principal, tenantId))) {
    throw forbidden("Purging the trash requires a tenant admin");
  }
  const task = await loadTrashedTask(c.env, c.req.param("taskId") as string);
  if (task.tenant_id !== tenantId) throw notFound("Trashed task not found");
  await purgeTask(c.env, task, principal.accountId);
  await recordAudit(c.env, {
    tenantId,
    accountId: principal.accountId,
    action: "task.purge",
    targetType: "task",
    targetId: task.id,
    detail: task.title.slice(0, 80),
  });
  return c.json({ ok: true });
});

workRoutes.post(`${TENANT_PATH}/trash/time-entries/:entryId/restore`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const entry = await loadTrashedEntry(c.env, c.req.param("entryId") as string);
  if (entry.tenant_id !== tenantId) throw notFound("Trashed entry not found");
  const admin = await isTenantAdmin(c, principal, tenantId);
  if (entry.account_id !== principal.accountId && !admin) {
    throw forbidden("Only the owner or a tenant admin can restore an entry");
  }
  const row = await restoreDeletedEntry(c.env, entry, {
    accountId: principal.accountId,
    admin,
  });
  return c.json({ entry: publicEntry(row) });
});

workRoutes.delete(`${TENANT_PATH}/trash/time-entries/:entryId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  if (!(await isTenantAdmin(c, principal, tenantId))) {
    throw forbidden("Purging the trash requires a tenant admin");
  }
  const entry = await loadTrashedEntry(c.env, c.req.param("entryId") as string);
  if (entry.tenant_id !== tenantId) throw notFound("Trashed entry not found");
  await purgeEntry(c.env, entry, principal.accountId);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Recurrence, templates, duplication, bulk edit, recent                */
/* ------------------------------------------------------------------ */

workRoutes.get(`${TASK_PATH}/:taskId/recurrence`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const rule = await getRecurrenceRule(c.env, task.id);
  return c.json({ recurrence: rule ? publicRecurrence(rule) : null });
});

workRoutes.put(`${TASK_PATH}/:taskId/recurrence`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const input = parseRecurrenceInput(body);
  const rule = await putRecurrenceRule(c.env, principal, task, input);
  return c.json({ recurrence: publicRecurrence(rule) });
});

workRoutes.delete(`${TASK_PATH}/:taskId/recurrence`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  await deleteRecurrenceRule(c.env, task.id);
  return c.json({ ok: true });
});

workRoutes.post(`${PROJECT_PATH}/task-templates`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const name = body["name"];
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 120) {
    throw badRequest('"name" must be 1-120 characters');
  }
  const payload = parseTemplatePayload(body);
  const row = await createTemplate(c.env, principal, project, name.trim(), payload);
  return c.json({ template: publicTemplate(row) }, 201);
});

workRoutes.get(`${PROJECT_PATH}/task-templates`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const templates = await listTemplates(c.env, a.projectId);
  return c.json({ templates: templates.map(publicTemplate) });
});

workRoutes.delete(`${PROJECT_PATH}/task-templates/:templateId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const template = await loadTemplate(c.env, a.projectId, c.req.param("templateId") as string);
  await deleteTemplate(c.env, template);
  return c.json({ ok: true });
});

workRoutes.post(`${PROJECT_PATH}/task-templates/:templateId/instantiate`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const template = await loadTemplate(c.env, a.projectId, c.req.param("templateId") as string);
  const baseDate = body["base_date"];
  if (!isDateString(baseDate)) {
    throw badRequest('"base_date" must be a YYYY-MM-DD date');
  }
  const assignee =
    typeof body["assignee_account_id"] === "string"
      ? (body["assignee_account_id"] as string)
      : null;
  const created = await instantiateTemplate(
    c.env,
    principal,
    project,
    template,
    baseDate,
    assignee,
  );
  return c.json({ tasks: created.map(publicTask) }, 201);
});

workRoutes.post(`${TASK_PATH}/:taskId/duplicate`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const result = await duplicateTask(c.env, principal, project, task, {
    includeSubtasks: body["include_subtasks"] !== false,
    title: typeof body["title"] === "string" ? (body["title"] as string) : undefined,
  });
  return c.json(
    { task: publicTask(result.root), created: result.created.map(publicTask) },
    201,
  );
});

workRoutes.post(`${PROJECT_PATH}/tasks/bulk`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  const { access } = await guardProject(c, principal, a, "write");
  const taskIds = body["task_ids"];
  if (
    !Array.isArray(taskIds) ||
    taskIds.length === 0 ||
    taskIds.length > 200 ||
    taskIds.some((id) => typeof id !== "string")
  ) {
    throw badRequest('"task_ids" must be an array of 1-200 task ids');
  }
  const patch = body["patch"];
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw badRequest('"patch" must be an object');
  }
  const p = patch as Record<string, unknown>;
  const results: { task_id: string; ok: boolean; error?: string }[] = [];
  for (const taskId of taskIds as string[]) {
    try {
      const task = await loadTask(c.env, a.projectId, taskId);
      let current = task;
      const fieldPatch: Record<string, unknown> = {};
      if (p["status"] !== undefined) fieldPatch["status"] = p["status"];
      if (p["priority"] !== undefined) fieldPatch["priority"] = p["priority"];
      if (p["assignee_account_id"] !== undefined) {
        fieldPatch["assignee_account_id"] = p["assignee_account_id"];
      }
      if (Object.keys(fieldPatch).length > 0) {
        const before = current;
        current = await applyTaskPatch(
          c.env,
          current,
          parseTaskInput(fieldPatch, true),
          { accountId: principal.accountId, admin: access.admin },
        );
        if (
          fieldPatch["assignee_account_id"] !== undefined &&
          current.assignee_account_id &&
          current.assignee_account_id !== before.assignee_account_id
        ) {
          await dispatchNotifications(c.env, {
            kind: "task_assigned",
            tenantId: a.tenantId,
            actorAccountId: principal.accountId,
            recipientIds: [current.assignee_account_id],
            title: `タスク「${current.title}」が割り当てられました`,
            payload: { task_id: current.id, project_id: a.projectId },
            relatedType: "task",
            relatedId: current.id,
          });
        }
      }
      if (Array.isArray(p["add_label_ids"])) {
        for (const labelId of p["add_label_ids"] as unknown[]) {
          if (typeof labelId !== "string") continue;
          const label = await loadLabel(c.env, labelId);
          await attachLabel(c.env, current, label);
        }
      }
      if (Array.isArray(p["remove_label_ids"])) {
        for (const labelId of p["remove_label_ids"] as unknown[]) {
          if (typeof labelId !== "string") continue;
          await detachLabel(c.env, current.id, labelId);
        }
      }
      if (typeof p["archived"] === "boolean") {
        if (p["archived"] && !current.archived_at) {
          current = await setTaskArchived(c.env, current, true, {
            accountId: principal.accountId,
          });
        } else if (!p["archived"] && current.archived_at) {
          current = await setTaskArchived(c.env, current, false, {
            accountId: principal.accountId,
          });
        }
      }
      results.push({ task_id: taskId, ok: true });
    } catch (err) {
      results.push({
        task_id: taskId,
        ok: false,
        error: err instanceof Error ? err.message : "failed",
      });
    }
  }
  return c.json({ results });
});

workRoutes.post(`${TASK_PATH}/:taskId/archive`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  const archived = body["archived"] !== false;
  const row = await setTaskArchived(c.env, task, archived, {
    accountId: principal.accountId,
  });
  return c.json({ task: publicTask(row) });
});

workRoutes.get("/api/v1/me/recent", async (c) => {
  const principal = await auth(c);
  const tenantId = c.req.query("tenant_id") ?? null;
  if (tenantId) {
    await loadTenant(c.env, tenantId);
    await guard(c.env, principal, { tenantId }, "read");
  }
  const items = await listRecent(c.env, principal.accountId, tenantId);
  return c.json({ items });
});

