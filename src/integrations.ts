/**
 * External integrations (phase 4): connection settings, credential
 * storage, manual/webhook sync for Linear and GitHub Issues, TimeCrowd
 * import, Slack notifications and the tenant data export.
 *
 * Credential rules (same as the rest of Kosu):
 * - Provider tokens are stored only as FIELD_ENCRYPTION_KEY ciphertext
 *   (secret_enc) and are never returned by any API.
 * - Inbound webhook secrets are generated here, stored encrypted, and
 *   their plaintext is returned exactly once at connection creation.
 * - A connection with no token is "not_connected": every surface says so
 *   plainly instead of pretending to sync. Nothing in this module talks
 *   to an external service unless a token is configured and the
 *   connection is enabled.
 *
 * Imported issue bodies are NOT copied into task descriptions: Kosu
 * bodies are client-side ciphertext (`description_enc`), so a plaintext
 * external body has no valid place to go. Imports carry the title, the
 * status and a link back to the external object (see docs/DESIGN.md).
 */
import { nowIso } from "./accounts";
import { recordAudit } from "./audit";
import { decryptField, encryptField } from "./crypto";
import { badRequest, notFound } from "./errors";
import { ensureLink, linksByExternal } from "./links";
import {
  applyTaskPatch,
  insertEntry,
  insertTask,
  loadTaskAny,
  type TaskInput,
} from "./tasks";
import { randomId, randomToken, sha256Hex, timingSafeEqual } from "./tokens";
import { resolveStatuses } from "./workflow";
import { runAutomationRules } from "./automation";
import type {
  Env,
  ExternalItemRow,
  IcalFeedRow,
  IntegrationConnectionRow,
  IntegrationSyncRunRow,
  MailInboundTokenRow,
  ProjectRow,
  TaskRow,
} from "./types";

/* ------------------------------------------------------------------ */
/* Providers and configuration                                          */
/* ------------------------------------------------------------------ */

export const PROVIDERS = [
  "linear",
  "github",
  "slack",
  "google_calendar",
  "timecrowd",
] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Providers whose sync imports into a target project. */
export const PROJECT_PROVIDERS: readonly string[] = [
  "linear",
  "github",
  "timecrowd",
];

/** Providers that receive inbound webhooks (a secret is issued). */
export const WEBHOOK_PROVIDERS: readonly string[] = ["linear", "github"];

export type IntegrationConfig = Record<string, string>;

function cleanConfigString(
  input: unknown,
  field: string,
  max = 300,
): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || input.length > max) {
    throw badRequest(`"config.${field}" must be a string of at most ${max} characters`);
  }
  return input.trim() || null;
}

/** Validate and normalize the non-secret config for a provider. */
export function parseConfig(
  provider: string,
  input: unknown,
): IntegrationConfig {
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw badRequest('"config" must be an object');
  }
  const raw = input as Record<string, unknown>;
  const out: IntegrationConfig = {};
  const put = (field: string, value: string | null) => {
    if (value !== null) out[field] = value;
  };
  switch (provider) {
    case "linear":
      put("team_id", cleanConfigString(raw["team_id"], "team_id", 100));
      put(
        "project_ext_id",
        cleanConfigString(raw["project_ext_id"], "project_ext_id", 100),
      );
      break;
    case "github": {
      const repo = cleanConfigString(raw["repo"], "repo", 200);
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        throw badRequest('"config.repo" must look like "owner/repo"');
      }
      out["repo"] = repo;
      break;
    }
    case "slack":
      put("channel", cleanConfigString(raw["channel"], "channel", 100));
      break;
    case "google_calendar":
      put(
        "calendar_id",
        cleanConfigString(raw["calendar_id"], "calendar_id", 300),
      );
      break;
    case "timecrowd": {
      const base = cleanConfigString(raw["base_url"], "base_url", 300);
      if (base) {
        let u: URL;
        try {
          u = new URL(base);
        } catch {
          throw badRequest('"config.base_url" must be a valid URL');
        }
        if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) {
          throw badRequest('"config.base_url" must be an https URL');
        }
        out["base_url"] = u.href.replace(/\/+$/, "");
      }
      break;
    }
    default:
      throw badRequest(`Unknown provider "${provider}"`);
  }
  return out;
}

export function configOf(row: IntegrationConnectionRow): IntegrationConfig {
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: IntegrationConfig = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* Serializers                                                          */
/* ------------------------------------------------------------------ */

export function publicConnection(
  row: IntegrationConnectionRow,
  lastRun: IntegrationSyncRunRow | null,
) {
  const hasSecret = row.secret_enc !== null && row.secret_enc !== "";
  let status: "connected" | "not_connected" | "disabled" = "not_connected";
  let statusDetail: string | null = null;
  if (row.enabled !== 1) {
    status = "disabled";
  } else if (row.provider === "google_calendar") {
    // No Google OAuth client is configured for Kosu yet, so this
    // provider can never be connected in this phase (see DESIGN).
    status = "not_connected";
    statusDetail =
      "Google OAuth credentials are not configured for this service yet; only the settings and the Kosu-side agenda API are available.";
  } else if (hasSecret) {
    status = "connected";
  } else {
    statusDetail =
      row.provider === "slack"
        ? "No Incoming Webhook URL is configured."
        : "No API token is configured.";
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    provider: row.provider,
    project_id: row.project_id,
    name: row.name,
    config: configOf(row),
    enabled: row.enabled === 1,
    has_secret: hasSecret,
    has_webhook_secret:
      row.webhook_secret_enc !== null && row.webhook_secret_enc !== "",
    status,
    status_detail: statusDetail,
    last_sync: lastRun
      ? {
          at: lastRun.created_at,
          kind: lastRun.kind,
          status: lastRun.status,
          message: lastRun.message,
        }
      : null,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicSyncRun(row: IntegrationSyncRunRow) {
  let stats: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.stats_json);
    if (parsed && typeof parsed === "object") {
      stats = parsed as Record<string, unknown>;
    }
  } catch {
    stats = {};
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    connection_id: row.connection_id,
    provider: row.provider,
    kind: row.kind,
    status: row.status,
    stats,
    message: row.message,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Connection CRUD                                                      */
/* ------------------------------------------------------------------ */

export async function listConnections(
  env: Env,
  tenantId: string,
): Promise<IntegrationConnectionRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM integration_connections WHERE tenant_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC",
  )
    .bind(tenantId)
    .all<IntegrationConnectionRow>();
  return res.results;
}

export async function loadConnection(
  env: Env,
  tenantId: string,
  connectionId: string,
): Promise<IntegrationConnectionRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM integration_connections WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(connectionId, tenantId)
    .first<IntegrationConnectionRow>();
  if (!row) throw notFound("Integration connection not found");
  return row;
}

/** Load by id alone (inbound webhooks are addressed by connection id). */
export async function loadConnectionAny(
  env: Env,
  connectionId: string,
): Promise<IntegrationConnectionRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM integration_connections WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(connectionId)
    .first<IntegrationConnectionRow>();
  return row ?? null;
}

export interface CreateConnectionResult {
  row: IntegrationConnectionRow;
  /** Plaintext inbound webhook secret, returned exactly once. */
  webhookSecret: string | null;
}

export async function createConnection(
  env: Env,
  input: {
    tenantId: string;
    provider: string;
    projectId: string | null;
    name: string;
    config: IntegrationConfig;
    token: string | null;
    createdByAccountId: string;
  },
): Promise<CreateConnectionResult> {
  let secretEnc: string | null = null;
  if (input.token) {
    secretEnc = await encryptField(env.FIELD_ENCRYPTION_KEY, input.token);
  }
  let webhookSecret: string | null = null;
  let webhookSecretEnc: string | null = null;
  if (WEBHOOK_PROVIDERS.includes(input.provider)) {
    webhookSecret = randomToken("whsec");
    webhookSecretEnc = await encryptField(
      env.FIELD_ENCRYPTION_KEY,
      webhookSecret,
    );
  }
  const now = nowIso();
  const row: IntegrationConnectionRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    provider: input.provider,
    project_id: input.projectId,
    name: input.name,
    config_json: JSON.stringify(input.config),
    secret_enc: secretEnc,
    webhook_secret_enc: webhookSecretEnc,
    enabled: 1,
    created_by_account_id: input.createdByAccountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO integration_connections (id, tenant_id, provider, project_id, name, config_json, secret_enc, webhook_secret_enc, enabled, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
  )
    .bind(
      row.id, row.tenant_id, row.provider, row.project_id, row.name,
      row.config_json, row.secret_enc, row.webhook_secret_enc, row.enabled,
      row.created_by_account_id, now, now,
    )
    .run();
  await recordAudit(env, {
    tenantId: row.tenant_id,
    accountId: input.createdByAccountId,
    action: "integration.create",
    targetType: "integration_connection",
    targetId: row.id,
    detail: `${row.provider}:${row.name}`.slice(0, 80),
  });
  return { row, webhookSecret };
}

export async function updateConnection(
  env: Env,
  row: IntegrationConnectionRow,
  patch: {
    name?: string;
    config?: IntegrationConfig;
    enabled?: boolean;
    /** undefined = keep, null = clear, string = replace. */
    token?: string | null;
  },
  accountId: string,
): Promise<IntegrationConnectionRow> {
  const next: IntegrationConnectionRow = {
    ...row,
    name: patch.name ?? row.name,
    config_json:
      patch.config !== undefined
        ? JSON.stringify(patch.config)
        : row.config_json,
    enabled:
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : row.enabled,
    secret_enc: row.secret_enc,
    updated_at: nowIso(),
  };
  // A saved write-only credential is bound to its original service origin.
  // Changing destination requires an explicitly supplied replacement token.
  if (row.provider === "timecrowd" && patch.config !== undefined) {
    const previous = new URL(configOf(row)["base_url"] ?? "https://timecrowd.net/api/v1");
    const replacement = new URL(patch.config["base_url"] ?? "https://timecrowd.net/api/v1");
    if (previous.origin !== replacement.origin) next.secret_enc = null;
  }
  if (patch.token !== undefined) {
    next.secret_enc =
      patch.token === null
        ? null
        : await encryptField(env.FIELD_ENCRYPTION_KEY, patch.token);
  }
  await env.DB.prepare(
    "UPDATE integration_connections SET name = ?1, config_json = ?2, secret_enc = ?3, enabled = ?4, updated_at = ?5 WHERE id = ?6",
  )
    .bind(
      next.name, next.config_json, next.secret_enc, next.enabled,
      next.updated_at, next.id,
    )
    .run();
  await recordAudit(env, {
    tenantId: row.tenant_id,
    accountId,
    action: "integration.update",
    targetType: "integration_connection",
    targetId: row.id,
    detail: `${row.provider}:${next.name}`.slice(0, 80),
  });
  return next;
}

export async function deleteConnection(
  env: Env,
  row: IntegrationConnectionRow,
  accountId: string,
): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE integration_connections SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(now, now, row.id)
    .run();
  await recordAudit(env, {
    tenantId: row.tenant_id,
    accountId,
    action: "integration.delete",
    targetType: "integration_connection",
    targetId: row.id,
    detail: `${row.provider}:${row.name}`.slice(0, 80),
  });
}

/** Decrypt the provider credential; null when unset or undecryptable. */
export async function connectionToken(
  env: Env,
  row: IntegrationConnectionRow,
): Promise<string | null> {
  if (!row.secret_enc) return null;
  try {
    return await decryptField(env.FIELD_ENCRYPTION_KEY, row.secret_enc);
  } catch {
    return null;
  }
}

export async function connectionWebhookSecret(
  env: Env,
  row: IntegrationConnectionRow,
): Promise<string | null> {
  if (!row.webhook_secret_enc) return null;
  try {
    return await decryptField(env.FIELD_ENCRYPTION_KEY, row.webhook_secret_enc);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sync runs                                                            */
/* ------------------------------------------------------------------ */

export async function recordSyncRun(
  env: Env,
  input: {
    tenantId: string;
    connectionId: string | null;
    provider: string;
    kind: string;
    status: "ok" | "error";
    stats?: Record<string, unknown>;
    message?: string | null;
    createdByAccountId?: string | null;
  },
): Promise<IntegrationSyncRunRow> {
  const row: IntegrationSyncRunRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    connection_id: input.connectionId,
    provider: input.provider,
    kind: input.kind,
    status: input.status,
    stats_json: JSON.stringify(input.stats ?? {}),
    message: input.message ? input.message.slice(0, 500) : null,
    created_by_account_id: input.createdByAccountId ?? null,
    created_at: nowIso(),
  };
  await env.DB.prepare(
    "INSERT INTO integration_sync_runs (id, tenant_id, connection_id, provider, kind, status, stats_json, message, created_by_account_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(
      row.id, row.tenant_id, row.connection_id, row.provider, row.kind,
      row.status, row.stats_json, row.message, row.created_by_account_id,
      row.created_at,
    )
    .run();
  return row;
}

/** Load a project row by id alone (webhooks/inbound have no path ids). */
export async function loadProjectRowLoose(
  env: Env,
  projectId: string,
): Promise<ProjectRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(projectId)
    .first<ProjectRow>();
  return row ?? null;
}

export async function latestRunFor(
  env: Env,
  connectionId: string,
): Promise<IntegrationSyncRunRow | null> {
  const res = await env.DB.prepare(
    "SELECT * FROM integration_sync_runs WHERE connection_id = ?1 ORDER BY created_at DESC",
  )
    .bind(connectionId)
    .all<IntegrationSyncRunRow>();
  return res.results[0] ?? null;
}

export async function listRunsFor(
  env: Env,
  connectionId: string,
  limit = 20,
): Promise<IntegrationSyncRunRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM integration_sync_runs WHERE connection_id = ?1 ORDER BY created_at DESC",
  )
    .bind(connectionId)
    .all<IntegrationSyncRunRow>();
  return res.results.slice(0, limit);
}

/** Recent runs across a whole tenant (the settings page history). */
export async function listTenantRuns(
  env: Env,
  tenantId: string,
  limit = 50,
): Promise<IntegrationSyncRunRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM integration_sync_runs WHERE tenant_id = ?1 ORDER BY created_at DESC",
  )
    .bind(tenantId)
    .all<IntegrationSyncRunRow>();
  return res.results.slice(0, limit);
}

/** The created_at of the most recent successful run (incremental sync). */
async function lastOkSyncAt(
  env: Env,
  connectionId: string,
): Promise<string | null> {
  const res = await env.DB.prepare(
    "SELECT * FROM integration_sync_runs WHERE connection_id = ?1 AND status = ?2 ORDER BY created_at DESC",
  )
    .bind(connectionId, "ok")
    .all<IntegrationSyncRunRow>();
  return res.results[0]?.created_at ?? null;
}

/* ------------------------------------------------------------------ */
/* External item mapping and task upsert                                */
/* ------------------------------------------------------------------ */

export async function findExternalItem(
  env: Env,
  tenantId: string,
  provider: string,
  externalId: string,
): Promise<ExternalItemRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM external_items WHERE tenant_id = ?1 AND provider = ?2 AND external_id = ?3",
  )
    .bind(tenantId, provider, externalId)
    .first<ExternalItemRow>();
  return row ?? null;
}

export async function recordExternalItem(
  env: Env,
  input: {
    tenantId: string;
    connectionId: string | null;
    provider: string;
    externalId: string;
    entityType: "task" | "time_entry";
    entityId: string;
    externalUpdatedAt: string | null;
  },
): Promise<void> {
  const now = nowIso();
  const existing = await findExternalItem(
    env,
    input.tenantId,
    input.provider,
    input.externalId,
  );
  if (existing) {
    await env.DB.prepare(
      "UPDATE external_items SET entity_id = ?1, external_updated_at = ?2, updated_at = ?3 WHERE id = ?4",
    )
      .bind(input.entityId, input.externalUpdatedAt, now, existing.id)
      .run();
    return;
  }
  await env.DB.prepare(
    "INSERT INTO external_items (id, tenant_id, connection_id, provider, external_id, entity_type, entity_id, external_updated_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(
      randomId(), input.tenantId, input.connectionId, input.provider,
      input.externalId, input.entityType, input.entityId,
      input.externalUpdatedAt, now, now,
    )
    .run();
}

type StatusCategoryName = "open" | "doing" | "done";

/** The status slug representing a workflow category in this project. */
export async function statusSlugForCategory(
  env: Env,
  project: ProjectRow,
  category: StatusCategoryName,
): Promise<string> {
  const { defs } = await resolveStatuses(env, {
    tenantId: project.tenant_id,
    workspaceId: project.workspace_id,
    projectId: project.id,
  });
  const found = defs.find((d) => d.category === category);
  if (found) return found.slug;
  return category === "done" ? "done" : category === "doing" ? "doing" : "todo";
}

export interface ExternalTaskData {
  /** Provider-scoped id used for the dedupe mapping. */
  externalId: string;
  title: string;
  category: StatusCategoryName;
  /** Canonical URL of the external object (becomes the task link). */
  url: string;
  linkKind: "linear" | "github_issue";
  updatedAt: string | null;
}

/**
 * Create or update the Kosu task mirroring one external issue.
 * Idempotent through external_items: re-running a sync updates the
 * title/status in place instead of creating duplicates.
 */
export async function upsertExternalTask(
  env: Env,
  connection: IntegrationConnectionRow,
  project: ProjectRow,
  data: ExternalTaskData,
  actorAccountId: string,
): Promise<{ task: TaskRow; created: boolean }> {
  const status = await statusSlugForCategory(env, project, data.category);
  const title = data.title.trim().slice(0, 300) || "(untitled)";
  const mapping = await findExternalItem(
    env,
    connection.tenant_id,
    connection.provider,
    data.externalId,
  );
  if (mapping) {
    const existing = await loadTaskAny(env, mapping.entity_id);
    if (existing && !existing.deleted_at) {
      let task = existing;
      if (existing.title !== title || existing.status !== status) {
        task = await applyTaskPatch(
          env,
          existing,
          { title, status },
          { accountId: actorAccountId, admin: true },
        );
      }
      await recordExternalItem(env, {
        tenantId: connection.tenant_id,
        connectionId: connection.id,
        provider: connection.provider,
        externalId: data.externalId,
        entityType: "task",
        entityId: task.id,
        externalUpdatedAt: data.updatedAt,
      });
      await ensureLink(
        env,
        task,
        { kind: data.linkKind, url: data.url, externalId: data.url },
        actorAccountId,
      );
      return { task, created: false };
    }
    // The mirrored task was deleted locally; do not resurrect it.
    return { task: existing as TaskRow, created: false };
  }
  const input: TaskInput = {
    title,
    descriptionEnc: null,
    status,
    priority: "medium",
    assigneeAccountId: null,
    parentTaskId: null,
    startDate: null,
    dueDate: null,
    sortOrder: 0,
    estimateMinutes: null,
  };
  const task = await insertTask(env, project, input, {
    accountId: actorAccountId,
    admin: true,
  });
  await recordExternalItem(env, {
    tenantId: connection.tenant_id,
    connectionId: connection.id,
    provider: connection.provider,
    externalId: data.externalId,
    entityType: "task",
    entityId: task.id,
    externalUpdatedAt: data.updatedAt,
  });
  await ensureLink(
    env,
    task,
    { kind: data.linkKind, url: data.url, externalId: data.url },
    actorAccountId,
  );
  return { task, created: true };
}

/* ------------------------------------------------------------------ */
/* Fetching (injectable for tests)                                      */
/* ------------------------------------------------------------------ */

export interface FetchResult {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type IntegrationFetcher = (
  url: string,
  init: RequestInit,
) => Promise<FetchResult>;

export const defaultFetcher: IntegrationFetcher = async (url, init) => {
  const res = await fetch(url, init);
  return {
    status: res.status,
    json: () => res.json(),
    text: () => res.text(),
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is Record<string, unknown> => asRecord(v) !== null,
    );
  }
  const rec = asRecord(value);
  if (rec) {
    for (const key of ["data", "items", "results", "tasks", "time_entries"]) {
      if (Array.isArray(rec[key])) return asArray(rec[key]);
    }
  }
  return [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/* ------------------------------------------------------------------ */
/* Provider syncs                                                       */
/* ------------------------------------------------------------------ */

export interface SyncStats {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
}

function emptyStats(): SyncStats {
  return { fetched: 0, created: 0, updated: 0, skipped: 0 };
}

async function syncLinear(
  env: Env,
  connection: IntegrationConnectionRow,
  project: ProjectRow,
  token: string,
  actorAccountId: string,
  fetcher: IntegrationFetcher,
): Promise<SyncStats> {
  const config = configOf(connection);
  const query = `query {
    issues(first: 100, orderBy: updatedAt) {
      nodes {
        id identifier title url updatedAt
        state { type }
        team { id }
        project { id }
      }
    }
  }`;
  const res = await fetcher("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Linear API returned HTTP ${res.status}`);
  }
  const payload = asRecord(await res.json());
  const data = asRecord(payload?.["data"]);
  const issues = asRecord(data?.["issues"]);
  const nodes = asArray(issues?.["nodes"]);
  const since = await lastOkSyncAt(env, connection.id);
  const stats = emptyStats();
  for (const node of nodes) {
    const team = asRecord(node["team"]);
    const proj = asRecord(node["project"]);
    if (config["team_id"] && str(team?.["id"]) !== config["team_id"]) {
      continue;
    }
    if (
      config["project_ext_id"] &&
      str(proj?.["id"]) !== config["project_ext_id"]
    ) {
      continue;
    }
    const updatedAt = str(node["updatedAt"]);
    if (since && updatedAt && updatedAt <= since) continue;
    const state = asRecord(node["state"]);
    const type = str(state?.["type"]) ?? "unstarted";
    if (type === "canceled") {
      stats.skipped++;
      continue;
    }
    const id = str(node["id"]);
    const url = str(node["url"]);
    const title = str(node["title"]);
    if (!id || !url || !title) {
      stats.skipped++;
      continue;
    }
    stats.fetched++;
    const category: StatusCategoryName =
      type === "completed" ? "done" : type === "started" ? "doing" : "open";
    const identifier = str(node["identifier"]);
    const result = await upsertExternalTask(
      env,
      connection,
      project,
      {
        externalId: id,
        title: identifier ? `${identifier}: ${title}` : title,
        category,
        url,
        linkKind: "linear",
        updatedAt,
      },
      actorAccountId,
    );
    if (result.created) stats.created++;
    else stats.updated++;
  }
  return stats;
}

async function syncGithubIssues(
  env: Env,
  connection: IntegrationConnectionRow,
  project: ProjectRow,
  token: string,
  actorAccountId: string,
  fetcher: IntegrationFetcher,
): Promise<SyncStats> {
  const config = configOf(connection);
  const repo = config["repo"] as string;
  const since = await lastOkSyncAt(env, connection.id);
  const stats = emptyStats();
  for (let page = 1; page <= 5; page++) {
    const params = new URLSearchParams({
      state: "all",
      per_page: "100",
      page: String(page),
    });
    if (since) params.set("since", since);
    const res = await fetcher(
      `https://api.github.com/repos/${repo}/issues?${params.toString()}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "kosu",
        },
      },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub API returned HTTP ${res.status}`);
    }
    const items = asArray(await res.json());
    if (items.length === 0) break;
    for (const item of items) {
      if (item["pull_request"]) continue; // PRs are not issues.
      const number = item["number"];
      const title = str(item["title"]);
      const url = str(item["html_url"]);
      if (typeof number !== "number" || !title || !url) {
        stats.skipped++;
        continue;
      }
      stats.fetched++;
      const result = await upsertExternalTask(
        env,
        connection,
        project,
        {
          externalId: `${repo}#${number}`,
          title,
          category: item["state"] === "closed" ? "done" : "open",
          url,
          linkKind: "github_issue",
          updatedAt: str(item["updated_at"]),
        },
        actorAccountId,
      );
      if (result.created) stats.created++;
      else stats.updated++;
    }
    if (items.length < 100) break;
  }
  return stats;
}

async function syncTimecrowd(
  env: Env,
  connection: IntegrationConnectionRow,
  project: ProjectRow,
  token: string,
  actorAccountId: string,
  fetcher: IntegrationFetcher,
): Promise<SyncStats> {
  const config = configOf(connection);
  const base = config["base_url"] ?? "https://timecrowd.net/api/v1";
  const headers = { authorization: `Bearer ${token}` };
  const stats = emptyStats();

  // Tasks first so entries can attach to their mirrored task.
  const taskIdByExternal = new Map<string, string>();
  const tasksRes = await fetcher(`${base}/tasks`, { headers, redirect: "error" });
  if (tasksRes.status < 200 || tasksRes.status >= 300) {
    throw new Error(`TimeCrowd API returned HTTP ${tasksRes.status} for /tasks`);
  }
  for (const t of asArray(await tasksRes.json())) {
    const rawId = t["id"];
    if (rawId === undefined || rawId === null) continue;
    const extId = `${connection.id}:task:${String(rawId)}`;
    const title = str(t["title"]) ?? str(t["name"]) ?? `TimeCrowd task ${String(rawId)}`;
    const mapping = await findExternalItem(
      env,
      connection.tenant_id,
      "timecrowd",
      extId,
    );
    if (mapping) {
      taskIdByExternal.set(String(rawId), mapping.entity_id);
      continue;
    }
    const task = await insertTask(
      env,
      project,
      {
        title: title.slice(0, 300),
        descriptionEnc: null,
        status: await statusSlugForCategory(env, project, "open"),
        priority: "medium",
        assigneeAccountId: null,
        parentTaskId: null,
        startDate: null,
        dueDate: null,
        sortOrder: 0,
        estimateMinutes: null,
      },
      { accountId: actorAccountId, admin: true },
    );
    await recordExternalItem(env, {
      tenantId: connection.tenant_id,
      connectionId: connection.id,
      provider: "timecrowd",
      externalId: extId,
      entityType: "task",
      entityId: task.id,
      externalUpdatedAt: str(t["updated_at"]),
    });
    taskIdByExternal.set(String(rawId), task.id);
    stats.created++;
  }

  const entriesRes = await fetcher(`${base}/time_entries`, { headers, redirect: "error" });
  if (entriesRes.status < 200 || entriesRes.status >= 300) {
    throw new Error(
      `TimeCrowd API returned HTTP ${entriesRes.status} for /time_entries`,
    );
  }
  for (const e of asArray(await entriesRes.json())) {
    const rawId = e["id"];
    if (rawId === undefined || rawId === null) continue;
    const extId = `${connection.id}:entry:${String(rawId)}`;
    const existing = await findExternalItem(
      env,
      connection.tenant_id,
      "timecrowd",
      extId,
    );
    if (existing) {
      stats.skipped++;
      continue;
    }
    const startedAt =
      str(e["started_at"]) ?? str(e["start_time"]) ?? str(e["created_at"]);
    if (!startedAt || !Number.isFinite(Date.parse(startedAt))) {
      stats.skipped++;
      continue;
    }
    const endedAt = str(e["stopped_at"]) ?? str(e["ended_at"]) ?? str(e["end_time"]);
    let duration: number | null =
      typeof e["duration"] === "number" ? Math.round(e["duration"] as number) : null;
    if (duration === null && endedAt) {
      duration = Math.max(
        0,
        Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
      );
    }
    const taskExt = e["task_id"];
    const taskId =
      taskExt !== undefined && taskExt !== null
        ? (taskIdByExternal.get(String(taskExt)) ?? null)
        : null;
    try {
      const entry = await insertEntry(
        env,
        {
          tenantId: connection.tenant_id,
          workspaceId: project.workspace_id,
          taskId,
          accountId: actorAccountId,
          startedAt: new Date(Date.parse(startedAt)).toISOString(),
          endedAt: endedAt
            ? new Date(Date.parse(endedAt)).toISOString()
            : null,
          durationSeconds: duration,
          noteEnc: null,
        },
        { accountId: actorAccountId, admin: true },
      );
      await recordExternalItem(env, {
        tenantId: connection.tenant_id,
        connectionId: connection.id,
        provider: "timecrowd",
        externalId: extId,
        entityType: "time_entry",
        entityId: entry.id,
        externalUpdatedAt: str(e["updated_at"]),
      });
      stats.fetched++;
    } catch {
      stats.skipped++;
    }
  }
  return stats;
}

/**
 * Run one sync for a connection and record the run either way. Remote
 * failures become an "error" run instead of an exception, so the status
 * surface always has something truthful to show.
 */
export async function runConnectionSync(
  env: Env,
  connection: IntegrationConnectionRow,
  project: ProjectRow | null,
  actorAccountId: string,
  kind: "manual" | "webhook" = "manual",
  fetcher: IntegrationFetcher = defaultFetcher,
): Promise<IntegrationSyncRunRow> {
  const fail = async (message: string) =>
    recordSyncRun(env, {
      tenantId: connection.tenant_id,
      connectionId: connection.id,
      provider: connection.provider,
      kind,
      status: "error",
      message,
      createdByAccountId: actorAccountId,
    });
  if (connection.enabled !== 1) return fail("Connection is disabled");
  if (!PROJECT_PROVIDERS.includes(connection.provider)) {
    return fail(`Provider ${connection.provider} does not sync into a project`);
  }
  if (!project) return fail("Connection has no target project");
  const token = await connectionToken(env, connection);
  if (!token) {
    return fail("Not connected: no API token is configured for this connection");
  }
  try {
    let stats: SyncStats;
    if (connection.provider === "linear") {
      stats = await syncLinear(env, connection, project, token, actorAccountId, fetcher);
    } else if (connection.provider === "github") {
      stats = await syncGithubIssues(env, connection, project, token, actorAccountId, fetcher);
    } else {
      stats = await syncTimecrowd(env, connection, project, token, actorAccountId, fetcher);
    }
    return recordSyncRun(env, {
      tenantId: connection.tenant_id,
      connectionId: connection.id,
      provider: connection.provider,
      kind,
      status: "ok",
      stats: { ...stats },
      createdByAccountId: actorAccountId,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Sync failed");
  }
}

/* ------------------------------------------------------------------ */
/* Inbound webhooks                                                     */
/* ------------------------------------------------------------------ */

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify an HMAC-SHA256 hex signature over the raw request body. */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHex: string,
): Promise<boolean> {
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqual(expected, signatureHex.toLowerCase());
}

export interface WebhookOutcome {
  handled: boolean;
  detail: string;
  tasksCompleted: number;
  tasksUpserted: number;
}

/** GitHub webhook: issue events upsert; a merged PR completes linked tasks. */
export async function handleGithubWebhook(
  env: Env,
  connection: IntegrationConnectionRow,
  project: ProjectRow | null,
  payload: Record<string, unknown>,
): Promise<WebhookOutcome> {
  const outcome: WebhookOutcome = {
    handled: false,
    detail: "",
    tasksCompleted: 0,
    tasksUpserted: 0,
  };
  const action = str(payload["action"]);
  const pr = asRecord(payload["pull_request"]);
  if (pr && action === "closed" && pr["merged"] === true) {
    const url = str(pr["html_url"]);
    if (!url) {
      outcome.detail = "merged PR without html_url";
      return outcome;
    }
    const links = await linksByExternal(
      env,
      connection.tenant_id,
      "github_pr",
      url,
    );
    for (const link of links) {
      const task = await loadTaskAny(env, link.task_id);
      if (!task || task.deleted_at || task.tenant_id !== connection.tenant_id) {
        continue;
      }
      const proj = await env.DB.prepare(
        "SELECT * FROM projects WHERE id = ?1 AND deleted_at IS NULL",
      )
        .bind(task.project_id)
        .first<ProjectRow>();
      if (!proj) continue;
      const doneSlug = await statusSlugForCategory(env, proj, "done");
      if (task.status === doneSlug) continue;
      const actor =
        link.created_by_account_id ?? connection.created_by_account_id;
      const completed = await applyTaskPatch(
        env,
        task,
        { status: doneSlug },
        { accountId: actor, admin: true },
      );
      outcome.tasksCompleted++;
      // Phase 5: PR-merged automation rules fire for the task.
      await runAutomationRules(env, {
        tenantId: connection.tenant_id,
        trigger: "pr_merged",
        task: completed,
        before: {
          status: task.status,
          assigneeAccountId: task.assignee_account_id,
        },
        actorAccountId: actor,
      });
    }
    outcome.handled = true;
    outcome.detail = `PR merged; ${outcome.tasksCompleted} linked task(s) completed`;
    await recordAudit(env, {
      tenantId: connection.tenant_id,
      accountId: connection.created_by_account_id,
      action: "integration.github.pr_merged",
      targetType: "integration_connection",
      targetId: connection.id,
      detail: outcome.detail.slice(0, 80),
    });
    return outcome;
  }
  const issue = asRecord(payload["issue"]);
  if (
    issue &&
    project &&
    action &&
    ["opened", "edited", "closed", "reopened"].includes(action)
  ) {
    if (issue["pull_request"]) {
      outcome.detail = "pull request event ignored";
      return outcome;
    }
    const repo = asRecord(payload["repository"]);
    const repoName = str(repo?.["full_name"]) ?? configOf(connection)["repo"] ?? "";
    const number = issue["number"];
    const title = str(issue["title"]);
    const url = str(issue["html_url"]);
    if (typeof number !== "number" || !title || !url) {
      outcome.detail = "issue payload incomplete";
      return outcome;
    }
    await upsertExternalTask(
      env,
      connection,
      project,
      {
        externalId: `${repoName}#${number}`,
        title,
        category: issue["state"] === "closed" ? "done" : "open",
        url,
        linkKind: "github_issue",
        updatedAt: str(issue["updated_at"]),
      },
      connection.created_by_account_id,
    );
    outcome.handled = true;
    outcome.tasksUpserted = 1;
    outcome.detail = `issue ${repoName}#${number} upserted`;
    return outcome;
  }
  outcome.detail = `event ignored (action=${action ?? "?"})`;
  return outcome;
}

/** Linear webhook: Issue create/update upserts the mirrored task. */
export async function handleLinearWebhook(
  env: Env,
  connection: IntegrationConnectionRow,
  project: ProjectRow | null,
  payload: Record<string, unknown>,
): Promise<WebhookOutcome> {
  const outcome: WebhookOutcome = {
    handled: false,
    detail: "",
    tasksCompleted: 0,
    tasksUpserted: 0,
  };
  const type = str(payload["type"]);
  const action = str(payload["action"]);
  const data = asRecord(payload["data"]);
  if (type !== "Issue" || !data || (action !== "create" && action !== "update")) {
    outcome.detail = `event ignored (type=${type ?? "?"}, action=${action ?? "?"})`;
    return outcome;
  }
  if (!project) {
    outcome.detail = "connection has no target project";
    return outcome;
  }
  const config = configOf(connection);
  if (config["team_id"] && str(data["teamId"]) !== config["team_id"]) {
    outcome.detail = "issue is outside the configured team";
    return outcome;
  }
  if (
    config["project_ext_id"] &&
    str(data["projectId"]) !== config["project_ext_id"]
  ) {
    outcome.detail = "issue is outside the configured project";
    return outcome;
  }
  const state = asRecord(data["state"]);
  const stateType = str(state?.["type"]) ?? "unstarted";
  if (stateType === "canceled") {
    outcome.detail = "canceled issue skipped";
    return outcome;
  }
  const id = str(data["id"]);
  const url = str(data["url"]);
  const title = str(data["title"]);
  if (!id || !url || !title) {
    outcome.detail = "issue payload incomplete";
    return outcome;
  }
  const identifier = str(data["identifier"]);
  await upsertExternalTask(
    env,
    connection,
    project,
    {
      externalId: id,
      title: identifier ? `${identifier}: ${title}` : title,
      category:
        stateType === "completed"
          ? "done"
          : stateType === "started"
            ? "doing"
            : "open",
      url,
      linkKind: "linear",
      updatedAt: str(data["updatedAt"]),
    },
    connection.created_by_account_id,
  );
  outcome.handled = true;
  outcome.tasksUpserted = 1;
  outcome.detail = `issue ${identifier ?? id} upserted`;
  return outcome;
}

/* ------------------------------------------------------------------ */
/* Slack                                                                */
/* ------------------------------------------------------------------ */

/**
 * Post one message to the tenant's Slack Incoming Webhook (the first
 * enabled slack connection with a URL configured). Best-effort: returns
 * false instead of throwing when Slack is not configured or errors.
 */
export async function sendSlackMessage(
  env: Env,
  tenantId: string,
  text: string,
  fetcher: IntegrationFetcher = defaultFetcher,
): Promise<boolean> {
  try {
    const connections = (await listConnections(env, tenantId)).filter(
      (row) => row.provider === "slack" && row.enabled === 1,
    );
    for (const connection of connections) {
      const url = await connectionToken(env, connection);
      if (!url) continue;
      const res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return res.status >= 200 && res.status < 300;
    }
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Tenant data export (backup)                                          */
/* ------------------------------------------------------------------ */

/**
 * Tables exported verbatim (they all carry tenant_id). Encrypted fields
 * stay ciphertext: a backup never contains plaintext user bodies or
 * plaintext credentials. Credential-bearing tables are handled in
 * exportTenantData with their secret columns stripped.
 */
const EXPORT_TABLES = [
  "tenant_members",
  "workspaces",
  "teams",
  "projects",
  "tasks",
  "time_entries",
  "task_dependencies",
  "milestones",
  "links",
  "labels",
  "task_labels",
  "saved_filters",
  "status_defs",
  "priority_defs",
  "custom_field_defs",
  "task_custom_values",
  "task_comments",
  "task_watchers",
  "attachments",
  "task_history",
  "recurrence_rules",
  "task_templates",
  "recent_views",
  "member_rates",
  "project_budgets",
  "leave_records",
  "time_submissions",
  "period_locks",
  "entry_change_requests",
  "invites",
  "external_items",
  "integration_sync_runs",
  "audit_log",
] as const;

async function rowsWhereTenant(
  env: Env,
  table: string,
  tenantId: string,
): Promise<Record<string, unknown>[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE tenant_id = ?1`,
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return res.results;
}

async function rowsWhereIn(
  env: Env,
  table: string,
  column: string,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const res = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE ${column} = ?1`,
    )
      .bind(id)
      .all<Record<string, unknown>>();
    out.push(...res.results);
  }
  return out;
}

function stripKeys(
  rows: Record<string, unknown>[],
  keys: string[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const copy = { ...row };
    for (const key of keys) delete copy[key];
    return copy;
  });
}

/**
 * Full tenant backup as one JSON document. Excluded on purpose:
 * accounts (shared across tenants; only ids are referenced), api_keys
 * (hashes), session/OIDC state, sync internals (change log, conflicts,
 * devices), notification rows and webhook delivery logs, and every
 * secret column (integration *_enc, webhook secret_enc, feed/inbound
 * token hashes) — a `has_secret` flag is kept instead.
 */
export async function exportTenantData(env: Env, tenantId: string) {
  const tenant = await env.DB.prepare(
    "SELECT * FROM tenants WHERE id = ?1",
  )
    .bind(tenantId)
    .first<Record<string, unknown>>();
  const data: Record<string, unknown> = {
    format: "kosu-tenant-export",
    version: 1,
    exported_at: nowIso(),
    tenant,
  };
  for (const table of EXPORT_TABLES) {
    data[table] = await rowsWhereTenant(env, table, tenantId);
  }
  // Membership tables without a tenant_id column follow their parents.
  const workspaceIds = (
    data["workspaces"] as Record<string, unknown>[]
  ).map((r) => String(r["id"]));
  const teamIds = (data["teams"] as Record<string, unknown>[]).map((r) =>
    String(r["id"]),
  );
  const projectIds = (data["projects"] as Record<string, unknown>[]).map(
    (r) => String(r["id"]),
  );
  data["workspace_members"] = await rowsWhereIn(
    env,
    "workspace_members",
    "workspace_id",
    workspaceIds,
  );
  data["team_members"] = await rowsWhereIn(
    env,
    "team_members",
    "team_id",
    teamIds,
  );
  data["project_members"] = await rowsWhereIn(
    env,
    "project_members",
    "project_id",
    projectIds,
  );
  const settings = await env.DB.prepare(
    "SELECT * FROM tenant_settings WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  data["tenant_settings"] = settings.results;
  data["workspace_settings"] = await rowsWhereIn(
    env,
    "workspace_settings",
    "workspace_id",
    workspaceIds,
  );
  data["tenant_calendar_days"] = await rowsWhereTenant(
    env,
    "tenant_calendar_days",
    tenantId,
  );
  const connections = await rowsWhereTenant(
    env,
    "integration_connections",
    tenantId,
  );
  data["integration_connections"] = connections.map((row) => ({
    ...stripKeys([row], ["secret_enc", "webhook_secret_enc"])[0],
    has_secret: row["secret_enc"] !== null && row["secret_enc"] !== "",
    has_webhook_secret:
      row["webhook_secret_enc"] !== null && row["webhook_secret_enc"] !== "",
  }));
  const webhooks = await rowsWhereTenant(env, "webhook_endpoints", tenantId);
  data["webhook_endpoints"] = stripKeys(webhooks, ["secret_enc"]);
  const feeds = await rowsWhereTenant(env, "ical_feeds", tenantId);
  data["ical_feeds"] = stripKeys(feeds, ["token_hash"]);
  const inbound = await rowsWhereTenant(env, "mail_inbound_tokens", tenantId);
  data["mail_inbound_tokens"] = stripKeys(inbound, ["token_hash"]);
  return data;
}

/* ------------------------------------------------------------------ */
/* iCal feeds                                                           */
/* ------------------------------------------------------------------ */

export function publicIcalFeed(row: IcalFeedRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    label: row.label,
    created_at: row.created_at,
    last_accessed_at: row.last_accessed_at,
    // The token itself is only returned once, at creation.
    feed_path: "/feeds/ical/<token>.ics",
  };
}

export async function createIcalFeed(
  env: Env,
  input: { tenantId: string; accountId: string; label: string | null },
): Promise<{ row: IcalFeedRow; token: string }> {
  const token = randomToken("ical");
  const row: IcalFeedRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    account_id: input.accountId,
    token_hash: await sha256Hex(token),
    label: input.label,
    created_at: nowIso(),
    last_accessed_at: null,
    revoked_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO ical_feeds (id, tenant_id, account_id, token_hash, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      row.id, row.tenant_id, row.account_id, row.token_hash, row.label,
      row.created_at,
    )
    .run();
  return { row, token };
}

export async function listIcalFeeds(
  env: Env,
  tenantId: string,
  accountId: string,
): Promise<IcalFeedRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM ical_feeds WHERE tenant_id = ?1 AND account_id = ?2 AND revoked_at IS NULL ORDER BY created_at DESC",
  )
    .bind(tenantId, accountId)
    .all<IcalFeedRow>();
  return res.results;
}

export async function revokeIcalFeed(
  env: Env,
  tenantId: string,
  accountId: string,
  feedId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM ical_feeds WHERE id = ?1 AND tenant_id = ?2 AND account_id = ?3 AND revoked_at IS NULL",
  )
    .bind(feedId, tenantId, accountId)
    .first<IcalFeedRow>();
  if (!row) throw notFound("iCal feed not found");
  await env.DB.prepare(
    "UPDATE ical_feeds SET revoked_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), feedId)
    .run();
}

/** Resolve a plaintext feed token to its feed row (hash comparison). */
export async function loadIcalFeedByToken(
  env: Env,
  token: string,
): Promise<IcalFeedRow | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT * FROM ical_feeds WHERE token_hash = ?1 AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<IcalFeedRow>();
  return row ?? null;
}

export async function touchIcalFeed(env: Env, feedId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE ical_feeds SET last_accessed_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), feedId)
    .run();
}

/* ------------------------------------------------------------------ */
/* Mail-inbound tokens                                                  */
/* ------------------------------------------------------------------ */

export function publicMailInboundToken(row: MailInboundTokenRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    label: row.label,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    // The token itself is only returned once, at creation.
    inbound_path: "/inbound/mail/<token>",
  };
}

export async function createMailInboundToken(
  env: Env,
  input: {
    tenantId: string;
    projectId: string;
    label: string | null;
    createdByAccountId: string;
  },
): Promise<{ row: MailInboundTokenRow; token: string }> {
  const token = randomToken("mail");
  const row: MailInboundTokenRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    project_id: input.projectId,
    token_hash: await sha256Hex(token),
    label: input.label,
    created_by_account_id: input.createdByAccountId,
    created_at: nowIso(),
    revoked_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO mail_inbound_tokens (id, tenant_id, project_id, token_hash, label, created_by_account_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(
      row.id, row.tenant_id, row.project_id, row.token_hash, row.label,
      row.created_by_account_id, row.created_at,
    )
    .run();
  return { row, token };
}

export async function listMailInboundTokens(
  env: Env,
  tenantId: string,
  projectId: string,
): Promise<MailInboundTokenRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM mail_inbound_tokens WHERE tenant_id = ?1 AND project_id = ?2 AND revoked_at IS NULL ORDER BY created_at DESC",
  )
    .bind(tenantId, projectId)
    .all<MailInboundTokenRow>();
  return res.results;
}

export async function revokeMailInboundToken(
  env: Env,
  tenantId: string,
  projectId: string,
  tokenId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM mail_inbound_tokens WHERE id = ?1 AND tenant_id = ?2 AND project_id = ?3 AND revoked_at IS NULL",
  )
    .bind(tokenId, tenantId, projectId)
    .first<MailInboundTokenRow>();
  if (!row) throw notFound("Mail inbound token not found");
  await env.DB.prepare(
    "UPDATE mail_inbound_tokens SET revoked_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), tokenId)
    .run();
}

/** Resolve a plaintext inbound token to its row (hash comparison). */
export async function loadMailInboundTokenByToken(
  env: Env,
  token: string,
): Promise<MailInboundTokenRow | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT * FROM mail_inbound_tokens WHERE token_hash = ?1 AND revoked_at IS NULL",
  )
    .bind(hash)
    .first<MailInboundTokenRow>();
  return row ?? null;
}

