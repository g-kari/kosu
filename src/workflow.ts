/**
 * Workflow customization (phase 3): status and priority definitions.
 *
 * Definitions live at one of three scopes — tenant, workspace, project —
 * and resolve narrowest-first: a project with its own rows uses them,
 * otherwise the workspace's, otherwise the tenant's, otherwise the
 * built-in defaults below. Replacing a scope's set can carry a
 * `renames` map (old slug -> new slug) that rewrites affected tasks in
 * the same operation, and deleting a scope's set makes it inherit again
 * ("back to the defaults" when no wider scope defines anything).
 *
 * REST task create/update validates status/priority against the
 * project's resolved definitions. Sync pushes stay free-form: an
 * offline client may legitimately carry slugs the server has not seen,
 * and the conflict machinery — not validation — arbitrates those.
 */
import { nowIso } from "./accounts";
import { badRequest } from "./errors";
import { randomId } from "./tokens";
import type { Env, PriorityDefRow, StatusDefRow } from "./types";

export type ScopeLevel = "tenant" | "workspace" | "project";

export interface DefScope {
  tenantId: string;
  level: ScopeLevel;
  workspaceId?: string | null;
  projectId?: string | null;
}

export interface StatusDef {
  slug: string;
  name: string;
  category: "open" | "doing" | "done";
  color: string | null;
  sort_order: number;
}

export interface PriorityDef {
  slug: string;
  name: string;
  weight: number;
  color: string | null;
  sort_order: number;
}

export const DEFAULT_STATUSES: StatusDef[] = [
  { slug: "todo", name: "未着手", category: "open", color: "#8a8f98", sort_order: 0 },
  { slug: "doing", name: "進行中", category: "doing", color: "#2456c8", sort_order: 1 },
  { slug: "done", name: "完了", category: "done", color: "#3d9970", sort_order: 2 },
];

export const DEFAULT_PRIORITIES: PriorityDef[] = [
  { slug: "low", name: "低", weight: 0, color: "#8a8f98", sort_order: 0 },
  { slug: "medium", name: "中", weight: 1, color: "#2456c8", sort_order: 1 },
  { slug: "high", name: "高", weight: 2, color: "#e8a33d", sort_order: 2 },
  { slug: "urgent", name: "緊急", weight: 3, color: "#d33", sort_order: 3 },
];

const SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CATEGORIES = ["open", "doing", "done"];

export function parseStatusDefs(input: unknown): StatusDef[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
    throw badRequest('"statuses" must be an array of 1-50 definitions');
  }
  const seen = new Set<string>();
  const out: StatusDef[] = [];
  input.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw badRequest('"statuses" entries must be objects');
    }
    const r = raw as Record<string, unknown>;
    const slug = r["slug"];
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw badRequest(`status slug "${String(slug)}" is not a valid slug`);
    }
    if (seen.has(slug)) throw badRequest(`duplicate status slug "${slug}"`);
    seen.add(slug);
    const name = r["name"];
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 60) {
      throw badRequest(`status "${slug}" needs a name of 1-60 characters`);
    }
    const category = r["category"] ?? "open";
    if (typeof category !== "string" || !CATEGORIES.includes(category)) {
      throw badRequest(`status "${slug}" category must be open, doing or done`);
    }
    const color = r["color"];
    if (
      color !== undefined &&
      color !== null &&
      (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))
    ) {
      throw badRequest(`status "${slug}" color must be #RRGGBB`);
    }
    out.push({
      slug,
      name: name.trim(),
      category: category as StatusDef["category"],
      color: (color as string | null) ?? null,
      sort_order:
        typeof r["sort_order"] === "number" && Number.isInteger(r["sort_order"])
          ? (r["sort_order"] as number)
          : i,
    });
  });
  return out;
}

export function parsePriorityDefs(input: unknown): PriorityDef[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
    throw badRequest('"priorities" must be an array of 1-50 definitions');
  }
  const seen = new Set<string>();
  const out: PriorityDef[] = [];
  input.forEach((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw badRequest('"priorities" entries must be objects');
    }
    const r = raw as Record<string, unknown>;
    const slug = r["slug"];
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw badRequest(`priority slug "${String(slug)}" is not a valid slug`);
    }
    if (seen.has(slug)) throw badRequest(`duplicate priority slug "${slug}"`);
    seen.add(slug);
    const name = r["name"];
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 60) {
      throw badRequest(`priority "${slug}" needs a name of 1-60 characters`);
    }
    const color = r["color"];
    if (
      color !== undefined &&
      color !== null &&
      (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))
    ) {
      throw badRequest(`priority "${slug}" color must be #RRGGBB`);
    }
    const weight = r["weight"];
    out.push({
      slug,
      name: name.trim(),
      weight:
        typeof weight === "number" && Number.isInteger(weight) ? weight : i,
      color: (color as string | null) ?? null,
      sort_order:
        typeof r["sort_order"] === "number" && Number.isInteger(r["sort_order"])
          ? (r["sort_order"] as number)
          : i,
    });
  });
  return out;
}

export function parseRenames(input: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (input === undefined || input === null) return out;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw badRequest('"renames" must be an object mapping old slug -> new slug');
  }
  for (const [from, to] of Object.entries(input)) {
    if (!SLUG_RE.test(from) || typeof to !== "string" || !SLUG_RE.test(to)) {
      throw badRequest('"renames" keys and values must be valid slugs');
    }
    out.set(from, to);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                           */
/* ------------------------------------------------------------------ */

function scopeWhere(scope: DefScope): {
  level: ScopeLevel;
  workspaceId: string | null;
  projectId: string | null;
} {
  return {
    level: scope.level,
    workspaceId: scope.level === "tenant" ? null : (scope.workspaceId ?? null),
    projectId: scope.level === "project" ? (scope.projectId ?? null) : null,
  };
}

async function statusRowsAt(
  env: Env,
  scope: DefScope,
): Promise<StatusDefRow[]> {
  const w = scopeWhere(scope);
  const res = await env.DB.prepare(
    "SELECT * FROM status_defs WHERE tenant_id = ?1 AND scope_level = ?2",
  )
    .bind(scope.tenantId, w.level)
    .all<StatusDefRow>();
  return res.results
    .filter(
      (r) => r.workspace_id === w.workspaceId && r.project_id === w.projectId,
    )
    .sort(
      (a, b) =>
        Number(a.sort_order) - Number(b.sort_order) ||
        a.slug.localeCompare(b.slug),
    );
}

async function priorityRowsAt(
  env: Env,
  scope: DefScope,
): Promise<PriorityDefRow[]> {
  const w = scopeWhere(scope);
  const res = await env.DB.prepare(
    "SELECT * FROM priority_defs WHERE tenant_id = ?1 AND scope_level = ?2",
  )
    .bind(scope.tenantId, w.level)
    .all<PriorityDefRow>();
  return res.results
    .filter(
      (r) => r.workspace_id === w.workspaceId && r.project_id === w.projectId,
    )
    .sort(
      (a, b) =>
        Number(a.sort_order) - Number(b.sort_order) ||
        a.slug.localeCompare(b.slug),
    );
}

function statusRowToDef(row: StatusDefRow): StatusDef {
  return {
    slug: row.slug,
    name: row.name,
    category: (CATEGORIES.includes(row.category)
      ? row.category
      : "open") as StatusDef["category"],
    color: row.color,
    sort_order: Number(row.sort_order),
  };
}

function priorityRowToDef(row: PriorityDefRow): PriorityDef {
  return {
    slug: row.slug,
    name: row.name,
    weight: Number(row.weight),
    color: row.color,
    sort_order: Number(row.sort_order),
  };
}

export interface Resolved<T> {
  defs: T[];
  source: ScopeLevel | "default";
}

/** Resolve the effective definitions for a project context. */
export async function resolveStatuses(
  env: Env,
  ctx: { tenantId: string; workspaceId?: string | null; projectId?: string | null },
): Promise<Resolved<StatusDef>> {
  if (ctx.projectId) {
    const rows = await statusRowsAt(env, {
      tenantId: ctx.tenantId,
      level: "project",
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });
    if (rows.length > 0) return { defs: rows.map(statusRowToDef), source: "project" };
  }
  if (ctx.workspaceId) {
    const rows = await statusRowsAt(env, {
      tenantId: ctx.tenantId,
      level: "workspace",
      workspaceId: ctx.workspaceId,
    });
    if (rows.length > 0) return { defs: rows.map(statusRowToDef), source: "workspace" };
  }
  const rows = await statusRowsAt(env, { tenantId: ctx.tenantId, level: "tenant" });
  if (rows.length > 0) return { defs: rows.map(statusRowToDef), source: "tenant" };
  return { defs: DEFAULT_STATUSES, source: "default" };
}

export async function resolvePriorities(
  env: Env,
  ctx: { tenantId: string; workspaceId?: string | null; projectId?: string | null },
): Promise<Resolved<PriorityDef>> {
  if (ctx.projectId) {
    const rows = await priorityRowsAt(env, {
      tenantId: ctx.tenantId,
      level: "project",
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    });
    if (rows.length > 0) return { defs: rows.map(priorityRowToDef), source: "project" };
  }
  if (ctx.workspaceId) {
    const rows = await priorityRowsAt(env, {
      tenantId: ctx.tenantId,
      level: "workspace",
      workspaceId: ctx.workspaceId,
    });
    if (rows.length > 0) return { defs: rows.map(priorityRowToDef), source: "workspace" };
  }
  const rows = await priorityRowsAt(env, { tenantId: ctx.tenantId, level: "tenant" });
  if (rows.length > 0) return { defs: rows.map(priorityRowToDef), source: "tenant" };
  return { defs: DEFAULT_PRIORITIES, source: "default" };
}

/** Category ("open" | "doing" | "done") of a status slug in context. */
export async function statusCategory(
  env: Env,
  ctx: { tenantId: string; workspaceId?: string | null; projectId?: string | null },
  slug: string,
): Promise<StatusDef["category"]> {
  const { defs } = await resolveStatuses(env, ctx);
  return defs.find((d) => d.slug === slug)?.category ?? "open";
}

/* ------------------------------------------------------------------ */
/* Replacement (with optional task migration via renames)               */
/* ------------------------------------------------------------------ */

async function applyTaskRenames(
  env: Env,
  scope: DefScope,
  field: "status" | "priority",
  renames: Map<string, string>,
): Promise<number> {
  let changed = 0;
  const res = await env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = ?1")
    .bind(scope.tenantId)
    .all<{
      id: string;
      workspace_id: string;
      project_id: string | null;
      status: string;
      priority: string;
    }>();
  for (const [from, to] of renames) {
    if (from === to) continue;
    for (const row of res.results) {
      if (scope.level === "workspace" && row.workspace_id !== scope.workspaceId) continue;
      if (scope.level === "project" && row.project_id !== scope.projectId) continue;
      if (row[field] !== from) continue;
      await env.DB.prepare(
        field === "status"
          ? "UPDATE tasks SET status = ?1 WHERE id = ?2"
          : "UPDATE tasks SET priority = ?1 WHERE id = ?2",
      )
        .bind(to, row.id)
        .run();
      changed++;
    }
  }
  return changed;
}

export async function replaceStatusDefs(
  env: Env,
  scope: DefScope,
  defs: StatusDef[],
  renames: Map<string, string>,
): Promise<{ migrated_tasks: number }> {
  const w = scopeWhere(scope);
  const existing = await statusRowsAt(env, scope);
  for (const row of existing) {
    await env.DB.prepare("DELETE FROM status_defs WHERE id = ?1")
      .bind(row.id)
      .run();
  }
  const now = nowIso();
  for (const def of defs) {
    await env.DB.prepare(
      "INSERT INTO status_defs (id, tenant_id, scope_level, workspace_id, project_id, slug, name, category, color, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )
      .bind(
        randomId(), scope.tenantId, w.level, w.workspaceId, w.projectId,
        def.slug, def.name, def.category, def.color, def.sort_order, now, now,
      )
      .run();
  }
  const migrated = await applyTaskRenames(env, scope, "status", renames);
  return { migrated_tasks: migrated };
}

export async function replacePriorityDefs(
  env: Env,
  scope: DefScope,
  defs: PriorityDef[],
  renames: Map<string, string>,
): Promise<{ migrated_tasks: number }> {
  const w = scopeWhere(scope);
  const existing = await priorityRowsAt(env, scope);
  for (const row of existing) {
    await env.DB.prepare("DELETE FROM priority_defs WHERE id = ?1")
      .bind(row.id)
      .run();
  }
  const now = nowIso();
  for (const def of defs) {
    await env.DB.prepare(
      "INSERT INTO priority_defs (id, tenant_id, scope_level, workspace_id, project_id, slug, name, weight, color, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )
      .bind(
        randomId(), scope.tenantId, w.level, w.workspaceId, w.projectId,
        def.slug, def.name, def.weight, def.color, def.sort_order, now, now,
      )
      .run();
  }
  const migrated = await applyTaskRenames(env, scope, "priority", renames);
  return { migrated_tasks: migrated };
}

/** Remove a scope's own definitions so it inherits again. */
export async function clearStatusDefs(env: Env, scope: DefScope): Promise<void> {
  for (const row of await statusRowsAt(env, scope)) {
    await env.DB.prepare("DELETE FROM status_defs WHERE id = ?1").bind(row.id).run();
  }
}

export async function clearPriorityDefs(env: Env, scope: DefScope): Promise<void> {
  for (const row of await priorityRowsAt(env, scope)) {
    await env.DB.prepare("DELETE FROM priority_defs WHERE id = ?1").bind(row.id).run();
  }
}
