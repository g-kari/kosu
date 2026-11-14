/**
 * Deadline escalation (phase 5 item 6).
 *
 * The phase-3 basic reminders always run. On top of them, a tenant
 * can opt into staged escalation:
 *   1. `before_days` days before the due date -> the assignee
 *   2. `overdue_admin_days` days overdue      -> assignee + watchers
 *      + project admins + tenant admins
 *   3. every `repeat_days` after that          -> stage 2 recipients
 * Settings live in escalation_settings (one row per tenant, disabled
 * by default). Dedupe keys carry the "esc:" prefix so escalation
 * notifications never collide with the basic reminders.
 */

import { badRequest } from "./errors";
import { nowIso } from "./accounts";
import { addDays } from "./timecalc";
import { resolveStatuses } from "./workflow";
import { dispatchNotifications } from "./notify";
import { listWatcherIds } from "./comments";
import { projectAdminIds, tenantAdminIds } from "./members";
import type { Env, EscalationSettingsRow, TaskRow } from "./types";

export interface EscalationSettings {
  enabled: boolean;
  before_days: number;
  overdue_admin_days: number;
  repeat_days: number;
}

export const DEFAULT_ESCALATION: EscalationSettings = {
  enabled: false,
  before_days: 3,
  overdue_admin_days: 1,
  repeat_days: 2,
};

export async function getEscalationSettings(
  env: Env,
  tenantId: string,
): Promise<EscalationSettings> {
  const row = await env.DB.prepare(
    "SELECT * FROM escalation_settings WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<EscalationSettingsRow>();
  if (!row) return { ...DEFAULT_ESCALATION };
  return {
    enabled: Number(row.enabled) === 1,
    before_days: Number(row.before_days),
    overdue_admin_days: Number(row.overdue_admin_days),
    repeat_days: Number(row.repeat_days),
  };
}

function intField(
  body: Record<string, unknown>,
  key: string,
  current: number,
): number {
  const v = body[key];
  if (v === undefined) return current;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 365) {
    throw badRequest(`"${key}" must be an integer 0-365`);
  }
  return v;
}

export async function saveEscalationSettings(
  env: Env,
  tenantId: string,
  body: Record<string, unknown>,
): Promise<EscalationSettings> {
  const current = await getEscalationSettings(env, tenantId);
  const next: EscalationSettings = {
    enabled:
      body["enabled"] === undefined
        ? current.enabled
        : (() => {
            if (typeof body["enabled"] !== "boolean") {
              throw badRequest('"enabled" must be a boolean');
            }
            return body["enabled"];
          })(),
    before_days: intField(body, "before_days", current.before_days),
    overdue_admin_days: intField(
      body,
      "overdue_admin_days",
      current.overdue_admin_days,
    ),
    repeat_days: Math.max(
      1,
      intField(body, "repeat_days", current.repeat_days),
    ),
  };
  const now = nowIso();
  const existing = await env.DB.prepare(
    "SELECT tenant_id FROM escalation_settings WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<{ tenant_id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE escalation_settings SET enabled = ?1, before_days = ?2, overdue_admin_days = ?3, repeat_days = ?4, updated_at = ?5 WHERE tenant_id = ?6",
    )
      .bind(
        next.enabled ? 1 : 0,
        next.before_days,
        next.overdue_admin_days,
        next.repeat_days,
        now,
        tenantId,
      )
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO escalation_settings (tenant_id, enabled, before_days, overdue_admin_days, repeat_days, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(
        tenantId,
        next.enabled ? 1 : 0,
        next.before_days,
        next.overdue_admin_days,
        next.repeat_days,
        now,
      )
      .run();
  }
  return next;
}

interface TenantTasks {
  tenantId: string;
  tasks: TaskRow[];
}

/** Run one escalation pass for every tenant that opted in. */
export async function runDeadlineEscalations(
  env: Env,
  now: string = nowIso(),
): Promise<{ tenants: number; notifications: number }> {
  const today = now.slice(0, 10);
  const { results: settingRows } = await env.DB.prepare(
    "SELECT * FROM escalation_settings WHERE enabled = ?1",
  )
    .bind(1)
    .all<EscalationSettingsRow>();
  let notifications = 0;
  let tenants = 0;
  for (const settings of settingRows ?? []) {
    const tenantId = settings.tenant_id;
    const config: EscalationSettings = {
      enabled: true,
      before_days: Number(settings.before_days),
      overdue_admin_days: Number(settings.overdue_admin_days),
      repeat_days: Math.max(1, Number(settings.repeat_days)),
    };
    const { results: taskRows } = await env.DB.prepare(
      "SELECT * FROM tasks WHERE tenant_id = ?1 AND deleted_at IS NULL AND archived_at IS NULL",
    )
      .bind(tenantId)
      .all<TaskRow>();
    const bundle: TenantTasks = { tenantId, tasks: taskRows ?? [] };
    tenants++;
    notifications += await escalateTenant(env, bundle, config, today);
  }
  return { tenants, notifications };
}

async function escalateTenant(
  env: Env,
  bundle: TenantTasks,
  config: EscalationSettings,
  today: string,
): Promise<number> {
  let sent = 0;
  let tenantAdmins: string[] | null = null;
  const projectAdmins = new Map<string, string[]>();

  for (const task of bundle.tasks) {
    if (!task.due_date) continue;
    const { defs } = await resolveStatuses(env, {
      tenantId: task.tenant_id,
      workspaceId: task.workspace_id,
      projectId: task.project_id,
    });
    const def = defs.find((d) => d.slug === task.status);
    if (!def || def.category === "done") {
      continue;
    }
    const due = task.due_date;
    let stage: 1 | 2 | 3 | null = null;
    if (due === addDays(today, config.before_days)) {
      stage = 1;
    } else if (due < today) {
      const overdueStart = addDays(due, config.overdue_admin_days);
      if (today === overdueStart) stage = 2;
      else if (today > overdueStart) {
        const daysSince = Math.floor(
          (Date.parse(`${today}T12:00:00Z`) -
            Date.parse(`${overdueStart}T12:00:00Z`)) /
            86_400_000,
        );
        if (daysSince % config.repeat_days === 0) stage = 3;
      }
    }
    if (stage === null) continue;

    const recipients = new Set<string>();
    if (task.assignee_account_id) recipients.add(task.assignee_account_id);
    if (stage >= 2) {
      for (const id of await listWatcherIds(env, task.id)) recipients.add(id);
      if (task.project_id) {
        if (!projectAdmins.has(task.project_id)) {
          projectAdmins.set(
            task.project_id,
            await projectAdminIds(env, task.project_id),
          );
        }
        for (const id of projectAdmins.get(task.project_id) ?? []) {
          recipients.add(id);
        }
      }
      if (tenantAdmins === null) {
        tenantAdmins = await tenantAdminIds(env, task.tenant_id);
      }
      for (const id of tenantAdmins) recipients.add(id);
    }
    if (recipients.size === 0) continue;
    const title =
      stage === 1
        ? `締切が近づいています（${config.before_days}日後）：${task.title}`
        : `締切を過ぎています：${task.title}`;
    const res = await dispatchNotifications(env, {
      kind: "deadline_reminder",
      tenantId: task.tenant_id,
      recipientIds: [...recipients],
      title,
      payload: {
        task_id: task.id,
        project_id: task.project_id,
        due_date: due,
        escalation_stage: stage,
      },
      relatedType: "task",
      relatedId: task.id,
      dedupeKey: `esc:${task.id}:${stage}:${today}`,
    });
    sent += res.notified;
  }
  return sent;
}
