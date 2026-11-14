/**
 * MCP tool catalog and dispatcher (phase 4).
 *
 * The tools are thin adapters over the same service layer the REST API
 * uses (src/tasks.ts, src/integrations.ts, ...), so permissions,
 * workflow validation, sync change-log writes and history all behave
 * identically. Every tool takes an explicit tenant_id, except that an
 * API-key principal is bound to its key's tenant and may omit it.
 *
 * Read/write classification drives scope enforcement for API keys:
 * a read-only key may call read tools even though the MCP transport
 * itself is POST (see src/routes/mcp.ts).
 */
import { badRequest, forbidden, notFound } from "./errors";
import {
  guard,
  listProjects,
  listTeams,
  listTenants,
  listWorkspaces,
  loadProject,
  loadTeam,
  loadTenant,
  loadWorkspace,
  publicProject,
  publicTenant,
} from "./hierarchy";
import {
  latestRunFor,
  listConnections,
  loadConnection,
  publicConnection,
  publicSyncRun,
  runConnectionSync,
} from "./integrations";
import { addLink, listLinks, parseLinkInput, publicLink } from "./links";
import { resolvePriorities, resolveStatuses } from "./workflow";
import {
  applyTaskPatch,
  dashboard,
  insertEntry,
  insertTask,
  listDependencies,
  listEntriesForAccount,
  listMilestones,
  listTasks,
  loadTask,
  parseEntryInput,
  parseTaskInput,
  publicDependency,
  publicEntry,
  publicMilestone,
  publicTask,
  startTimer,
  stopTimer,
  type TaskInput,
} from "./tasks";
import type { Env, Principal, ProjectRow } from "./types";

export interface McpTool {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}

const TENANT_PROP = {
  tenant_id: {
    type: "string",
    description:
      "Tenant id. Required for session auth; for API keys it must match the key's tenant and may be omitted.",
  },
};
const PROJECT_PROP = { project_id: { type: "string" } };

function schema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "kosu_list_tenants",
    description: "List the tenants the caller belongs to (internal ids only).",
    readOnly: true,
    inputSchema: schema({}, []),
  },
  {
    name: "kosu_list_projects",
    description:
      "List all projects in a tenant that the caller can read, flattened across workspaces and teams.",
    readOnly: true,
    inputSchema: schema({ ...TENANT_PROP }, ["tenant_id"]),
  },
  {
    name: "kosu_list_tasks",
    description: "List tasks in a project (archived tasks excluded unless include_archived is true).",
    readOnly: true,
    inputSchema: schema(
      {
        ...TENANT_PROP,
        ...PROJECT_PROP,
        include_archived: { type: "boolean" },
      },
      ["tenant_id", "project_id"],
    ),
  },
  {
    name: "kosu_create_task",
    description:
      "Create a task in a project. description_enc must be client-side ciphertext (the server never sees plaintext bodies).",
    readOnly: false,
    inputSchema: schema(
      {
        ...TENANT_PROP,
        ...PROJECT_PROP,
        title: { type: "string" },
        description_enc: { type: "string" },
        status: { type: "string", description: "Workflow status slug (default: todo)" },
        priority: { type: "string", description: "Priority slug (default: medium)" },
        assignee_account_id: { type: "string" },
        parent_task_id: { type: "string" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        due_date: { type: "string", description: "YYYY-MM-DD" },
        sort_order: { type: "integer" },
        estimate_minutes: { type: "integer" },
      },
      ["tenant_id", "project_id", "title"],
    ),
  },
  {
    name: "kosu_update_task",
    description: "Update fields of one task (partial patch).",
    readOnly: false,
    inputSchema: schema(
      {
        ...TENANT_PROP,
        ...PROJECT_PROP,
        task_id: { type: "string" },
        title: { type: "string" },
        description_enc: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        assignee_account_id: { type: "string" },
        parent_task_id: { type: "string" },
        start_date: { type: "string" },
        due_date: { type: "string" },
        sort_order: { type: "integer" },
        estimate_minutes: { type: "integer" },
      },
      ["tenant_id", "project_id", "task_id"],
    ),
  },
  {
    name: "kosu_list_time_entries",
    description: "List the caller's own time entries in a tenant.",
    readOnly: true,
    inputSchema: schema({ ...TENANT_PROP }, ["tenant_id"]),
  },
  {
    name: "kosu_create_time_entry",
    description:
      "Record a time entry for the caller. Give task_id, or workspace_id for an unattached entry. started_at is required (ISO 8601); ended_at or duration_seconds complete the entry.",
    readOnly: false,
    inputSchema: schema(
      {
        ...TENANT_PROP,
        task_id: { type: "string" },
        workspace_id: { type: "string" },
        started_at: { type: "string" },
        ended_at: { type: "string" },
        duration_seconds: { type: "integer" },
        note_enc: { type: "string" },
      },
      ["tenant_id", "started_at"],
    ),
  },
  {
    name: "kosu_start_timer",
    description: "Start a timer for the caller (only one running timer per account per tenant).",
    readOnly: false,
    inputSchema: schema(
      {
        ...TENANT_PROP,
        workspace_id: { type: "string" },
        task_id: { type: "string" },
      },
      ["tenant_id", "workspace_id"],
    ),
  },
  {
    name: "kosu_stop_timer",
    description: "Stop the caller's running timer in a tenant.",
    readOnly: false,
    inputSchema: schema({ ...TENANT_PROP }, ["tenant_id"]),
  },
  {
    name: "kosu_get_gantt",
    description: "Get the Gantt feed for a project: tasks, dependencies and milestones.",
    readOnly: true,
    inputSchema: schema(
      { ...TENANT_PROP, ...PROJECT_PROP },
      ["tenant_id", "project_id"],
    ),
  },
  {
    name: "kosu_list_task_links",
    description: "List the external links attached to a task (Slack / Linear / GitHub / URL).",
    readOnly: true,
    inputSchema: schema(
      { ...TENANT_PROP, ...PROJECT_PROP, task_id: { type: "string" } },
      ["tenant_id", "project_id", "task_id"],
    ),
  },
  {
    name: "kosu_add_task_link",
    description:
      "Attach an external link to a task. kind is one of slack, linear, github_commit, github_pr, github_issue, url. Linking a github_pr URL lets the GitHub webhook complete the task when that PR merges.",
    readOnly: false,
    inputSchema: schema(
      {
        ...TENANT_PROP,
        ...PROJECT_PROP,
        task_id: { type: "string" },
        kind: { type: "string" },
        url: { type: "string" },
        external_id: { type: "string" },
        title: { type: "string" },
      },
      ["tenant_id", "project_id", "task_id", "kind", "url"],
    ),
  },
  {
    name: "kosu_list_integrations",
    description:
      "List integration connections of a tenant with their status (connected / not_connected / disabled) and last sync. Secrets are never returned.",
    readOnly: true,
    inputSchema: schema({ ...TENANT_PROP }, ["tenant_id"]),
  },
  {
    name: "kosu_sync_integration",
    description:
      "Run a manual sync for one integration connection (Linear / GitHub Issues / TimeCrowd) and return the sync run record.",
    readOnly: false,
    inputSchema: schema(
      { ...TENANT_PROP, connection_id: { type: "string" } },
      ["tenant_id", "connection_id"],
    ),
  },
  {
    name: "kosu_dashboard",
    description:
      "The caller's dashboard for a tenant: my time today/this week, running timer, my in-progress tasks. local_date (YYYY-MM-DD) and tz_offset_minutes localize the day boundaries.",
    readOnly: true,
    inputSchema: schema(
      {
        ...TENANT_PROP,
        local_date: { type: "string" },
        tz_offset_minutes: { type: "integer" },
      },
      ["tenant_id"],
    ),
  },
];

/* ------------------------------------------------------------------ */
/* Argument helpers                                                     */
/* ------------------------------------------------------------------ */

type Args = Record<string, unknown>;

function argString(args: Args, field: string): string | null {
  const v = args[field];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw badRequest(`"${field}" must be a string`);
  return v;
}

function requireString(args: Args, field: string): string {
  const v = argString(args, field);
  if (!v) throw badRequest(`"${field}" is required`);
  return v;
}

function resolveTenantId(principal: Principal, args: Args): string {
  const given = argString(args, "tenant_id");
  if (principal.kind === "api_key") {
    if (given && given !== principal.tenantId) throw notFound("Not found");
    return principal.tenantId;
  }
  if (!given) throw badRequest('"tenant_id" is required');
  return given;
}

async function loadProjectInTenant(
  env: Env,
  tenantId: string,
  projectId: string,
): Promise<ProjectRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(projectId, tenantId)
    .first<ProjectRow>();
  if (!row) throw notFound("Project not found");
  await loadTenant(env, row.tenant_id);
  await loadWorkspace(env, row.tenant_id, row.workspace_id);
  await loadTeam(env, row.workspace_id, row.team_id);
  return row;
}

async function guardProject(
  env: Env,
  principal: Principal,
  project: ProjectRow,
  need: "read" | "write" | "admin",
): Promise<void> {
  await guard(
    env,
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

async function assertWorkflowSlugs(
  env: Env,
  project: ProjectRow,
  status: string | undefined,
  priority: string | undefined,
): Promise<void> {
  const ctx = {
    tenantId: project.tenant_id,
    workspaceId: project.workspace_id,
    projectId: project.id,
  };
  if (status !== undefined) {
    const { defs } = await resolveStatuses(env, ctx);
    if (!defs.some((d) => d.slug === status)) {
      throw badRequest(`Unknown status "${status}" for this project`);
    }
  }
  if (priority !== undefined) {
    const { defs } = await resolvePriorities(env, ctx);
    if (!defs.some((d) => d.slug === priority)) {
      throw badRequest(`Unknown priority "${priority}" for this project`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                           */
/* ------------------------------------------------------------------ */

export async function callMcpTool(
  env: Env,
  principal: Principal,
  name: string,
  rawArgs: unknown,
): Promise<unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) throw badRequest(`Unknown tool "${name}"`);
  if (
    principal.kind === "api_key" &&
    !tool.readOnly &&
    !principal.scopes.includes("write")
  ) {
    throw forbidden("This API key is read-only");
  }
  const args: Args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Args)
      : {};

  switch (name) {
    case "kosu_list_tenants": {
      if (principal.kind === "api_key") {
        const tenant = await loadTenant(env, principal.tenantId);
        return { tenants: [publicTenant(tenant)] };
      }
      const rows = await listTenants(env, principal);
      return {
        tenants: rows.map(({ row, access }) => publicTenant(row, access)),
      };
    }
    case "kosu_list_projects": {
      const tenantId = resolveTenantId(principal, args);
      await loadTenant(env, tenantId);
      await guard(env, principal, { tenantId }, "read");
      const out = [];
      for (const ws of await listWorkspaces(env, principal, tenantId)) {
        for (const team of await listTeams(
          env,
          principal,
          tenantId,
          ws.row.id,
        )) {
          for (const proj of await listProjects(
            env,
            principal,
            tenantId,
            ws.row.id,
            team.row.id,
          )) {
            out.push(publicProject(proj.row, proj.access));
          }
        }
      }
      return { projects: out };
    }
    case "kosu_list_tasks": {
      const tenantId = resolveTenantId(principal, args);
      const project = await loadProjectInTenant(
        env,
        tenantId,
        requireString(args, "project_id"),
      );
      await guardProject(env, principal, project, "read");
      const tasks = await listTasks(env, project.id, {
        includeArchived: args["include_archived"] === true,
      });
      return { tasks: tasks.map(publicTask) };
    }
    case "kosu_create_task": {
      const tenantId = resolveTenantId(principal, args);
      const project = await loadProjectInTenant(
        env,
        tenantId,
        requireString(args, "project_id"),
      );
      await guardProject(env, principal, project, "write");
      const parsed = parseTaskInput(args, false);
      await assertWorkflowSlugs(
        env,
        project,
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
      };
      const row = await insertTask(env, project, input, {
        accountId: principal.accountId,
      });
      return { task: publicTask(row) };
    }
    case "kosu_update_task": {
      const tenantId = resolveTenantId(principal, args);
      const project = await loadProjectInTenant(
        env,
        tenantId,
        requireString(args, "project_id"),
      );
      await guardProject(env, principal, project, "write");
      const task = await loadTask(
        env,
        project.id,
        requireString(args, "task_id"),
      );
      const parsed = parseTaskInput(args, true);
      await assertWorkflowSlugs(env, project, parsed.status, parsed.priority);
      const row = await applyTaskPatch(env, task, parsed, {
        accountId: principal.accountId,
      });
      return { task: publicTask(row) };
    }
    case "kosu_list_time_entries": {
      const tenantId = resolveTenantId(principal, args);
      await loadTenant(env, tenantId);
      await guard(env, principal, { tenantId }, "read");
      const entries = await listEntriesForAccount(
        env,
        tenantId,
        principal.accountId,
      );
      return { time_entries: entries.map((e) => publicEntry(e)) };
    }
    case "kosu_create_time_entry": {
      const tenantId = resolveTenantId(principal, args);
      await loadTenant(env, tenantId);
      await guard(env, principal, { tenantId }, "read");
      const parsed = parseEntryInput(args, false);
      let workspaceId = argString(args, "workspace_id");
      let taskId = parsed.taskId ?? null;
      if (taskId) {
        const taskRow = await env.DB.prepare(
          "SELECT * FROM tasks WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
        )
          .bind(taskId, tenantId)
          .first<import("./types").TaskRow>();
        if (!taskRow) throw notFound("Task not found");
        if (taskRow.project_id) {
          const project = await loadProjectInTenant(
            env,
            tenantId,
            taskRow.project_id,
          );
          await guardProject(env, principal, project, "write");
        }
        workspaceId = taskRow.workspace_id;
        taskId = taskRow.id;
      } else if (!workspaceId) {
        throw badRequest('"task_id" or "workspace_id" is required');
      } else {
        const ws = await loadWorkspace(env, tenantId, workspaceId);
        await guard(
          env,
          principal,
          { tenantId, workspaceId: ws.id },
          "write",
        );
      }
      const row = await insertEntry(
        env,
        {
          tenantId,
          workspaceId: workspaceId as string,
          taskId,
          accountId: principal.accountId,
          startedAt: parsed.startedAt as string,
          endedAt: parsed.endedAt ?? null,
          durationSeconds: parsed.durationSeconds ?? null,
          noteEnc: parsed.noteEnc ?? null,
        },
        { accountId: principal.accountId },
      );
      return { time_entry: publicEntry(row) };
    }
    case "kosu_start_timer": {
      const tenantId = resolveTenantId(principal, args);
      const workspaceId = requireString(args, "workspace_id");
      const ws = await loadWorkspace(env, tenantId, workspaceId);
      await guard(env, principal, { tenantId, workspaceId: ws.id }, "write");
      const row = await startTimer(env, principal, {
        tenantId,
        workspaceId,
        taskId: argString(args, "task_id"),
      });
      return { time_entry: publicEntry(row) };
    }
    case "kosu_stop_timer": {
      const tenantId = resolveTenantId(principal, args);
      await loadTenant(env, tenantId);
      await guard(env, principal, { tenantId }, "read");
      const row = await stopTimer(env, principal, tenantId);
      return { time_entry: publicEntry(row) };
    }
    case "kosu_get_gantt": {
      const tenantId = resolveTenantId(principal, args);
      const project = await loadProjectInTenant(
        env,
        tenantId,
        requireString(args, "project_id"),
      );
      await guardProject(env, principal, project, "read");
      const [tasks, dependencies, milestones] = await Promise.all([
        listTasks(env, project.id),
        listDependencies(env, project.id),
        listMilestones(env, project.id),
      ]);
      return {
        project: publicProject(project),
        tasks: tasks.map(publicTask),
        dependencies: dependencies.map(publicDependency),
        milestones: milestones.map(publicMilestone),
      };
    }
    case "kosu_list_task_links": {
      const tenantId = resolveTenantId(principal, args);
      const project = await loadProjectInTenant(
        env,
        tenantId,
        requireString(args, "project_id"),
      );
      await guardProject(env, principal, project, "read");
      const task = await loadTask(
        env,
        project.id,
        requireString(args, "task_id"),
      );
      const links = await listLinks(env, task.id);
      return { links: links.map(publicLink) };
    }
    case "kosu_add_task_link": {
      const tenantId = resolveTenantId(principal, args);
      const project = await loadProjectInTenant(
        env,
        tenantId,
        requireString(args, "project_id"),
      );
      await guardProject(env, principal, project, "write");
      const task = await loadTask(
        env,
        project.id,
        requireString(args, "task_id"),
      );
      const input = parseLinkInput(args);
      const row = await addLink(env, task, input, principal.accountId);
      return { link: publicLink(row) };
    }
    case "kosu_list_integrations": {
      const tenantId = resolveTenantId(principal, args);
      await loadTenant(env, tenantId);
      await guard(env, principal, { tenantId }, "read");
      const connections = await listConnections(env, tenantId);
      const out = [];
      for (const conn of connections) {
        out.push(publicConnection(conn, await latestRunFor(env, conn.id)));
      }
      return { integrations: out };
    }
    case "kosu_sync_integration": {
      const tenantId = resolveTenantId(principal, args);
      await loadTenant(env, tenantId);
      const { chain } = await guard(env, principal, { tenantId }, "read");
      if (chain.tenant !== "owner" && chain.tenant !== "admin") {
        throw forbidden("A tenant admin role is required");
      }
      const connection = await loadConnection(
        env,
        tenantId,
        requireString(args, "connection_id"),
      );
      let project: ProjectRow | null = null;
      if (connection.project_id) {
        project = await loadProjectInTenant(
          env,
          tenantId,
          connection.project_id,
        );
      }
      const run = await runConnectionSync(
        env,
        connection,
        project,
        principal.accountId,
      );
      return { sync_run: publicSyncRun(run) };
    }
    case "kosu_dashboard": {
      const tenantId = resolveTenantId(principal, args);
      await loadTenant(env, tenantId);
      await guard(env, principal, { tenantId }, "read");
      const localDate =
        argString(args, "local_date") ?? new Date().toISOString().slice(0, 10);
      const tzRaw = args["tz_offset_minutes"];
      const tzOffset =
        typeof tzRaw === "number" && Number.isInteger(tzRaw) ? tzRaw : 0;
      return dashboard(env, principal, tenantId, localDate, tzOffset);
    }
    default:
      throw badRequest(`Unknown tool "${name}"`);
  }
}
