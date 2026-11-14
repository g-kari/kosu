/**
 * Integration REST API (phase 4):
 * - connection CRUD under /api/tenants/:tenantId/integrations
 *   (tenant admin; the provider token is write-only, the inbound
 *   webhook secret is returned once at creation)
 * - manual sync trigger + tenant-wide sync run history
 * - task link CRUD (project-scoped)
 * - one-shot imports (Toggl / Clockify / Kimai / generic CSV /
 *   ActivityWatch JSON) into a project
 * - iCal feed tokens (per account) and mail-inbound tokens (per
 *   project); plaintext tokens are returned once at creation
 * - tenant data export (owner only; ciphertext stays ciphertext)
 * - Google Calendar status (settings surface only in this phase)
 */
import { Hono } from "hono";
import { badRequest, forbidden } from "../errors";
import {
  guard,
  loadProject,
  loadTeam,
  loadTenant,
  loadWorkspace,
} from "../hierarchy";
import { runImport } from "../importers";
import {
  PROVIDERS,
  createConnection,
  createIcalFeed,
  createMailInboundToken,
  deleteConnection,
  exportTenantData,
  latestRunFor,
  listConnections,
  listIcalFeeds,
  listMailInboundTokens,
  listTenantRuns,
  loadConnection,
  loadProjectRowLoose,
  parseConfig,
  publicConnection,
  publicIcalFeed,
  publicMailInboundToken,
  publicSyncRun,
  revokeIcalFeed,
  revokeMailInboundToken,
  runConnectionSync,
  updateConnection,
  type Provider,
} from "../integrations";
import {
  addLink,
  deleteLink,
  listLinks,
  loadLink,
  parseLinkInput,
  publicLink,
} from "../links";
import { loadTask } from "../tasks";
import type { Env, ProjectRow, Variables } from "../types";
import { auth, readJsonBody, type Ctx } from "./http";

export const integrationRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

const INT_PATH = "/api/v1/tenants/:tenantId/integrations";
const PROJECT_TASK_PATH =
  "/api/v1/tenants/:tenantId/workspaces/:workspaceId/teams/:teamId/projects/:projectId/tasks/:taskId";
const PROJECT_PATH =
  "/api/v1/tenants/:tenantId/workspaces/:workspaceId/teams/:teamId/projects/:projectId";

async function requireTenantAdmin(c: Ctx, tenantId: string) {
  const principal = await auth(c, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner" && chain.tenant !== "admin") {
    throw forbidden("A tenant admin role is required");
  }
  return principal;
}

interface ProjectAncestry {
  tenantId: string;
  workspaceId: string;
  teamId: string;
  projectId: string;
}

function projectParams(c: Ctx): ProjectAncestry {
  return {
    tenantId: c.req.param("tenantId") as string,
    workspaceId: c.req.param("workspaceId") as string,
    teamId: c.req.param("teamId") as string,
    projectId: c.req.param("projectId") as string,
  };
}

async function loadProjectAncestry(
  c: Ctx,
  a: ProjectAncestry,
  need: "read" | "write",
) {
  const principal = await auth(c, a.tenantId);
  await loadTenant(c.env, a.tenantId);
  await loadWorkspace(c.env, a.tenantId, a.workspaceId);
  await loadTeam(c.env, a.workspaceId, a.teamId);
  const project = await loadProject(c.env, a.teamId, a.projectId);
  await guard(
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
  return { principal, project };
}

/* ------------------------------------------------------------------ */
/* Connections                                                          */
/* ------------------------------------------------------------------ */

integrationRoutes.get(INT_PATH, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const connections = await listConnections(c.env, tenantId);
  const out = [];
  for (const conn of connections) {
    out.push(publicConnection(conn, await latestRunFor(c.env, conn.id)));
  }
  return c.json({ integrations: out });
});

integrationRoutes.post(INT_PATH, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await requireTenantAdmin(c, tenantId);
  const body = await readJsonBody(c);
  const provider = body["provider"];
  if (
    typeof provider !== "string" ||
    !(PROVIDERS as readonly string[]).includes(provider)
  ) {
    throw badRequest(
      `"provider" must be one of: ${PROVIDERS.join(", ")}`,
    );
  }
  const typedProvider = provider as Provider;
  const name =
    typeof body["name"] === "string" && body["name"].trim()
      ? (body["name"] as string).trim().slice(0, 120)
      : typedProvider;
  const projectId =
    typeof body["project_id"] === "string" && body["project_id"]
      ? (body["project_id"] as string)
      : null;
  if (projectId) {
    const project = await loadProjectRowLoose(c.env, projectId);
    if (!project || project.tenant_id !== tenantId) {
      throw badRequest('"project_id" does not belong to this tenant');
    }
  }
  const config = parseConfig(typedProvider, body["config"]);
  const token =
    typeof body["token"] === "string" && body["token"]
      ? (body["token"] as string)
      : null;
  const { row, webhookSecret } = await createConnection(c.env, {
    tenantId,
    provider: typedProvider,
    projectId,
    name,
    config,
    token,
    createdByAccountId: principal.accountId,
  });
  return c.json(
    {
      integration: publicConnection(row, null),
      // For linear/github the inbound webhook secret is shown once.
      webhook_secret: webhookSecret,
      webhook_path: webhookSecret
        ? `/webhooks/${typedProvider}/${row.id}`
        : null,
    },
    201,
  );
});

integrationRoutes.get(`${INT_PATH}/:connectionId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const row = await loadConnection(
    c.env,
    tenantId,
    c.req.param("connectionId") as string,
  );
  return c.json({
    integration: publicConnection(row, await latestRunFor(c.env, row.id)),
  });
});

integrationRoutes.patch(`${INT_PATH}/:connectionId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await requireTenantAdmin(c, tenantId);
  const body = await readJsonBody(c);
  const row = await loadConnection(
    c.env,
    tenantId,
    c.req.param("connectionId") as string,
  );
  const updated = await updateConnection(
    c.env,
    row,
    {
      name:
        typeof body["name"] === "string" && body["name"].trim()
          ? (body["name"] as string).trim().slice(0, 120)
          : undefined,
      enabled:
        typeof body["enabled"] === "boolean"
          ? (body["enabled"] as boolean)
          : undefined,
      config:
        body["config"] !== undefined
          ? parseConfig(row.provider, body["config"])
          : undefined,
      // "token": string replaces, null clears, absent keeps.
      token:
        typeof body["token"] === "string"
          ? (body["token"] as string) || null
          : body["token"] === null
            ? null
            : undefined,
    },
    principal.accountId,
  );
  return c.json({
    integration: publicConnection(
      updated,
      await latestRunFor(c.env, updated.id),
    ),
  });
});

integrationRoutes.delete(`${INT_PATH}/:connectionId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await requireTenantAdmin(c, tenantId);
  const row = await loadConnection(
    c.env,
    tenantId,
    c.req.param("connectionId") as string,
  );
  await deleteConnection(c.env, row, principal.accountId);
  return c.json({ ok: true });
});

integrationRoutes.post(`${INT_PATH}/:connectionId/sync`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await requireTenantAdmin(c, tenantId);
  const connection = await loadConnection(
    c.env,
    tenantId,
    c.req.param("connectionId") as string,
  );
  let project: ProjectRow | null = null;
  if (connection.project_id) {
    project = await loadProjectRowLoose(c.env, connection.project_id);
    if (!project) {
      throw badRequest("The connection's target project no longer exists");
    }
  }
  const run = await runConnectionSync(
    c.env,
    connection,
    project,
    principal.accountId,
  );
  return c.json({ sync_run: publicSyncRun(run) });
});

integrationRoutes.get("/api/v1/tenants/:tenantId/sync-runs", async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  await requireTenantAdmin(c, tenantId);
  const runs = await listTenantRuns(c.env, tenantId);
  const connectionId = c.req.query("connection_id");
  const filtered = connectionId
    ? runs.filter((r) => r.connection_id === connectionId)
    : runs;
  return c.json({ sync_runs: filtered.map(publicSyncRun) });
});

/* ------------------------------------------------------------------ */
/* Google Calendar (base only)                                          */
/* ------------------------------------------------------------------ */

integrationRoutes.get(
  "/api/v1/tenants/:tenantId/google-calendar/status",
  async (c) => {
    const tenantId = c.req.param("tenantId") as string;
    const principal = await auth(c, tenantId);
    await guard(c.env, principal, { tenantId }, "read");
    return c.json({
      provider: "google_calendar",
      status: "not_connected",
      detail:
        "Google OAuth credentials are not configured for this service yet, so calendar events cannot be imported. The Kosu-side agenda (tasks and time entries by day) is available through the dashboard API and the MCP kosu_dashboard tool. See docs/INTEGRATIONS.md.",
    });
  },
);

/* ------------------------------------------------------------------ */
/* Task links                                                           */
/* ------------------------------------------------------------------ */

integrationRoutes.get(`${PROJECT_TASK_PATH}/links`, async (c) => {
  const a = projectParams(c);
  const { project } = await loadProjectAncestry(c, a, "read");
  const task = await loadTask(
    c.env,
    project.id,
    c.req.param("taskId") as string,
  );
  const links = await listLinks(c.env, task.id);
  return c.json({ links: links.map(publicLink) });
});

integrationRoutes.post(`${PROJECT_TASK_PATH}/links`, async (c) => {
  const a = projectParams(c);
  const { principal, project } = await loadProjectAncestry(c, a, "write");
  const task = await loadTask(
    c.env,
    project.id,
    c.req.param("taskId") as string,
  );
  const body = await readJsonBody(c);
  const input = parseLinkInput(body);
  const row = await addLink(c.env, task, input, principal.accountId);
  return c.json({ link: publicLink(row) }, 201);
});

integrationRoutes.delete(`${PROJECT_TASK_PATH}/links/:linkId`, async (c) => {
  const a = projectParams(c);
  const { project } = await loadProjectAncestry(c, a, "write");
  const task = await loadTask(
    c.env,
    project.id,
    c.req.param("taskId") as string,
  );
  const link = await loadLink(
    c.env,
    task.id,
    c.req.param("linkId") as string,
  );
  await deleteLink(c.env, link.id);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Imports                                                              */
/* ------------------------------------------------------------------ */

const IMPORT_FORMATS = [
  "toggl",
  "clockify",
  "kimai",
  "csv",
  "activitywatch",
] as const;

integrationRoutes.post(`${PROJECT_PATH}/imports`, async (c) => {
  const a = projectParams(c);
  const { principal, project } = await loadProjectAncestry(c, a, "write");
  const body = await readJsonBody(c);
  const format = body["format"];
  if (
    typeof format !== "string" ||
    !(IMPORT_FORMATS as readonly string[]).includes(format)
  ) {
    throw badRequest(`"format" must be one of: ${IMPORT_FORMATS.join(", ")}`);
  }
  const content = body["content"];
  if (typeof content !== "string" || content.length === 0) {
    throw badRequest('"content" (the export file contents) is required');
  }
  if (content.length > 4_000_000) {
    throw badRequest("Import content is limited to 4 MB per request");
  }
  const { run, stats } = await runImport(
    c.env,
    project,
    format as (typeof IMPORT_FORMATS)[number],
    content,
    principal.accountId,
  );
  return c.json({ sync_run: publicSyncRun(run), stats });
});

/* ------------------------------------------------------------------ */
/* iCal feeds (per account)                                             */
/* ------------------------------------------------------------------ */

integrationRoutes.get("/api/v1/tenants/:tenantId/ical-feeds", async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const feeds = await listIcalFeeds(c.env, tenantId, principal.accountId);
  return c.json({ ical_feeds: feeds.map(publicIcalFeed) });
});

integrationRoutes.post("/api/v1/tenants/:tenantId/ical-feeds", async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const body = await readJsonBody(c).catch(
    () => ({}) as Record<string, unknown>,
  );
  const label =
    typeof body["label"] === "string"
      ? (body["label"] as string).slice(0, 120)
      : null;
  const { row, token } = await createIcalFeed(c.env, {
    tenantId,
    accountId: principal.accountId,
    label,
  });
  return c.json(
    {
      ical_feed: publicIcalFeed(row),
      token,
      feed_path: `/feeds/ical/${token}.ics`,
    },
    201,
  );
});

integrationRoutes.delete(
  "/api/v1/tenants/:tenantId/ical-feeds/:feedId",
  async (c) => {
    const tenantId = c.req.param("tenantId") as string;
    const principal = await auth(c, tenantId);
    await guard(c.env, principal, { tenantId }, "read");
    await revokeIcalFeed(
      c.env,
      tenantId,
      principal.accountId,
      c.req.param("feedId") as string,
    );
    return c.json({ ok: true });
  },
);

/* ------------------------------------------------------------------ */
/* Mail-inbound tokens (per project)                                    */
/* ------------------------------------------------------------------ */

const MAIL_TOKEN_PATH = `${PROJECT_PATH}/mail-inbound-tokens`;

integrationRoutes.get(MAIL_TOKEN_PATH, async (c) => {
  const a = projectParams(c);
  const { project } = await loadProjectAncestry(c, a, "read");
  const tokens = await listMailInboundTokens(
    c.env,
    a.tenantId,
    project.id,
  );
  return c.json({ mail_inbound_tokens: tokens.map(publicMailInboundToken) });
});

integrationRoutes.post(MAIL_TOKEN_PATH, async (c) => {
  const a = projectParams(c);
  const { principal, project } = await loadProjectAncestry(c, a, "write");
  const body = await readJsonBody(c).catch(
    () => ({}) as Record<string, unknown>,
  );
  const label =
    typeof body["label"] === "string"
      ? (body["label"] as string).slice(0, 120)
      : null;
  const { row, token } = await createMailInboundToken(c.env, {
    tenantId: a.tenantId,
    projectId: project.id,
    label,
    createdByAccountId: principal.accountId,
  });
  return c.json(
    {
      mail_inbound_token: publicMailInboundToken(row),
      token,
      inbound_path: `/inbound/mail/${token}`,
    },
    201,
  );
});

integrationRoutes.delete(`${MAIL_TOKEN_PATH}/:tokenId`, async (c) => {
  const a = projectParams(c);
  const { project } = await loadProjectAncestry(c, a, "write");
  await revokeMailInboundToken(
    c.env,
    a.tenantId,
    project.id,
    c.req.param("tokenId") as string,
  );
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Tenant export (owner only)                                           */
/* ------------------------------------------------------------------ */

integrationRoutes.get("/api/v1/tenants/:tenantId/export", async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner") {
    throw forbidden("Only the tenant owner can export the tenant data");
  }
  const data = await exportTenantData(c.env, tenantId);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="kosu-export-${tenantId}-${date}.json"`,
    },
  });
});
