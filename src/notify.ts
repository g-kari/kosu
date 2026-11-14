/**
 * Notifications, channel preferences and webhooks (phase 3).
 *
 * One dispatch fans an event out to its recipients:
 *  - in-app: a row in `notifications` (the app polls / lists them);
 *  - webhook: for each recipient who allows the webhook channel, the
 *    tenant's active endpoints subscribed to the event kind receive one
 *    signed POST each (deduplicated per endpoint per event). The body
 *    is JSON; the signature is `sha256=<hmac hex>` over the raw body in
 *    the `x-kosu-signature` header, keyed by the endpoint secret.
 *
 * Preferences are per (account, tenant): a JSON map of
 * kind -> { in_app, webhook } plus quiet hours (local minutes, with the
 * account's UTC offset). Quiet hours suppress webhook delivery only;
 * in-app rows are still recorded. Deadline reminders are produced by
 * `runDeadlineReminders`, driven from the Worker's scheduled handler.
 */
import { nowIso } from "./accounts";
import { decryptField, encryptField } from "./crypto";
import { randomId, randomToken } from "./tokens";
import { addDays } from "./timecalc";
import { resolveStatuses } from "./workflow";
import type {
  Env,
  IntegrationConnectionRow,
  NotificationRow,
  TaskRow,
  WebhookEndpointRow,
} from "./types";

export const NOTIFICATION_KINDS = [
  "task_assigned",
  "task_updated",
  "comment",
  "mention",
  "submission_submitted",
  "submission_decided",
  "change_request_created",
  "change_request_decided",
  "deadline_reminder",
  "sync_conflict",
  // Phase 5 kinds.
  "automation",
  "login_alert",
  "report_ready",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface ChannelPref {
  in_app: boolean;
  webhook: boolean;
}

export interface NotificationPrefs {
  kinds: Record<string, ChannelPref>;
  quiet_start_min: number | null;
  quiet_end_min: number | null;
  tz_offset_minutes: number;
}

export const DEFAULT_PREF: ChannelPref = { in_app: true, webhook: true };

export async function getPrefs(
  env: Env,
  accountId: string,
  tenantId: string,
): Promise<NotificationPrefs> {
  const row = await env.DB.prepare(
    "SELECT * FROM notification_prefs WHERE account_id = ?1 AND tenant_id = ?2",
  )
    .bind(accountId, tenantId)
    .first<{
      prefs_json: string;
      quiet_start_min: number | null;
      quiet_end_min: number | null;
      tz_offset_minutes: number;
    }>();
  if (!row) {
    return {
      kinds: {},
      quiet_start_min: null,
      quiet_end_min: null,
      tz_offset_minutes: 0,
    };
  }
  let kinds: Record<string, ChannelPref> = {};
  try {
    const parsed: unknown = JSON.parse(row.prefs_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      kinds = parsed as Record<string, ChannelPref>;
    }
  } catch {
    kinds = {};
  }
  return {
    kinds,
    quiet_start_min:
      row.quiet_start_min === null ? null : Number(row.quiet_start_min),
    quiet_end_min:
      row.quiet_end_min === null ? null : Number(row.quiet_end_min),
    tz_offset_minutes: Number(row.tz_offset_minutes) || 0,
  };
}

export async function putPrefs(
  env: Env,
  accountId: string,
  tenantId: string,
  prefs: NotificationPrefs,
): Promise<NotificationPrefs> {
  const now = nowIso();
  const existing = await env.DB.prepare(
    "SELECT account_id FROM notification_prefs WHERE account_id = ?1 AND tenant_id = ?2",
  )
    .bind(accountId, tenantId)
    .first<{ account_id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE notification_prefs SET prefs_json = ?1, quiet_start_min = ?2, quiet_end_min = ?3, tz_offset_minutes = ?4, updated_at = ?5 WHERE account_id = ?6 AND tenant_id = ?7",
    )
      .bind(
        JSON.stringify(prefs.kinds),
        prefs.quiet_start_min,
        prefs.quiet_end_min,
        prefs.tz_offset_minutes,
        now,
        accountId,
        tenantId,
      )
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO notification_prefs (account_id, tenant_id, prefs_json, quiet_start_min, quiet_end_min, tz_offset_minutes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(
        accountId,
        tenantId,
        JSON.stringify(prefs.kinds),
        prefs.quiet_start_min,
        prefs.quiet_end_min,
        prefs.tz_offset_minutes,
        now,
      )
      .run();
  }
  return prefs;
}

export function prefFor(
  prefs: NotificationPrefs,
  kind: string,
): ChannelPref {
  const p = prefs.kinds[kind];
  return {
    in_app: p?.in_app ?? DEFAULT_PREF.in_app,
    webhook: p?.webhook ?? DEFAULT_PREF.webhook,
  };
}

/** Is `now` inside the quiet window (local minutes, wrap-aware)? */
export function inQuietHours(
  prefs: NotificationPrefs,
  now: string,
): boolean {
  if (prefs.quiet_start_min === null || prefs.quiet_end_min === null) {
    return false;
  }
  const utcMin =
    Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16));
  const local = ((utcMin + prefs.tz_offset_minutes) % 1440 + 1440) % 1440;
  const { quiet_start_min: s, quiet_end_min: e } = prefs;
  if (s === e) return false;
  return s < e ? local >= s && local < e : local >= s || local < e;
}

/* ------------------------------------------------------------------ */
/* Webhook endpoints                                                    */
/* ------------------------------------------------------------------ */

export function publicWebhook(row: WebhookEndpointRow) {
  let events: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.events_json);
    if (Array.isArray(parsed)) events = parsed as string[];
  } catch {
    events = [];
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    url: row.url,
    events,
    active: row.active === 1,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createWebhook(
  env: Env,
  input: {
    tenantId: string;
    url: string;
    events: string[];
    createdByAccountId: string;
  },
): Promise<{ row: WebhookEndpointRow; secret: string }> {
  const hookKey = randomToken("whk");
  const secretEnc = await encryptField(env.FIELD_ENCRYPTION_KEY, hookKey);
  const now = nowIso();
  const row: WebhookEndpointRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    url: input.url,
    secret_enc: secretEnc,
    events_json: JSON.stringify(input.events),
    active: 1,
    created_by_account_id: input.createdByAccountId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO webhook_endpoints (id, tenant_id, url, secret_enc, events_json, active, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      row.id, row.tenant_id, row.url, row.secret_enc, row.events_json,
      row.active, row.created_by_account_id, now, now,
    )
    .run();
  // The plaintext key is returned exactly once, at creation.
  return { row, secret: hookKey };
}

export async function listWebhooks(
  env: Env,
  tenantId: string,
): Promise<WebhookEndpointRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM webhook_endpoints WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<WebhookEndpointRow>();
  return res.results;
}

export async function loadWebhook(
  env: Env,
  tenantId: string,
  endpointId: string,
): Promise<WebhookEndpointRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM webhook_endpoints WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(endpointId, tenantId)
    .first<WebhookEndpointRow>();
  return row ?? null;
}

export async function deleteWebhook(
  env: Env,
  row: WebhookEndpointRow,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE webhook_endpoints SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(nowIso(), nowIso(), row.id)
    .run();
}

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

export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<{ status: number }>;

/* ------------------------------------------------------------------ */
/* Dispatch                                                             */
/* ------------------------------------------------------------------ */

/**
 * Post an event to the tenant's Slack connection (phase 4), when one is
 * enabled and has an Incoming Webhook URL stored as its secret. Slack is
 * a tenant-level channel: one post per dispatched event, independent of
 * per-account channel preferences. Failures are ignored (best-effort,
 * same as webhook endpoints).
 */
export async function deliverSlackNotification(
  env: Env,
  event: { tenantId: string; kind: string; title: string },
  fetcher: Fetcher = (url, init) => fetch(url, init),
): Promise<boolean> {
  const conn = await env.DB.prepare(
    "SELECT * FROM integration_connections WHERE tenant_id = ?1 AND provider = ?2 AND enabled = ?3 AND secret_enc IS NOT NULL ORDER BY created_at ASC",
  )
    .bind(event.tenantId, "slack", 1)
    .first<IntegrationConnectionRow>();
  if (!conn || !conn.secret_enc) return false;
  const webhookUrl = await decryptField(
    env.FIELD_ENCRYPTION_KEY,
    conn.secret_enc,
  );
  if (!webhookUrl) return false;
  const text = `[Kosu] ${event.title}`.slice(0, 500);
  try {
    const res = await fetcher(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      }),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

export interface NotifyEvent {
  kind: NotificationKind;
  tenantId: string;
  actorAccountId?: string | null;
  recipientIds: string[];
  title: string;
  payload?: Record<string, unknown>;
  relatedType?: string | null;
  relatedId?: string | null;
  dedupeKey?: string | null;
}

export async function dispatchNotifications(
  env: Env,
  event: NotifyEvent,
  fetcher: Fetcher = (url, init) => fetch(url, init),
  now: string = nowIso(),
): Promise<{ notified: number; webhookDeliveries: number }> {
  const recipients = [...new Set(event.recipientIds)].filter(
    (id) => id && id !== event.actorAccountId,
  );
  let notified = 0;
  let deliveries = 0;
  if (recipients.length === 0) return { notified, webhookDeliveries: deliveries };

  const endpoints = (await listWebhooks(env, event.tenantId)).filter(
    (e) => e.active === 1,
  );
  const subscribed = endpoints.filter((e) => {
    try {
      const parsed: unknown = JSON.parse(e.events_json);
      return (
        Array.isArray(parsed) &&
        (parsed.includes(event.kind) || parsed.includes("*"))
      );
    } catch {
      return false;
    }
  });
  const deliveredEndpoints = new Set<string>();

  for (const recipientId of recipients) {
    const prefs = await getPrefs(env, recipientId, event.tenantId);
    const pref = prefFor(prefs, event.kind);
    if (pref.in_app) {
      const dupe = event.dedupeKey
        ? await env.DB.prepare(
            "SELECT id FROM notifications WHERE account_id = ?1 AND dedupe_key = ?2",
          )
            .bind(recipientId, event.dedupeKey)
            .first<{ id: string }>()
        : null;
      if (!dupe) {
        await env.DB.prepare(
          "INSERT INTO notifications (id, tenant_id, account_id, kind, title, payload_json, related_type, related_id, dedupe_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
          .bind(
            randomId(),
            event.tenantId,
            recipientId,
            event.kind,
            event.title.slice(0, 200),
            JSON.stringify(event.payload ?? {}),
            event.relatedType ?? null,
            event.relatedId ?? null,
            event.dedupeKey ?? null,
            now,
          )
          .run();
        notified++;
      }
    }
    if (pref.webhook && !inQuietHours(prefs, now)) {
      for (const endpoint of subscribed) {
        if (deliveredEndpoints.has(endpoint.id)) continue;
        deliveredEndpoints.add(endpoint.id);
        const body = JSON.stringify({
          event: event.kind,
          tenant_id: event.tenantId,
          recipient_account_id: recipientId,
          title: event.title,
          payload: event.payload ?? {},
          related: event.relatedId
            ? { type: event.relatedType ?? null, id: event.relatedId }
            : null,
          sent_at: now,
        });
        let statusCode: number | null = null;
        let error: string | null = null;
        try {
          const secret = await decryptField(
            env.FIELD_ENCRYPTION_KEY,
            endpoint.secret_enc,
          );
          const signature = await hmacSha256Hex(secret, body);
          const res = await fetcher(endpoint.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-kosu-event": event.kind,
              "x-kosu-signature": `sha256=${signature}`,
            },
            body,
          });
          statusCode = res.status;
        } catch (err) {
          error = err instanceof Error ? err.message.slice(0, 200) : "fetch failed";
        }
        await env.DB.prepare(
          "INSERT INTO webhook_deliveries (id, endpoint_id, tenant_id, event, recipient_account_id, payload_json, status_code, error, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
          .bind(
            randomId(), endpoint.id, event.tenantId, event.kind,
            recipientId, body, statusCode, error, now,
          )
          .run();
        deliveries++;
      }
    }
  }
  await deliverSlackNotification(env, event, fetcher);
  return { notified, webhookDeliveries: deliveries };
}

/* ------------------------------------------------------------------ */
/* In-app notification listing                                          */
/* ------------------------------------------------------------------ */

export function publicNotification(row: NotificationRow) {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    title: row.title,
    payload,
    related_type: row.related_type,
    related_id: row.related_id,
    read_at: row.read_at,
    created_at: row.created_at,
  };
}

export async function listNotifications(
  env: Env,
  accountId: string,
  tenantId: string | null,
  unreadOnly: boolean,
): Promise<NotificationRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM notifications WHERE account_id = ?1",
  )
    .bind(accountId)
    .all<NotificationRow>();
  return res.results
    .filter(
      (r) =>
        (tenantId === null || r.tenant_id === tenantId) &&
        (!unreadOnly || r.read_at === null),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 200);
}

export async function markNotificationRead(
  env: Env,
  accountId: string,
  notificationId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT * FROM notifications WHERE id = ?1 AND account_id = ?2",
  )
    .bind(notificationId, accountId)
    .first<NotificationRow>();
  if (!row) return false;
  if (!row.read_at) {
    await env.DB.prepare(
      "UPDATE notifications SET read_at = ?1 WHERE id = ?2",
    )
      .bind(nowIso(), notificationId)
      .run();
  }
  return true;
}

export async function markAllNotificationsRead(
  env: Env,
  accountId: string,
  tenantId: string,
): Promise<void> {
  const rows = await listNotifications(env, accountId, tenantId, true);
  for (const row of rows) {
    await env.DB.prepare("UPDATE notifications SET read_at = ?1 WHERE id = ?2")
      .bind(nowIso(), row.id)
      .run();
  }
}

/* ------------------------------------------------------------------ */
/* Deadline reminders (Worker scheduled handler)                        */
/* ------------------------------------------------------------------ */

/**
 * Notify assignees and watchers about tasks that are overdue (once per
 * day), due today, or due tomorrow. Dates are computed in UTC — the API
 * never learned the user's timezone, and the dedupe keys make each
 * (task, threshold) fire at most once (overdue: once per day).
 */
export async function runDeadlineReminders(
  env: Env,
  now: string = nowIso(),
  fetcher?: Fetcher,
): Promise<{ tenants: number; events: number }> {
  const today = now.slice(0, 10);
  const tomorrow = addDays(today, 1);
  const tenants = await env.DB.prepare(
    "SELECT id FROM tenants WHERE deleted_at IS NULL",
  )
    .all<{ id: string }>();
  let events = 0;
  for (const tenant of tenants.results) {
    const res = await env.DB.prepare(
      "SELECT * FROM tasks WHERE tenant_id = ?1 AND deleted_at IS NULL",
    )
      .bind(tenant.id)
      .all<TaskRow>();
    const statusCache = new Map<string, string>();
    for (const task of res.results) {
      if (!task.due_date || task.archived_at) continue;
      let threshold: "overdue" | "due_today" | "due_tomorrow" | null = null;
      if (task.due_date < today) threshold = "overdue";
      else if (task.due_date === today) threshold = "due_today";
      else if (task.due_date === tomorrow) threshold = "due_tomorrow";
      if (!threshold) continue;
      const cacheKey = task.project_id ?? "";
      let doneSlugs = statusCache.get(cacheKey);
      if (doneSlugs === undefined) {
        const { defs } = await resolveStatuses(env, {
          tenantId: tenant.id,
          workspaceId: task.workspace_id,
          projectId: task.project_id,
        });
        doneSlugs = defs
          .filter((d) => d.category === "done")
          .map((d) => d.slug)
          .join(",");
        statusCache.set(cacheKey, doneSlugs);
      }
      if (doneSlugs.split(",").includes(task.status)) continue;
      const watchers = await env.DB.prepare(
        "SELECT account_id FROM task_watchers WHERE task_id = ?1",
      )
        .bind(task.id)
        .all<{ account_id: string }>();
      const recipients = [
        ...(task.assignee_account_id ? [task.assignee_account_id] : []),
        ...watchers.results.map((w) => w.account_id),
      ];
      if (recipients.length === 0) continue;
      const dedupeKey =
        threshold === "overdue"
          ? `reminder:${task.id}:overdue:${today}`
          : `reminder:${task.id}:${threshold}:${task.due_date}`;
      const label =
        threshold === "overdue"
          ? `期限を過ぎています（${task.due_date}）`
          : threshold === "due_today"
            ? "今日が期限です"
            : "明日が期限です";
      await dispatchNotifications(
        env,
        {
          kind: "deadline_reminder",
          tenantId: tenant.id,
          recipientIds: recipients,
          title: `「${task.title}」${label}`,
          payload: {
            task_id: task.id,
            project_id: task.project_id,
            due_date: task.due_date,
            threshold,
          },
          relatedType: "task",
          relatedId: task.id,
          dedupeKey,
        },
        fetcher,
        now,
      );
      events++;
    }
  }
  return { tenants: tenants.results.length, events };
}
