/**
 * Task links: external references attached to a task (Slack messages,
 * Linear issues, GitHub commits / PRs / issues, plain URLs).
 *
 * Links are metadata only — a URL plus an optional external id and a
 * cached title. Uniqueness of (tenant, kind, external_id) is what lets
 * the GitHub webhook find "the task(s) linked to this PR" and complete
 * them when the PR merges. Manual links created through the API always
 * record the creator so webhook-driven changes have an actor.
 */
import { nowIso } from "./accounts";
import { badRequest, notFound } from "./errors";
import { randomId } from "./tokens";
import type { Env, LinkRow, TaskRow } from "./types";

export const LINK_KINDS = [
  "slack",
  "linear",
  "github_commit",
  "github_pr",
  "github_issue",
  "url",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export function publicLink(row: LinkRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    task_id: row.task_id,
    kind: row.kind,
    url: row.url,
    external_id: row.external_id,
    title: row.title_cache,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
  };
}

export interface LinkInput {
  kind: string;
  url: string;
  externalId: string | null;
  title: string | null;
}

export function parseLinkInput(body: Record<string, unknown>): LinkInput {
  const kind = body["kind"];
  if (typeof kind !== "string" || !(LINK_KINDS as readonly string[]).includes(kind)) {
    throw badRequest(
      `"kind" must be one of ${LINK_KINDS.join(", ")}`,
    );
  }
  const url = body["url"];
  if (typeof url !== "string" || url.length < 1 || url.length > 2048) {
    throw badRequest('"url" must be a string of at most 2048 characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('"url" must be a valid URL');
  }
  if (parsed.protocol !== "https:") {
    throw badRequest('"url" must be an https URL');
  }
  if (kind === "slack" && !parsed.hostname.endsWith("slack.com")) {
    throw badRequest('"url" for a slack link must be on a slack.com host');
  }
  if (
    (kind === "github_commit" || kind === "github_pr" || kind === "github_issue") &&
    parsed.hostname !== "github.com"
  ) {
    throw badRequest(`"url" for a ${kind} link must be on github.com`);
  }
  const externalRaw = body["external_id"];
  let externalId: string | null = null;
  if (externalRaw !== undefined && externalRaw !== null && externalRaw !== "") {
    if (typeof externalRaw !== "string" || externalRaw.length > 512) {
      throw badRequest('"external_id" must be a string of at most 512 characters');
    }
    externalId = externalRaw;
  }
  const titleRaw = body["title"];
  let title: string | null = null;
  if (titleRaw !== undefined && titleRaw !== null && titleRaw !== "") {
    if (typeof titleRaw !== "string" || titleRaw.length > 300) {
      throw badRequest('"title" must be a string of at most 300 characters');
    }
    title = titleRaw;
  }
  return { kind, url, externalId, title };
}

/**
 * Convention for GitHub links: when the caller does not supply an
 * external id, the URL itself is the external id. That is the key the
 * PR-merged webhook matches on (it knows the PR's html_url).
 */
export function defaultExternalId(input: LinkInput): string | null {
  if (input.externalId) return input.externalId;
  if (
    input.kind === "github_pr" ||
    input.kind === "github_commit" ||
    input.kind === "github_issue" ||
    input.kind === "slack" ||
    input.kind === "linear"
  ) {
    return input.url;
  }
  return null;
}

export async function addLink(
  env: Env,
  task: TaskRow,
  input: LinkInput,
  accountId: string,
): Promise<LinkRow> {
  const externalId = defaultExternalId(input);
  if (externalId) {
    const existing = await env.DB.prepare(
      "SELECT * FROM links WHERE tenant_id = ?1 AND kind = ?2 AND external_id = ?3",
    )
      .bind(task.tenant_id, input.kind, externalId)
      .first<LinkRow>();
    if (existing) {
      // Re-linking the same external object to another task is allowed
      // only when it is the same task; otherwise it would steal the
      // webhook target. Point the caller at the existing link instead.
      if (existing.task_id !== task.id) {
        throw badRequest(
          "This external object is already linked to another task",
        );
      }
      return existing;
    }
  }
  const row: LinkRow = {
    id: randomId(),
    tenant_id: task.tenant_id,
    task_id: task.id,
    kind: input.kind,
    url: input.url,
    external_id: externalId,
    title_cache: input.title,
    created_by_account_id: accountId,
    created_at: nowIso(),
  };
  await env.DB.prepare(
    "INSERT INTO links (id, tenant_id, task_id, kind, url, external_id, title_cache, created_by_account_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      row.id, row.tenant_id, row.task_id, row.kind, row.url,
      row.external_id, row.title_cache, row.created_by_account_id,
      row.created_at,
    )
    .run();
  return row;
}

/** Idempotent link creation for importers (no cross-task error). */
export async function ensureLink(
  env: Env,
  task: TaskRow,
  input: { kind: string; url: string; externalId: string; title?: string | null },
  accountId: string,
): Promise<LinkRow> {
  const existing = await env.DB.prepare(
    "SELECT * FROM links WHERE tenant_id = ?1 AND kind = ?2 AND external_id = ?3",
  )
    .bind(task.tenant_id, input.kind, input.externalId)
    .first<LinkRow>();
  if (existing) return existing;
  const row: LinkRow = {
    id: randomId(),
    tenant_id: task.tenant_id,
    task_id: task.id,
    kind: input.kind,
    url: input.url,
    external_id: input.externalId,
    title_cache: input.title ?? null,
    created_by_account_id: accountId,
    created_at: nowIso(),
  };
  await env.DB.prepare(
    "INSERT INTO links (id, tenant_id, task_id, kind, url, external_id, title_cache, created_by_account_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      row.id, row.tenant_id, row.task_id, row.kind, row.url,
      row.external_id, row.title_cache, row.created_by_account_id,
      row.created_at,
    )
    .run();
  return row;
}

export async function listLinks(
  env: Env,
  taskId: string,
): Promise<LinkRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM links WHERE task_id = ?1 ORDER BY created_at ASC",
  )
    .bind(taskId)
    .all<LinkRow>();
  return res.results;
}

export async function loadLink(
  env: Env,
  taskId: string,
  linkId: string,
): Promise<LinkRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM links WHERE id = ?1 AND task_id = ?2",
  )
    .bind(linkId, taskId)
    .first<LinkRow>();
  if (!row) throw notFound("Link not found");
  return row;
}

export async function deleteLink(env: Env, linkId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM links WHERE id = ?1").bind(linkId).run();
}

/** All links in a tenant pointing at one external object (webhooks). */
export async function linksByExternal(
  env: Env,
  tenantId: string,
  kind: string,
  externalId: string,
): Promise<LinkRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM links WHERE tenant_id = ?1 AND kind = ?2 AND external_id = ?3",
  )
    .bind(tenantId, kind, externalId)
    .all<LinkRow>();
  return res.results;
}
