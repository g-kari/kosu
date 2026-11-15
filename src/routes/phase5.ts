/**
 * Phase 5 API routes: automation rules, project templates, custom
 * report definitions, escalation settings, usage & limits, display
 * preferences, login events, share links, intake forms, onboarding
 * sample data, account deletion and the operator overview.
 *
 *   GET/POST    /api/v1/tenants/:tenantId/automation-rules
 *   GET/PATCH/DELETE /api/v1/tenants/:tenantId/automation-rules/:ruleId
 *   GET         /api/v1/tenants/:tenantId/automation-runs
 *   GET/POST    /api/v1/tenants/:tenantId/project-templates
 *   POST        /api/v1/tenants/:tenantId/project-templates/from-project/:projectId
 *   DELETE      /api/v1/tenants/:tenantId/project-templates/:templateId
 *   POST        /api/v1/tenants/:tenantId/project-templates/:templateId/instantiate
 *   GET/POST    /api/v1/tenants/:tenantId/report-definitions
 *   PATCH/DELETE /api/v1/tenants/:tenantId/report-definitions/:defId
 *   POST        /api/v1/tenants/:tenantId/report-definitions/:defId/run
 *   GET         /api/v1/tenants/:tenantId/report-definitions/:defId/runs
 *   GET/PUT     /api/v1/tenants/:tenantId/escalation
 *   GET         /api/v1/tenants/:tenantId/usage
 *   GET/PUT     /api/v1/tenants/:tenantId/limits        (tenant admin)
 *   GET/PATCH   /api/v1/me/prefs
 *   GET         /api/v1/me/login-events
 *   GET/POST    .../projects/:projectId/share-links
 *   DELETE      .../projects/:projectId/share-links/:linkId
 *   GET/POST    .../projects/:projectId/intake-forms
 *   PATCH/DELETE .../projects/:projectId/intake-forms/:formId
 *   GET/POST/DELETE /api/v1/tenants/:tenantId/onboarding/sample
 *   GET         /api/v1/me/deletion-preview
 *   DELETE      /api/v1/me                        (session only)
 *   GET         /api/v1/admin/overview            (operator, session only)
 */
import { Hono } from "hono";
import { guardAutomationScope, guardStoredAutomationScope } from "../automation-access";
import { nowIso } from "../accounts";
import { ApiError, badRequest, forbidden, notFound } from "../errors";
import {
  guard,
  loadProject,
  loadTenant,
  loadTeam,
  loadWorkspace,
  createWorkspace,
  createTeam,
  createProject,
  publicProject,
} from "../hierarchy";
import {
  deleteRule,
  getRule,
  insertRule,
  listRules,
  listRuns,
  parseRuleBody,
  publicRule,
  updateRule,
} from "../automation";
import {
  captureProjectTemplate,
  deleteProjectTemplate,
  getProjectTemplate,
  instantiateProjectTemplate,
  listProjectTemplates,
  publicTemplate,
  guardTemplateAccess,
} from "../project-templates";
import {
  getDefinition,
  insertDefinition,
  listDefinitions,
  parseDefinition,
  publicDefinition,
  REPORT_SCHEDULES,
  runDefinition,
} from "../report-builder";
import {
  getEscalationSettings,
  saveEscalationSettings,
} from "../escalation";
import {
  getTenantLimits,
  getTenantUsage,
  saveTenantLimits,
  type TenantLimits,
} from "../usage";
import { getUserPrefs, parsePrefsPatch, saveUserPrefs } from "../prefs";
import { insertTask } from "../tasks";
import {
  createIntakeForm,
  createShareLink,
  listIntakeForms,
  listShareLinks,
  parseExpiresAt,
  publicIntakeForm,
  publicShareLink,
  revokeIntakeForm,
  revokeShareLink,
  setIntakeFormEnabled,
} from "../public-links";
import { previewAccountDeletion, purgeAccount } from "../purge";
import { adminOverview, isOperator } from "../admin";
import { accountById } from "../accounts";
import type { Env, Variables } from "../types";
import { auth, readJsonBody } from "./http";

export const phase5Routes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

const TENANT_PATH = "/api/v1/tenants/:tenantId";
const PROJECT_PATH = `${TENANT_PATH}/workspaces/:workspaceId/teams/:teamId/projects/:projectId`;

interface Path {
  tenantId: string;
  workspaceId: string;
  teamId: string;
  projectId: string;
}

function params(c: { req: { param(name: string): string | undefined } }): Path {
  return {
    tenantId: c.req.param("tenantId") as string,
    workspaceId: c.req.param("workspaceId") as string,
    teamId: c.req.param("teamId") as string,
    projectId: c.req.param("projectId") as string,
  };
}

async function loadProjectAncestry(c: { env: Env }, a: Path) {
  await loadTenant(c.env, a.tenantId);
  await loadWorkspace(c.env, a.tenantId, a.workspaceId);
  await loadTeam(c.env, a.workspaceId, a.teamId);
  return loadProject(c.env, a.teamId, a.projectId);
}

function optionalLimit(
  body: Record<string, unknown>,
  key: string,
): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw badRequest(`"${key}" must be a non-negative integer or null`);
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Automation rules                                                     */
/* ------------------------------------------------------------------ */

phase5Routes.get(`${TENANT_PATH}/automation-rules`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const rules = await listRules(c.env, tenantId);
  const visible = [];
  for (const row of rules) {
    try { await guardStoredAutomationScope(c.env,principal,tenantId,row.project_id,"read"); visible.push(row); }
    catch(error) { if (!(error instanceof ApiError) || ![403,404].includes(error.status)) throw error; }
  }
  return c.json({ rules: visible.map(publicRule) });
});

phase5Routes.post(`${TENANT_PATH}/automation-rules`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const input = parseRuleBody(body);
  await guardAutomationScope(c.env,principal,tenantId,input.projectId,"admin");
  const row = await insertRule(c.env, tenantId, input, principal.accountId);
  return c.json({ rule: publicRule(row) }, 201);
});

phase5Routes.get(`${TENANT_PATH}/automation-rules/:ruleId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const row = await getRule(c.env, tenantId, c.req.param("ruleId") as string);
  if (!row) throw notFound("Automation rule not found");
  await guardStoredAutomationScope(c.env,principal,tenantId,row.project_id,"read");
  return c.json({ rule: publicRule(row) });
});

phase5Routes.patch(`${TENANT_PATH}/automation-rules/:ruleId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const row = await getRule(c.env, tenantId, c.req.param("ruleId") as string);
  if (!row) throw notFound("Automation rule not found");
  const input = parseRuleBody(body);
  await guardStoredAutomationScope(c.env,principal,tenantId,row.project_id,"admin");
  await guardAutomationScope(c.env,principal,tenantId,input.projectId,"admin");
  const next = await updateRule(c.env, row, input);
  return c.json({ rule: publicRule(next) });
});

phase5Routes.delete(`${TENANT_PATH}/automation-rules/:ruleId`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const row = await getRule(c.env, tenantId, c.req.param("ruleId") as string);
  if (!row) throw notFound("Automation rule not found");
  await guardStoredAutomationScope(c.env,principal,tenantId,row.project_id,"admin");
  await deleteRule(c.env, row);
  return c.json({ ok: true });
});

phase5Routes.get(`${TENANT_PATH}/automation-runs`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "admin");
  const raw = c.req.query("limit");
  const limit = raw ? Math.min(200, Math.max(1, Number(raw) || 50)) : 50;
  return c.json({ runs: await listRuns(c.env, tenantId, limit) });
});

/* ------------------------------------------------------------------ */
/* Project templates                                                    */
/* ------------------------------------------------------------------ */

phase5Routes.get(`${TENANT_PATH}/project-templates`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const templates = await listProjectTemplates(c.env, tenantId);
  const visible = [];
  for (const row of templates) {
    try { await guardTemplateAccess(c.env,principal,row,"read"); visible.push(row); }
    catch(error) { if (!(error instanceof ApiError) || ![403,404].includes(error.status)) throw error; }
  }
  return c.json({ templates: visible.map(publicTemplate) });
});

phase5Routes.post(`${TENANT_PATH}/project-templates`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const projectId = body["project_id"];
  if (typeof projectId !== "string" || !projectId) {
    throw badRequest('"project_id" is required');
  }
  const name = body["name"];
  const project = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(projectId, tenantId)
    .first<import("../types").ProjectRow>();
  if (!project) throw notFound("Project not found");
  const templateName =
    typeof name === "string" && name.trim() !== ""
      ? name.trim()
      : `${project.name} テンプレート`;
  const row = await captureProjectTemplate(
    c.env,
    project,
    templateName,
    principal.accountId,
  );
  return c.json({ template: publicTemplate(row) }, 201);
});

phase5Routes.delete(
  `${TENANT_PATH}/project-templates/:templateId`,
  async (c) => {
    const tenantId = c.req.param("tenantId") as string;
    const principal = await auth(c, tenantId);
    await loadTenant(c.env, tenantId);
    await guard(c.env, principal, { tenantId }, "write");
    const row = await getProjectTemplate(
      c.env,
      tenantId,
      c.req.param("templateId") as string,
    );
    await guardTemplateAccess(c.env,principal,row,"admin");
    await deleteProjectTemplate(c.env, row);
    return c.json({ ok: true });
  },
);

phase5Routes.post(
  `${TENANT_PATH}/project-templates/:templateId/instantiate`,
  async (c) => {
    const tenantId = c.req.param("tenantId") as string;
    const principal = await auth(c, tenantId);
    const body = await readJsonBody(c);
    await loadTenant(c.env, tenantId);
    await guard(c.env, principal, { tenantId }, "write");
    const teamId = body["team_id"];
    if (typeof teamId !== "string" || !teamId) {
      throw badRequest('"team_id" is required');
    }
    const { project, taskCount } = await instantiateProjectTemplate(
      c.env,
      principal,
      {
        tenantId,
        templateId: c.req.param("templateId") as string,
        teamId,
        name: typeof body["name"] === "string" ? body["name"] : undefined,
        startDate:
          typeof body["start_date"] === "string"
            ? body["start_date"]
            : undefined,
      },
    );
    return c.json(
      { project: publicProject(project), task_count: taskCount },
      201,
    );
  },
);

/* ------------------------------------------------------------------ */
/* Report definitions                                                   */
/* ------------------------------------------------------------------ */

phase5Routes.get(`${TENANT_PATH}/report-definitions`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const defs = await listDefinitions(c.env, tenantId);
  return c.json({ definitions: defs.map(publicDefinition) });
});

phase5Routes.post(`${TENANT_PATH}/report-definitions`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const name = body["name"];
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) {
    throw badRequest('"name" is required (max 200 chars)');
  }
  const schedule = body["schedule"] ?? "off";
  if (
    typeof schedule !== "string" ||
    !(REPORT_SCHEDULES as readonly string[]).includes(schedule)
  ) {
    throw badRequest('"schedule" must be off, daily, weekly or monthly');
  }
  const definition = parseDefinition(body["definition"]);
  const row = await insertDefinition(c.env, {
    tenantId,
    name: name.trim(),
    definition,
    schedule,
    createdBy: principal.accountId,
  });
  return c.json({ definition: publicDefinition(row) }, 201);
});

phase5Routes.patch(
  `${TENANT_PATH}/report-definitions/:defId`,
  async (c) => {
    const tenantId = c.req.param("tenantId") as string;
    const principal = await auth(c, tenantId);
    const body = await readJsonBody(c);
    await loadTenant(c.env, tenantId);
    await guard(c.env, principal, { tenantId }, "write");
    const row = await getDefinition(
      c.env,
      tenantId,
      c.req.param("defId") as string,
    );
    if (!row) throw notFound("Report definition not found");
    // Replace semantics via soft-delete + insert keeps history simple.
    const name =
      typeof body["name"] === "string" && body["name"].trim() !== ""
        ? (body["name"] as string).trim()
        : row.name;
    const schedule =
      typeof body["schedule"] === "string" ? body["schedule"] : row.schedule;
    if (!(REPORT_SCHEDULES as readonly string[]).includes(schedule)) {
      throw badRequest('"schedule" must be off, daily, weekly or monthly');
    }
    const definition =
      body["definition"] !== undefined
        ? parseDefinition(body["definition"])
        : parseDefinition(row.definition_json);
    await c.env.DB.prepare(
      "UPDATE report_definitions SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
    )
      .bind(nowIso(), nowIso(), row.id)
      .run();
    const next = await insertDefinition(c.env, {
      tenantId,
      name,
      definition,
      schedule,
      createdBy: principal.accountId,
    });
    return c.json({ definition: publicDefinition(next) });
  },
);

phase5Routes.delete(
  `${TENANT_PATH}/report-definitions/:defId`,
  async (c) => {
    const tenantId = c.req.param("tenantId") as string;
    const principal = await auth(c, tenantId);
    await loadTenant(c.env, tenantId);
    await guard(c.env, principal, { tenantId }, "write");
    const row = await getDefinition(
      c.env,
      tenantId,
      c.req.param("defId") as string,
    );
    if (!row) throw notFound("Report definition not found");
    await c.env.DB.prepare(
      "UPDATE report_definitions SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
    )
      .bind(nowIso(), nowIso(), row.id)
      .run();
    return c.json({ ok: true });
  },
);

phase5Routes.post(
  `${TENANT_PATH}/report-definitions/:defId/run`,
  async (c) => {
    const tenantId = c.req.param("tenantId") as string;
    const principal = await auth(c, tenantId);
    await loadTenant(c.env, tenantId);
    await guard(c.env, principal, { tenantId }, "read");
    const row = await getDefinition(
      c.env,
      tenantId,
      c.req.param("defId") as string,
    );
    if (!row) throw notFound("Report definition not found");
    const { runId, report } = await runDefinition(c.env, row);
    return c.json({ run_id: runId, report });
  },
);

phase5Routes.get(`${TENANT_PATH}/report-definitions/:defId/runs`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const row = await getDefinition(
    c.env,
    tenantId,
    c.req.param("defId") as string,
  );
  if (!row) throw notFound("Report definition not found");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM report_runs WHERE definition_id = ?1 ORDER BY created_at DESC",
  )
    .bind(row.id)
    .all<{ id: string; report_json: string; created_at: string }>();
  const runs = (results ?? []).slice(0, 50).map((r) => {
    let report: unknown = null;
    try {
      report = JSON.parse(r.report_json) as unknown;
    } catch {
      report = null;
    }
    return { id: r.id, created_at: r.created_at, report };
  });
  return c.json({ runs });
});

/* ------------------------------------------------------------------ */
/* Escalation settings                                                  */
/* ------------------------------------------------------------------ */

phase5Routes.get(`${TENANT_PATH}/escalation`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  return c.json({ escalation: await getEscalationSettings(c.env, tenantId) });
});

phase5Routes.put(`${TENANT_PATH}/escalation`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner" && chain.tenant !== "admin") {
    throw forbidden("Changing escalation requires a tenant admin");
  }
  const settings = await saveEscalationSettings(c.env, tenantId, body);
  return c.json({ escalation: settings });
});

/* ------------------------------------------------------------------ */
/* Usage and limits                                                     */
/* ------------------------------------------------------------------ */

phase5Routes.get(`${TENANT_PATH}/usage`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const [usage, limits] = await Promise.all([
    getTenantUsage(c.env, tenantId),
    getTenantLimits(c.env, tenantId),
  ]);
  return c.json({ usage, limits });
});

phase5Routes.put(`${TENANT_PATH}/limits`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  const body = await readJsonBody(c);
  await loadTenant(c.env, tenantId);
  const { chain } = await guard(c.env, principal, { tenantId }, "read");
  if (chain.tenant !== "owner" && chain.tenant !== "admin") {
    throw forbidden("Changing limits requires a tenant admin");
  }
  const current = await getTenantLimits(c.env, tenantId);
  const next: TenantLimits = {
    max_members:
      body["max_members"] === undefined
        ? current.max_members
        : optionalLimit(body, "max_members"),
    max_tasks:
      body["max_tasks"] === undefined
        ? current.max_tasks
        : optionalLimit(body, "max_tasks"),
    max_attachment_bytes:
      body["max_attachment_bytes"] === undefined
        ? current.max_attachment_bytes
        : optionalLimit(body, "max_attachment_bytes"),
  };
  const saved = await saveTenantLimits(c.env, tenantId, next);
  return c.json({ limits: saved });
});

/* ------------------------------------------------------------------ */
/* Preferences and login events                                         */
/* ------------------------------------------------------------------ */

phase5Routes.get("/api/v1/me/prefs", async (c) => {
  const principal = await auth(c);
  return c.json({ prefs: await getUserPrefs(c.env, principal.accountId) });
});

phase5Routes.patch("/api/v1/me/prefs", async (c) => {
  const principal = await auth(c);
  const body = await readJsonBody(c);
  const patch = parsePrefsPatch(body);
  const prefs = await saveUserPrefs(c.env, principal.accountId, patch);
  return c.json({ prefs });
});

phase5Routes.get("/api/v1/me/login-events", async (c) => {
  const principal = await auth(c);
  const { results } = await c.env.DB.prepare(
    "SELECT ip, user_agent, created_at FROM login_events WHERE account_id = ?1 ORDER BY created_at DESC",
  )
    .bind(principal.accountId)
    .all<{ ip: string; user_agent: string; created_at: string }>();
  return c.json({ events: (results ?? []).slice(0, 50) });
});

/* ------------------------------------------------------------------ */
/* Share links and intake forms                                         */
/* ------------------------------------------------------------------ */

phase5Routes.get(`${PROJECT_PATH}/share-links`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const project = await loadProjectAncestry(c, a);
  await guard(
    c.env,
    principal,
    { tenantId: a.tenantId, workspaceId: a.workspaceId, teamId: a.teamId, projectId: a.projectId },
    "read",
  );
  const links = await listShareLinks(c.env, a.tenantId, project.id);
  return c.json({ links: links.map(publicShareLink) });
});

phase5Routes.post(`${PROJECT_PATH}/share-links`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadProjectAncestry(c, a);
  await guard(
    c.env,
    principal,
    { tenantId: a.tenantId, workspaceId: a.workspaceId, teamId: a.teamId, projectId: a.projectId },
    "admin",
  );
  const label =
    typeof body["label"] === "string" && body["label"].length <= 200
      ? body["label"]
      : null;
  const { token, link } = await createShareLink(c.env, {
    tenantId: a.tenantId,
    projectId: project.id,
    label,
    expiresAt: parseExpiresAt(body),
    createdBy: principal.accountId,
  });
  return c.json(
    { link: publicShareLink(link), token, path: `/share/${token}` },
    201,
  );
});

phase5Routes.delete(`${PROJECT_PATH}/share-links/:linkId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadProjectAncestry(c, a);
  await guard(
    c.env,
    principal,
    { tenantId: a.tenantId, workspaceId: a.workspaceId, teamId: a.teamId, projectId: a.projectId },
    "admin",
  );
  await revokeShareLink(c.env, a.tenantId, c.req.param("linkId") as string);
  return c.json({ ok: true });
});

phase5Routes.get(`${PROJECT_PATH}/intake-forms`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const project = await loadProjectAncestry(c, a);
  await guard(
    c.env,
    principal,
    { tenantId: a.tenantId, workspaceId: a.workspaceId, teamId: a.teamId, projectId: a.projectId },
    "read",
  );
  const forms = await listIntakeForms(c.env, a.tenantId, project.id);
  return c.json({ forms: forms.map(publicIntakeForm) });
});

phase5Routes.post(`${PROJECT_PATH}/intake-forms`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  const project = await loadProjectAncestry(c, a);
  await guard(
    c.env,
    principal,
    { tenantId: a.tenantId, workspaceId: a.workspaceId, teamId: a.teamId, projectId: a.projectId },
    "admin",
  );
  const title =
    typeof body["title"] === "string" && body["title"].length <= 200
      ? body["title"]
      : null;
  const { token, form } = await createIntakeForm(c.env, {
    tenantId: a.tenantId,
    projectId: project.id,
    title,
    createdBy: principal.accountId,
  });
  return c.json(
    { form: publicIntakeForm(form), token, path: `/intake/${token}` },
    201,
  );
});

phase5Routes.patch(`${PROJECT_PATH}/intake-forms/:formId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  const body = await readJsonBody(c);
  await loadProjectAncestry(c, a);
  await guard(
    c.env,
    principal,
    { tenantId: a.tenantId, workspaceId: a.workspaceId, teamId: a.teamId, projectId: a.projectId },
    "admin",
  );
  if (typeof body["enabled"] !== "boolean") {
    throw badRequest('"enabled" must be a boolean');
  }
  const form = await setIntakeFormEnabled(
    c.env,
    a.tenantId,
    c.req.param("formId") as string,
    body["enabled"],
  );
  return c.json({ form: publicIntakeForm(form) });
});

phase5Routes.delete(`${PROJECT_PATH}/intake-forms/:formId`, async (c) => {
  const a = params(c);
  const principal = await auth(c, a.tenantId);
  await loadProjectAncestry(c, a);
  await guard(
    c.env,
    principal,
    { tenantId: a.tenantId, workspaceId: a.workspaceId, teamId: a.teamId, projectId: a.projectId },
    "admin",
  );
  await revokeIntakeForm(c.env, a.tenantId, c.req.param("formId") as string);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Onboarding sample data                                               */
/* ------------------------------------------------------------------ */

async function findSample(
  c: { env: Env },
  accountId: string,
  tenantId: string,
): Promise<{ project_id: string } | null> {
  const row = await c.env.DB.prepare(
    "SELECT project_id FROM sample_projects WHERE account_id = ?1 AND tenant_id = ?2",
  )
    .bind(accountId, tenantId)
    .first<{ project_id: string }>();
  return row ?? null;
}

phase5Routes.get(`${TENANT_PATH}/onboarding/sample`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "read");
  const sample = await findSample(c, principal.accountId, tenantId);
  return c.json({ sample_project_id: sample?.project_id ?? null });
});

phase5Routes.post(`${TENANT_PATH}/onboarding/sample`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const existing = await findSample(c, principal.accountId, tenantId);
  if (existing) {
    return c.json({ sample_project_id: existing.project_id, created: false });
  }
  const workspace = await createWorkspace(
    c.env,
    principal,
    tenantId,
    "サンプル",
  );
  const team = await createTeam(
    c.env,
    principal,
    tenantId,
    workspace.id,
    "サンプルチーム",
  );
  const today = nowIso().slice(0, 10);
  const project = await createProject(
    c.env,
    principal,
    tenantId,
    workspace.id,
    team.id,
    {
      name: "サンプルプロジェクト",
      color: null,
      startsOn: today,
      dueOn: null,
    },
  );
  const samples: { title: string; status: string; dueInDays: number }[] = [
    { title: "Kosuへようこそ：このタスクを完了してみましょう", status: "todo", dueInDays: 1 },
    { title: "タイマーで作業時間を記録する", status: "todo", dueInDays: 3 },
    { title: "サンプル：完了したタスク", status: "done", dueInDays: 0 },
  ];
  for (const [i, s] of samples.entries()) {
    const due = new Date(Date.parse(`${today}T12:00:00Z`) + s.dueInDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await insertTask(
      c.env,
      project,
      {
        title: s.title,
        descriptionEnc: null,
        status: s.status,
        priority: "medium",
        assigneeAccountId: principal.accountId,
        parentTaskId: null,
        startDate: today,
        dueDate: due,
        sortOrder: i,
        estimateMinutes: 30,
      },
      { accountId: principal.accountId },
    );
  }
  await c.env.DB.prepare(
    "INSERT INTO sample_projects (account_id, tenant_id, project_id, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(principal.accountId, tenantId, project.id, nowIso())
    .run();
  return c.json(
    { sample_project_id: project.id, project: publicProject(project), created: true },
    201,
  );
});

phase5Routes.delete(`${TENANT_PATH}/onboarding/sample`, async (c) => {
  const tenantId = c.req.param("tenantId") as string;
  const principal = await auth(c, tenantId);
  await loadTenant(c.env, tenantId);
  await guard(c.env, principal, { tenantId }, "write");
  const sample = await findSample(c, principal.accountId, tenantId);
  if (!sample) return c.json({ removed: false });
  const now = nowIso();
  // Soft-delete the sample project and its tasks; the marker row goes.
  await c.env.DB.prepare(
    "UPDATE tasks SET deleted_at = ?1, updated_at = ?2 WHERE project_id = ?3",
  )
    .bind(now, now, sample.project_id)
    .run();
  await c.env.DB.prepare(
    "UPDATE projects SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(now, now, sample.project_id)
    .run();
  await c.env.DB.prepare(
    "DELETE FROM sample_projects WHERE account_id = ?1 AND tenant_id = ?2",
  )
    .bind(principal.accountId, tenantId)
    .run();
  return c.json({ removed: true });
});

/* ------------------------------------------------------------------ */
/* Account deletion                                                     */
/* ------------------------------------------------------------------ */

phase5Routes.get("/api/v1/me/deletion-preview", async (c) => {
  const principal = await auth(c);
  if (principal.kind !== "session") {
    throw forbidden("Account deletion requires a browser session");
  }
  const preview = await previewAccountDeletion(c.env, principal.accountId);
  return c.json({ preview });
});

phase5Routes.delete("/api/v1/me", async (c) => {
  const principal = await auth(c);
  if (principal.kind !== "session") {
    throw forbidden("Account deletion requires a browser session");
  }
  const body = await readJsonBody(c);
  const account = await accountById(c.env, principal.accountId);
  if (!account) throw notFound("Account not found");
  const confirm = body["confirm"];
  const expected = account.email ?? "DELETE";
  if (confirm !== expected && confirm !== "DELETE") {
    throw badRequest(
      'Confirmation failed: send "confirm" with your account email (or DELETE)',
    );
  }
  const dissolveRaw = body["dissolve_tenant_ids"] ?? [];
  if (
    !Array.isArray(dissolveRaw) ||
    dissolveRaw.some((v) => typeof v !== "string")
  ) {
    throw badRequest('"dissolve_tenant_ids" must be an array of tenant ids');
  }
  const successorsRaw = body["successors"] ?? {};
  if (
    !successorsRaw ||
    typeof successorsRaw !== "object" ||
    Array.isArray(successorsRaw) ||
    Object.values(successorsRaw as Record<string, unknown>).some(
      (v) => typeof v !== "string",
    )
  ) {
    throw badRequest('"successors" must map tenant ids to account ids');
  }
  const result = await purgeAccount(c.env, principal.accountId, {
    dissolveTenantIds: dissolveRaw as string[],
    successors: successorsRaw as Record<string, string>,
  });
  return c.json({ deleted: true, ...result });
});

/* ------------------------------------------------------------------ */
/* Operator overview                                                    */
/* ------------------------------------------------------------------ */

phase5Routes.get("/api/v1/admin/overview", async (c) => {
  const principal = await auth(c);
  if (principal.kind !== "session" || !isOperator(c.env, principal.accountId)) {
    throw forbidden("Operator access only");
  }
  return c.json(await adminOverview(c.env));
});

