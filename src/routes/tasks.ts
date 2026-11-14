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
  const input: TaskInput = {
    title: parsed.title as string,
    descriptionEnc: parsed.descriptionEnc ?? null,
    status: parsed.status ?? "todo",
    assigneeAccountId: parsed.assigneeAccountId ?? null,
    parentTaskId: parsed.parentTaskId ?? null,
    startDate: parsed.startDate ?? null,
    dueDate: parsed.dueDate ?? null,
    sortOrder: parsed.sortOrder ?? 0,
    estimateMinutes: parsed.estimateMinutes ?? null,
  };
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
  return c.json({ task: publicTask(row) }, 201);
});

taskRoutes.get(TASK_PATH, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const tasks = await listTasks(c.env, a.projectId);
  return c.json({ tasks: tasks.map(publicTask) });
});

taskRoutes.get(`${TASK_PATH}/:taskId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadAncestry(c, a);
  await guardProject(c, principal, a, "read");
  const row = await loadTask(c.env, a.projectId, c.req.param("taskId") as string);
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
  const row = await applyTaskPatch(
    c.env,
    current,
    parseTaskInput(body, true),
    { accountId: principal.accountId },
  );
  return c.json({ task: publicTask(row) });
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

/** Entries are editable by their owner or a project admin of the task. */
async function assertEntryWritable(
  c: Ctx,
  principal: Principal,
  entry: { account_id: string; tenant_id: string; task_id: string | null },
): Promise<void> {
  if (entry.account_id === principal.accountId) return;
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
      if (access.admin) return;
    }
  }
  const { chain } = await guard(
    c.env,
    principal,
    { tenantId: entry.tenant_id },
    "read",
  );
  if (chain.tenant === "owner" || chain.tenant === "admin") return;
  throw forbidden("Only the entry owner or an admin can change this entry");
}

taskRoutes.patch(`${TENANT_PATH}/time-entries/:entryId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const entry = await loadEntry(c.env, c.req.param("entryId") as string);
  if (entry.tenant_id !== tenantId) throw notFound("Time entry not found");
  await assertEntryWritable(c, principal, entry);
  const row = await applyEntryPatch(c.env, entry, parseEntryInput(body, true), {
    accountId: principal.accountId,
  });
  return c.json({ entry: publicEntry(row) });
});

taskRoutes.delete(`${TENANT_PATH}/time-entries/:entryId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  const entry = await loadEntry(c.env, c.req.param("entryId") as string);
  if (entry.tenant_id !== tenantId) throw notFound("Time entry not found");
  await assertEntryWritable(c, principal, entry);
  await softDeleteEntry(c.env, entry, { accountId: principal.accountId });
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
  return c.json(await dashboard(c.env, principal, tenantId, date, tz));
});
