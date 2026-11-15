/**
 * Public share links and intake forms (phase 5 items 16-17).
 *
 * Share links expose a read-only progress view of one project
 * (completion rate, status counts, a Gantt-style date summary) at an
 * unguessable token URL. Intake forms expose a minimal task-creation
 * form per project at a token URL; submissions are rate limited by
 * counting intake_submissions rows (10 per form per hour) and only a
 * title is accepted — the honeypot field must stay empty.
 *
 * Both store only the SHA-256 hash of the token; the plaintext token
 * is returned exactly once, at creation.
 */

import { randomId, randomToken, sha256Hex } from "./tokens";
import { badRequest, notFound } from "./errors";
import { nowIso } from "./accounts";
import { resolveStatuses } from "./workflow";
import type {
  Env,
  IntakeFormRow,
  ProjectRow,
  PublicShareLinkRow,
  TaskRow,
} from "./types";

export const INTAKE_RATE_LIMIT = 10;
export const INTAKE_WINDOW_MS = 60 * 60 * 1000;

export function publicShareLink(row: PublicShareLinkRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    label: row.label,
    expires_at: row.expires_at,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
    revoked_at: row.revoked_at,
  };
}

export async function createShareLink(
  env: Env,
  args: {
    tenantId: string;
    projectId: string;
    label: string | null;
    expiresAt: string | null;
    createdBy: string;
  },
): Promise<{ token: string; link: PublicShareLinkRow }> {
  const token = randomToken("share");
  const row: PublicShareLinkRow = {
    id: randomId(),
    tenant_id: args.tenantId,
    project_id: args.projectId,
    token_hash: await sha256Hex(token),
    label: args.label,
    expires_at: args.expiresAt,
    created_by_account_id: args.createdBy,
    created_at: nowIso(),
    last_accessed_at: null,
    revoked_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO public_share_links (id, tenant_id, project_id, token_hash, label, expires_at, created_by_account_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      row.id, row.tenant_id, row.project_id, row.token_hash, row.label,
      row.expires_at, row.created_by_account_id, row.created_at,
    )
    .run();
  return { token, link: row };
}

export async function listShareLinks(
  env: Env,
  tenantId: string,
  projectId: string,
): Promise<PublicShareLinkRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM public_share_links WHERE tenant_id = ?1 AND project_id = ?2",
  )
    .bind(tenantId, projectId)
    .all<PublicShareLinkRow>();
  return results ?? [];
}

export async function revokeShareLink(
  env: Env,
  tenantId: string,
  id: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM public_share_links WHERE id = ?1 AND tenant_id = ?2",
  )
    .bind(id, tenantId)
    .first<PublicShareLinkRow>();
  if (!row || row.revoked_at) throw notFound("Share link not found");
  await env.DB.prepare(
    "UPDATE public_share_links SET revoked_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), id)
    .run();
}

/** Resolve a share token to its project, or null (never leaks why). */
export async function resolveShareToken(
  env: Env,
  token: string,
): Promise<{ link: PublicShareLinkRow; project: ProjectRow } | null> {
  if (!token || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const link = await env.DB.prepare(
    "SELECT * FROM public_share_links WHERE token_hash = ?1",
  )
    .bind(hash)
    .first<PublicShareLinkRow>();
  if (!link || link.revoked_at) return null;
  if (link.expires_at) {
    const expiresAt = Date.parse(link.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  }
  const project = await env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(link.project_id)
    .first<ProjectRow>();
  if (!project) return null;
  await env.DB.prepare(
    "UPDATE public_share_links SET last_accessed_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), link.id)
    .run();
  return { link, project };
}

export interface ProjectProgress {
  project_name: string;
  total: number;
  done: number;
  completion_rate: number;
  by_status: { status: string; category: string; count: number }[];
  period: { from: string | null; to: string | null };
  milestones: { name: string; date: string }[];
}

/** Progress summary for the public page — counts and dates only. */
export async function projectProgress(
  env: Env,
  project: ProjectRow,
): Promise<ProjectProgress> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ?1 AND deleted_at IS NULL",
  )
    .bind(project.id)
    .all<TaskRow>();
  const tasks = results ?? [];
  const { defs } = await resolveStatuses(env, {
    tenantId: project.tenant_id,
    workspaceId: project.workspace_id,
    projectId: project.id,
  });
  const categoryOf = new Map(defs.map((d) => [d.slug, d.category]));
  const counts = new Map<string, number>();
  let done = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const t of tasks) {
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    if (categoryOf.get(t.status) === "done") done++;
    const start = t.start_date ?? t.due_date;
    const end = t.due_date ?? t.start_date;
    if (start && (!from || start < from)) from = start;
    if (end && (!to || end > to)) to = end;
  }
  const { results: milestoneRows } = await env.DB.prepare(
    "SELECT name, date FROM milestones WHERE project_id = ?1 AND deleted_at IS NULL",
  )
    .bind(project.id)
    .all<{ name: string; date: string }>();
  const milestones = (milestoneRows ?? [])
    .map((m) => ({ name: m.name, date: m.date }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    project_name: project.name,
    total: tasks.length,
    done,
    completion_rate:
      tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 1000) / 10,
    by_status: [...counts.entries()]
      .map(([status, count]) => ({
        status,
        category: categoryOf.get(status) ?? "open",
        count,
      }))
      .sort((a, b) => a.status.localeCompare(b.status)),
    period: { from, to },
    milestones,
  };
}

/* ------------------------------------------------------------------ */
/* Intake forms                                                         */
/* ------------------------------------------------------------------ */

export function publicIntakeForm(row: IntakeFormRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    title: row.title,
    enabled: Number(row.enabled) === 1,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

export async function createIntakeForm(
  env: Env,
  args: {
    tenantId: string;
    projectId: string;
    title: string | null;
    createdBy: string;
  },
): Promise<{ token: string; form: IntakeFormRow }> {
  const token = randomToken("intake");
  const row: IntakeFormRow = {
    id: randomId(),
    tenant_id: args.tenantId,
    project_id: args.projectId,
    token_hash: await sha256Hex(token),
    title: args.title,
    enabled: 1,
    created_by_account_id: args.createdBy,
    created_at: nowIso(),
    revoked_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO intake_forms (id, tenant_id, project_id, token_hash, title, enabled, created_by_account_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      row.id, row.tenant_id, row.project_id, row.token_hash, row.title,
      row.enabled, row.created_by_account_id, row.created_at,
    )
    .run();
  return { token, form: row };
}

export async function listIntakeForms(
  env: Env,
  tenantId: string,
  projectId: string,
): Promise<IntakeFormRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM intake_forms WHERE tenant_id = ?1 AND project_id = ?2",
  )
    .bind(tenantId, projectId)
    .all<IntakeFormRow>();
  return results ?? [];
}

export async function setIntakeFormEnabled(
  env: Env,
  tenantId: string,
  id: string,
  enabled: boolean,
): Promise<IntakeFormRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM intake_forms WHERE id = ?1 AND tenant_id = ?2",
  )
    .bind(id, tenantId)
    .first<IntakeFormRow>();
  if (!row || row.revoked_at) throw notFound("Intake form not found");
  await env.DB.prepare(
    "UPDATE intake_forms SET enabled = ?1 WHERE id = ?2",
  )
    .bind(enabled ? 1 : 0, id)
    .run();
  return { ...row, enabled: enabled ? 1 : 0 };
}

export async function revokeIntakeForm(
  env: Env,
  tenantId: string,
  id: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM intake_forms WHERE id = ?1 AND tenant_id = ?2",
  )
    .bind(id, tenantId)
    .first<IntakeFormRow>();
  if (!row || row.revoked_at) throw notFound("Intake form not found");
  await env.DB.prepare(
    "UPDATE intake_forms SET revoked_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), id)
    .run();
}

export async function resolveIntakeToken(
  env: Env,
  token: string,
): Promise<{ form: IntakeFormRow; project: ProjectRow } | null> {
  if (!token || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const form = await env.DB.prepare(
    "SELECT * FROM intake_forms WHERE token_hash = ?1",
  )
    .bind(hash)
    .first<IntakeFormRow>();
  if (!form || form.revoked_at || Number(form.enabled) !== 1) return null;
  const project = await env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(form.project_id)
    .first<ProjectRow>();
  if (!project) return null;
  return { form, project };
}

/** Submissions in the trailing rate-limit window for one form. */
export async function countRecentSubmissions(
  env: Env,
  formId: string,
  now: string = nowIso(),
): Promise<number> {
  const since = new Date(
    Date.parse(now) - INTAKE_WINDOW_MS,
  ).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, created_at FROM intake_submissions WHERE form_id = ?1",
  )
    .bind(formId)
    .all<{ id: string; created_at: string }>();
  return (results ?? []).filter((r) => r.created_at > since).length;
}

export async function recordSubmission(
  env: Env,
  form: IntakeFormRow,
  taskId: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO intake_submissions (id, form_id, tenant_id, task_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(randomId(), form.id, form.tenant_id, taskId, nowIso())
    .run();
}

export function parseExpiresAt(body: Record<string, unknown>): string | null {
  const v = body["expires_at"];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    throw badRequest('"expires_at" must be an ISO 8601 timestamp or null');
  }
  return new Date(v).toISOString();
}

