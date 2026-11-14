/**
 * Phase-2 core API: tasks, time entries, timers, dependencies,
 * milestones, estimates vs actuals, the Gantt data feed and the personal
 * dashboard.
 *
 *   POST/GET   .../projects/:projectId/tasks
 *   GET/PATCH/DELETE .../tasks/:taskId
 *   POST/GET   .../tasks/:taskId/time-entries
 *   PATCH/DELETE /api/v1/tenants/:tenantId/time-entries/:entryId
 *   POST       /api/v1/tenants/:tenantId/timer/start | /timer/stop
 *   GET        /api/v1/tenants/:tenantId/time-entries (mine)
 *   POST/GET   .../projects/:projectId/dependencies
 *   DELETE     .../projects/:projectId/dependencies/:dependencyId
 *   POST/GET   .../projects/:projectId/milestones
 *   PATCH/DELETE .../projects/:projectId/milestones/:milestoneId
 *   GET        .../projects/:projectId/estimates
 *   GET        /api/v1/projects/:projectId/gantt   (project-scoped)
 *   GET        /api/v1/tenants/:tenantId/dashboard
 */
import { Hono } from "hono";
import { recordAudit } from "../audit";
import { badRequest, forbidden, notFound } from "../errors";
import {
  guard,
  loadProject,
  loadTeam,
  loadTenant,
  loadWorkspace,
} from "../hierarchy";
import {
  applyEntryPatch,
  applyMilestonePatch,
  applyTaskPatch,
  dashboard,
  estimateVsActual,
  insertDependency,
  insertEntry,
  insertMilestone,
  insertTask,
  listDependencies,
  listEntriesForAccount,
  listEntriesForTask,
  listMilestones,
  listTasks,
  loadDependencyAny,
  loadEntry,
  loadMilestoneAny,
  loadTask,
  loadTaskAny,
  parseEntryInput,
  parseMilestoneInput,
  parseTaskInput,
  publicDependency,
  publicEntry,
  publicMilestone,
  publicTask,
  softDeleteDependency,
  softDeleteEntry,
  softDeleteMilestone,
  softDeleteTask,
  startTimer,
  stopTimer,
  type TaskInput,
} from "../tasks";
import { listWatcherIds } from "../comments";
import {
  applyTaskFilter,
  taskIdsWithLabel,
  type TaskFilterQuery,
} from "../labels";
import { runAutomationRules } from "../automation";
import { dispatchNotifications } from "../notify";
import { getUserPrefs } from "../prefs";
import { assertWithinLimits } from "../usage";
import { recordView } from "../planning";
import { resolvePriorities, resolveStatuses } from "../workflow";
import { base64UrlToUtf8, utf8ToBase64Url } from "../tokens";
import { isDateString } from "../timecalc";
import type { Env, Principal, ProjectRow, Variables } from "../types";
import { auth, queryInt, readJsonBody, type Ctx } from "./http";

export const taskRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const PROJECT_PATH =
  "/api/v1/tenants/:tenantId/workspaces/:workspaceId/teams/:teamId/projects/:projectId";
const TASK_PATH = `${PROJECT_PATH}/tasks`;
const TENANT_PATH = "/api/v1/tenants/:tenantId";

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

/** Reject status/priority slugs outside the project's workflow defs. */
async function assertWorkflowSlugs(
  c: Ctx,
  a: Ancestry,
  status: string | undefined,
  priority: string | undefined,
): Promise<void> {
  const ctx = {
    tenantId: a.tenantId,
    workspaceId: a.workspaceId,
    projectId: a.projectId,
  };
  if (status !== undefined) {
    const { defs } = await resolveStatuses(c.env, ctx);
    if (!defs.some((d) => d.slug === status)) {
      throw badRequest(`Unknown status "${status}" for this project`);
    }
  }
  if (priority !== undefined) {
    const { defs } = await resolvePriorities(c.env, ctx);
    if (!defs.some((d) => d.slug === priority)) {
      throw badRequest(`Unknown priority "${priority}" for this project`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tasks                                                                */
/* ------------------------------------------------------------------ */

taskRoutes.post(TASK_PATH, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const parsed = parseTaskInput(body, false);
  await assertWorkflowSlugs(
    c,
    a,
    parsed.status ?? "todo",
    parsed.priority ?? "medium",
  );
  const input: TaskInput = {
    title: parsed.title as string,
    descriptionEnc: parsed.descriptionEnc ?? null,
    status: parsed.status ?? "todo",
    priority: parsed.priority ?? "medium",
    assigneeAccountId: parsed.assigneeAccountId ?? null,
    parentTaskId: parsed.parentTaskId ?? null,
    startDate: parsed.startDate ?? null,
    dueDate: parsed.dueDate ?? null,
    sortOrder: parsed.sortOrder ?? 0,
    estimateMinutes: parsed.estimateMinutes ?? null,
    estimatePoints: parsed.estimatePoints ?? null,
    estimateSize: parsed.estimateSize ?? null,
  };
  await assertWithinLimits(c.env, a.tenantId, "task");
  const row = await insertTask(c.env, project, input, {
    accountId: principal.accountId,
  });
  await recordAudit(c.env, {
    tenantId: a.tenantId,
    workspaceId: a.workspaceId,
    accountId: principal.accountId,
    action: "task.create",
    targetType: "task",
    targetId: row.id,
    detail: row.title.slice(0, 80),
  });
  if (row.assignee_account_id) {
    await dispatchNotifications(c.env, {
      kind: "task_assigned",
      tenantId: a.tenantId,
      actorAccountId: principal.accountId,
      recipientIds: [row.assignee_account_id],
      title: `タスク「${row.title}」が割り当てられました`,
      payload: { task_id: row.id, project_id: a.projectId },
      relatedType: "task",
      relatedId: row.id,
    });
  }
  await runAutomationRules(c.env, {
    tenantId: a.tenantId,
    trigger: "task_created",
    task: row,
    actorAccountId: principal.accountId,
  });
  if (row.assignee_account_id) {
    await runAutomationRules(c.env, {
      tenantId: a.tenantId,
      trigger: "task_assigned",
      task: row,
      actorAccountId: principal.accountId,
    });
  }
  // Rules may have changed the task; answer with the current state.
  const fresh = (await loadTaskAny(c.env, row.id)) ?? row;
  return c.json({ task: publicTask(fresh) }, 201);
});

taskRoutes.get(TASK_PATH, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  // Optional filter query params (the saved-filter parameter set):
  // q, status, priority, assignee_account_id, label_id, due_from,
  // due_to, include_archived=1. Comma separates multi-value params.
  const split = (v: string | undefined) =>
    v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const filter: TaskFilterQuery = {
    q: c.req.query("q"),
    status: split(c.req.query("status")),
    priority: split(c.req.query("priority")),
    assignee_account_id: c.req.query("assignee_account_id"),
    label_ids: split(c.req.query("label_id")),
    due_from: c.req.query("due_from") ?? undefined,
    due_to: c.req.query("due_to") ?? undefined,
    include_archived: c.req.query("include_archived") === "1",
  };
  const all = await listTasks(c.env, a.projectId, { includeArchived: true });
  let labelMap: Map<string, Set<string>> | undefined;
  if (filter.label_ids && filter.label_ids.length > 0) {
    labelMap = new Map();
    for (const labelId of filter.label_ids) {
      const ids = await taskIdsWithLabel(c.env, labelId);
      for (const id of ids) {
        const set = labelMap.get(id) ?? new Set<string>();
        set.add(labelId);
        labelMap.set(id, set);
      }
    }
  }
  const tasks = applyTaskFilter(all, filter, labelMap);
  // Phase 5: optional keyset pagination. Without `limit` the full list
  // is returned (phase 1-4 behaviour). With `limit`, the response adds
  // `next_cursor`; pass it back as `cursor` for the following page.
  // The cursor pins the (sort_order, created_at, id) of the last row.
  const limitRaw = c.req.query("limit");
  if (limitRaw === undefined) {
    return c.json({ tasks: tasks.map(publicTask) });
  }
  const limit = queryInt(c, "limit", 50, 1, 200);
  let start = 0;
  const cursorRaw = c.req.query("cursor");
  if (cursorRaw) {
    let cursor: { s: number; c: string; i: string } | null = null;
    try {
      const parsed: unknown = JSON.parse(base64UrlToUtf8(cursorRaw));
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { s?: unknown }).s === "number" &&
        typeof (parsed as { c?: unknown }).c === "string" &&
        typeof (parsed as { i?: unknown }).i === "string"
      ) {
        cursor = parsed as { s: number; c: string; i: string };
      }
    } catch {
      cursor = null;
    }
    if (!cursor) throw badRequest('"cursor" is not a valid pagination cursor');
    const cur = cursor as { s: number; c: string; i: string };
    // Prefer locating the cursor row by id: robust even when the
    // (sort_order, created_at) prefix ties. Fall back to the tuple
    // comparison when the row is gone (deleted between pages).
    const byId = tasks.findIndex((t) => t.id === cur.i);
    if (byId >= 0) {
      start = byId + 1;
    } else {
      const idx = tasks.findIndex(
        (t) =>
          Number(t.sort_order) > cur.s ||
          (Number(t.sort_order) === cur.s &&
            (t.created_at > cur.c ||
              (t.created_at === cur.c && t.id > cur.i))),
      );
      start = idx === -1 ? tasks.length : idx;
    }
  }
  const page = tasks.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor =
    start + limit < tasks.length && last
      ? utf8ToBase64Url(
          JSON.stringify({
            s: Number(last.sort_order),
            c: last.created_at,
            i: last.id,
          }),
        )
      : null;
  return c.json({ tasks: page.map(publicTask), next_cursor: nextCursor });
});

taskRoutes.get(`${TASK_PATH}/:taskId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const row = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
  await recordView(c.env, principal.accountId, a.tenantId, "task", row.id);
  return c.json({ task: publicTask(row) });
});

taskRoutes.patch(`${TASK_PATH}/:taskId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const current = await loadTask(
    c.env,
    a.projectId,
    c.req.param("taskId") as string,
  );
  // REST writes validate status/priority against the project's
  // resolved workflow definitions (sync pushes stay free-form).
  const parsed = parseTaskInput(body, true);
  await assertWorkflowSlugs(c, a, parsed.status, parsed.priority);
  const row = await applyTaskPatch(c.env, current, parsed, {
    accountId: principal.accountId,
  });
  if (
    row.assignee_account_id &&
    row.assignee_account_id !== current.assignee_account_id
  ) {
    await dispatchNotifications(c.env, {
      kind: "task_assigned",
      tenantId: a.tenantId,
      actorAccountId: principal.accountId,
      recipientIds: [row.assignee_account_id],
      title: `タスク「${row.title}」が割り当てられました`,
      payload: { task_id: row.id, project_id: a.projectId },
      relatedType: "task",
      relatedId: row.id,
    });
  } else if (row.status !== current.status) {
    const watchers = await listWatcherIds(c.env, row.id);
    await dispatchNotifications(c.env, {
      kind: "task_updated",
      tenantId: a.tenantId,
      actorAccountId: principal.accountId,
      recipientIds: watchers,
      title: `「${row.title}」のステータスが ${row.status} になりました`,
      payload: {
        task_id: row.id,
        project_id: a.projectId,
        from_status: current.status,
        to_status: row.status,
      },
      relatedType: "task",
      relatedId: row.id,
    });
  }
  if (row.status !== current.status) {
    await runAutomationRules(c.env, {
      tenantId: a.tenantId,
      trigger: "task_status_changed",
      task: row,
      before: {
        status: current.status,
        assigneeAccountId: current.assignee_account_id,
      },
      actorAccountId: principal.accountId,
    });
  }
  if (row.assignee_account_id !== current.assignee_account_id) {
    await runAutomationRules(c.env, {
      tenantId: a.tenantId,
      trigger: "task_assigned",
      task: row,
      before: {
        status: current.status,
        assigneeAccountId: current.assignee_account_id,
      },
      actorAccountId: principal.accountId,
    });
  }
  // Rules may have changed the task; answer with the current state.
  const fresh = (await loadTaskAny(c.env, row.id)) ?? row;
  return c.json({ task: publicTask(fresh) });
});

taskRoutes.delete(`${TASK_PATH}/:taskId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const current = await loadTask(
    c.env,
    a.projectId,
    c.req.param("taskId") as string,
  );
  await softDeleteTask(c.env, current, { accountId: principal.accountId });
  await recordAudit(c.env, {
    tenantId: a.tenantId,
    workspaceId: a.workspaceId,
    accountId: principal.accountId,
    action: "task.delete",
    targetType: "task",
    targetId: current.id,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Time entries                                                         */
/* ------------------------------------------------------------------ */

taskRoutes.post(`${TASK_PATH}/:taskId/time-entries`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const task = await loadTask(
    c.env,
    a.projectId,
    c.req.param("taskId") as string,
  );
  const parsed = parseEntryInput(body, false);
  const row = await insertEntry(
    c.env,
    {
      tenantId: a.tenantId,
      workspaceId: project.workspace_id,
      taskId: task.id,
      accountId: principal.accountId,
      startedAt: parsed.startedAt as string,
      endedAt: parsed.endedAt ?? null,
      durationSeconds: parsed.durationSeconds ?? null,
      noteEnc: parsed.noteEnc ?? null,
    },
    { accountId: principal.accountId },
  );
  return c.json({ entry: publicEntry(row) }, 201);
});

taskRoutes.get(`${TASK_PATH}/:taskId/time-entries`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const task = await loadTask(
    c.env,
    a.projectId,
    c.req.param("taskId") as string,
  );
  const entries = await listEntriesForTask(c.env, task.id);
  return c.json({ entries: entries.map((e) => publicEntry(e)) });
});

/**
 * Entries are editable by their owner or a project admin of the task.
 * Returns whether the actor acts as an admin (freeze bypass, see
 * src/locks.ts).
 */
async function assertEntryWritable(
  c: Ctx,
  principal: Principal,
  entry: { account_id: string; tenant_id: string; task_id: string | null },
): Promise<boolean> {
  if (entry.account_id === principal.accountId) return false;
  if (entry.task_id) {
    const taskRow = await c.env.DB.prepare(
      "SELECT * FROM tasks WHERE id = ?1",
    )
      .bind(entry.task_id)
      .first<{ project_id: string | null; tenant_id: string; workspace_id: string; team_id: string | null }>();
    if (taskRow?.project_id && taskRow.team_id) {
      const { access } = await guard(
        c.env,
        principal,
        {
          tenantId: taskRow.tenant_id,
          workspaceId: taskRow.workspace_id,
          teamId: taskRow.team_id,
          projectId: taskRow.project_id,
        },
        "read",
      );
      if (access.admin) return true;
    }
  }
  const { chain } = await guard(
    c.env,
    principal,
    { tenantId: entry.tenant_id },
    "read",
  );
  if (chain.tenant === "owner" || chain.tenant === "admin") return true;
  throw forbidden("Only the entry owner or an admin can change this entry");
}

taskRoutes.patch(`${TENANT_PATH}/time-entries/:entryId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const entry = await loadEntry(c.env, c.req.param("entryId") as string);
  if (entry.tenant_id !== tenantId) throw notFound("Time entry not found");
  const admin = await assertEntryWritable(c, principal, entry);
  const row = await applyEntryPatch(c.env, entry, parseEntryInput(body, true), {
    accountId: principal.accountId,
    admin,
  });
  return c.json({ entry: publicEntry(row) });
});

taskRoutes.delete(`${TENANT_PATH}/time-entries/:entryId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const entry = await loadEntry(c.env, c.req.param("entryId") as string);
  if (entry.tenant_id !== tenantId) throw notFound("Time entry not found");
  const admin = await assertEntryWritable(c, principal, entry);
  await softDeleteEntry(c.env, entry, {
    accountId: principal.accountId,
    admin,
  });
  return c.json({ ok: true });
});

taskRoutes.get(`${TENANT_PATH}/time-entries`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const entries = await listEntriesForAccount(
    c.env,
    tenantId,
    principal.accountId,
  );
  const from = c.req.query("from");
  const to = c.req.query("to");
  const filtered = entries.filter(
    (e) =>
      (!from || e.started_at >= from) && (!to || e.started_at < to),
  );
  return c.json({ entries: filtered.map((e) => publicEntry(e)) });
});

/* ------------------------------------------------------------------ */
/* Timer                                                                */
/* ------------------------------------------------------------------ */

taskRoutes.post(`${TENANT_PATH}/timer/start`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const taskId =
    typeof body["task_id"] === "string" && body["task_id"]
      ? (body["task_id"] as string)
      : null;
  let workspaceId: string;
  if (taskId) {
    const task = await c.env.DB.prepare(
      "SELECT * FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
    )
      .bind(taskId)
      .first<{
        project_id: string | null;
        tenant_id: string;
        workspace_id: string;
        team_id: string | null;
      }>();
    if (!task || task.tenant_id !== tenantId || !task.project_id || !task.team_id) {
      throw notFound("Task not found");
    }
    await guard(
      c.env,
      principal,
      {
        tenantId,
        workspaceId: task.workspace_id,
        teamId: task.team_id,
        projectId: task.project_id,
      },
      "write",
    );
    workspaceId = task.workspace_id;
  } else {
    const raw = body["workspace_id"];
    if (typeof raw !== "string" || !raw) {
      throw badRequest('"workspace_id" is required when no task is given');
    }
    await loadWorkspace(c.env, tenantId, raw);
    await guard(c.env, principal, { tenantId, workspaceId: raw }, "write");
    workspaceId = raw;
  }
  const row = await startTimer(c.env, principal, {
    tenantId,
    workspaceId,
    taskId,
  });
  return c.json({ entry: publicEntry(row) }, 201);
});

taskRoutes.post(`${TENANT_PATH}/timer/stop`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const row = await stopTimer(c.env, principal, tenantId);
  return c.json({ entry: publicEntry(row) });
});

/* ------------------------------------------------------------------ */
/* Dependencies and milestones                                          */
/* ------------------------------------------------------------------ */

taskRoutes.post(`${PROJECT_PATH}/dependencies`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const taskId = body["task_id"];
  const dependsOnId = body["depends_on_task_id"];
  if (typeof taskId !== "string" || typeof dependsOnId !== "string") {
    throw badRequest('"task_id" and "depends_on_task_id" are required');
  }
  const row = await insertDependency(c.env, project, taskId, dependsOnId, {
    accountId: principal.accountId,
  });
  return c.json({ dependency: publicDependency(row) }, 201);
});

taskRoutes.get(`${PROJECT_PATH}/dependencies`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const deps = await listDependencies(c.env, a.projectId);
  return c.json({ dependencies: deps.map(publicDependency) });
});

taskRoutes.delete(`${PROJECT_PATH}/dependencies/:dependencyId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const dep = await loadDependencyAny(
    c.env,
    c.req.param("dependencyId") as string,
  );
  if (!dep || dep.project_id !== a.projectId || dep.deleted_at) {
    throw notFound("Dependency not found");
  }
  await softDeleteDependency(c.env, dep, { accountId: principal.accountId });
  return c.json({ ok: true });
});

taskRoutes.post(`${PROJECT_PATH}/milestones`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const parsed = parseMilestoneInput(body, false);
  const row = await insertMilestone(
    c.env,
    project,
    { name: parsed.name as string, date: parsed.date as string },
    { accountId: principal.accountId },
  );
  return c.json({ milestone: publicMilestone(row) }, 201);
});

taskRoutes.get(`${PROJECT_PATH}/milestones`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const milestones = await listMilestones(c.env, a.projectId);
  return c.json({ milestones: milestones.map(publicMilestone) });
});

taskRoutes.patch(`${PROJECT_PATH}/milestones/:milestoneId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const current = await loadMilestoneAny(
    c.env,
    c.req.param("milestoneId") as string,
  );
  if (!current || current.project_id !== a.projectId || current.deleted_at) {
    throw notFound("Milestone not found");
  }
  const row = await applyMilestonePatch(
    c.env,
    current,
    parseMilestoneInput(body, true),
    { accountId: principal.accountId },
  );
  return c.json({ milestone: publicMilestone(row) });
});

taskRoutes.delete(`${PROJECT_PATH}/milestones/:milestoneId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "write");
  const current = await loadMilestoneAny(
    c.env,
    c.req.param("milestoneId") as string,
  );
  if (!current || current.project_id !== a.projectId || current.deleted_at) {
    throw notFound("Milestone not found");
  }
  await softDeleteMilestone(c.env, current, {
    accountId: principal.accountId,
  });
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Estimates, Gantt feed, dashboard                                     */
/* ------------------------------------------------------------------ */

taskRoutes.get(`${PROJECT_PATH}/estimates`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const project = await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  return c.json(await estimateVsActual(c.env, project));
});

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

taskRoutes.get("/api/v1/projects/:projectId/gantt", async (c) => {
  const projectId = c.req.param("projectId") as string;
  const principal = await auth(c);
  const project = await loadProjectScoped(c, projectId);
  await guard(
    c.env,
    principal,
    {
      tenantId: project.tenant_id,
      workspaceId: project.workspace_id,
      teamId: project.team_id,
      projectId: project.id,
    },
    "read",
  );
  const [tasks, dependencies, milestones] = await Promise.all([
    listTasks(c.env, projectId),
    listDependencies(c.env, projectId),
    listMilestones(c.env, projectId),
  ]);
  return c.json({
    project: {
      id: project.id,
      tenant_id: project.tenant_id,
      workspace_id: project.workspace_id,
      team_id: project.team_id,
      name: project.name,
      color: project.color,
      starts_on: project.starts_on,
      due_on: project.due_on,
    },
    tasks: tasks.map(publicTask),
    dependencies: dependencies.map(publicDependency),
    milestones: milestones.map(publicMilestone),
  });
});

taskRoutes.get(`${TENANT_PATH}/dashboard`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const date = c.req.query("date");
  if (!isDateString(date)) {
    throw badRequest('"date" query (YYYY-MM-DD, local) is required');
  }
  const tz = queryInt(c, "tz", 0, -840, 840);
  // Week start: explicit query wins, then the caller's saved display
  // preference (phase 5), then Monday.
  let weekStartDow = 1;
  if (c.req.query("week_start") !== undefined) {
    weekStartDow = queryInt(c, "week_start", 1, 1, 7);
  } else {
    const prefs = await getUserPrefs(c.env, principal.accountId);
    weekStartDow = prefs.week_start;
  }
  return c.json(
    await dashboard(
      c.env,
      principal,
      tenantId,
      date,
      tz,
      undefined,
      weekStartDow,
    ),
  );
});
