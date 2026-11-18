/**
 * Automation rules (phase 5 item 1): a minimal rule engine.
 *
 * A rule fires on a trigger (task created, task status changed, task
 * assigned, linked PR merged), optionally filtered by a condition
 * (from/to status, assignee), and applies a list of actions
 * (set status, set assignee, notify). Rules never re-enter the engine:
 * actions are applied directly at the task layer, so a rule cannot
 * trigger another rule. Every execution is recorded in
 * automation_runs (also when a condition does not match — result
 * "skipped" — so the log explains why nothing happened).
 */

import { guardAutomationScope } from "./automation-access";
import { randomId } from "./tokens";
import { badRequest } from "./errors";
import { nowIso } from "./accounts";
import { applyTaskPatch, loadTaskAny, type ChangeSource } from "./tasks";
import { listWatcherIds } from "./comments";
import { dispatchNotifications } from "./notify";
import { tenantAdminIds } from "./members";
import type { AutomationRuleRow, Env, TaskRow } from "./types";

export const AUTOMATION_TRIGGERS = [
  "task_created",
  "task_status_changed",
  "task_assigned",
  "pr_merged",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export interface AutomationCondition {
  from_status?: string;
  to_status?: string;
  assignee_account_id?: string;
}

export type AutomationAction =
  | { type: "set_status"; status: string }
  | { type: "set_assignee"; account_id: string }
  | { type: "notify"; recipient: "assignee" | "watchers" | "tenant_admins" };

const TRIGGER_SET = new Set<string>(AUTOMATION_TRIGGERS);

function parseJson(value: unknown, field: string): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw badRequest(`"${field}" must be valid JSON`);
    }
  }
  return value;
}

export function parseCondition(raw: unknown): AutomationCondition {
  const parsed = parseJson(raw ?? {}, "condition");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest('"condition" must be an object');
  }
  const out: AutomationCondition = {};
  const rec = parsed as Record<string, unknown>;
  for (const key of ["from_status", "to_status", "assignee_account_id"] as const) {
    const v = rec[key];
    if (v !== undefined) {
      if (typeof v !== "string" || v.length === 0 || v.length > 200) {
        throw badRequest(`"condition.${key}" must be a short string`);
      }
      out[key] = v;
    }
  }
  return out;
}

export function parseActions(raw: unknown): AutomationAction[] {
  const parsed = parseJson(raw ?? [], "actions");
  if (!Array.isArray(parsed)) {
    throw badRequest('"actions" must be an array');
  }
  if (parsed.length > 10) {
    throw badRequest('"actions" may contain at most 10 entries');
  }
  const out: AutomationAction[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw badRequest('"actions" entries must be objects');
    }
    const rec = item as Record<string, unknown>;
    if (rec["type"] === "set_status") {
      if (typeof rec["status"] !== "string" || rec["status"] === "") {
        throw badRequest('set_status action requires "status"');
      }
      out.push({ type: "set_status", status: rec["status"] });
    } else if (rec["type"] === "set_assignee") {
      if (typeof rec["account_id"] !== "string" || rec["account_id"] === "") {
        throw badRequest('set_assignee action requires "account_id"');
      }
      out.push({ type: "set_assignee", account_id: rec["account_id"] });
    } else if (rec["type"] === "notify") {
      const r = rec["recipient"];
      if (r !== "assignee" && r !== "watchers" && r !== "tenant_admins") {
        throw badRequest(
          'notify action requires "recipient": assignee | watchers | tenant_admins',
        );
      }
      out.push({ type: "notify", recipient: r });
    } else {
      throw badRequest(`unknown action type: ${String(rec["type"])}`);
    }
  }
  return out;
}

export interface AutomationRuleInput {
  name: string;
  projectId: string | null;
  trigger: string;
  condition: AutomationCondition;
  actions: AutomationAction[];
  enabled: boolean;
}

export function parseRuleBody(
  body: Record<string, unknown>,
): AutomationRuleInput {
  const name = body["name"];
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) {
    throw badRequest('"name" is required (max 200 chars)');
  }
  const trigger = body["trigger"];
  if (typeof trigger !== "string" || !TRIGGER_SET.has(trigger)) {
    throw badRequest(
      `"trigger" must be one of ${AUTOMATION_TRIGGERS.join(", ")}`,
    );
  }
  const projectId = body["project_id"] ?? null;
  if (projectId !== null && typeof projectId !== "string") {
    throw badRequest('"project_id" must be a string or null');
  }
  const enabled = body["enabled"] === undefined ? true : body["enabled"];
  if (typeof enabled !== "boolean") {
    throw badRequest('"enabled" must be a boolean');
  }
  return {
    name: name.trim(),
    projectId,
    trigger,
    condition: parseCondition(body["condition"] ?? body["condition_json"]),
    actions: parseActions(body["actions"] ?? body["actions_json"]),
    enabled,
  };
}

export function publicRule(row: AutomationRuleRow): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    name: row.name,
    trigger: row.trigger_kind,
    condition: safeParse(row.condition_json, {}),
    actions: safeParse(row.actions_json, []),
    enabled: Number(row.enabled) === 1,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeParse(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fallback;
  }
}

export async function insertRule(
  env: Env,
  tenantId: string,
  input: AutomationRuleInput,
  createdBy: string,
): Promise<AutomationRuleRow> {
  const now = nowIso();
  const row: AutomationRuleRow = {
    id: randomId(),
    tenant_id: tenantId,
    project_id: input.projectId,
    name: input.name,
    trigger_kind: input.trigger,
    condition_json: JSON.stringify(input.condition),
    actions_json: JSON.stringify(input.actions),
    enabled: input.enabled ? 1 : 0,
    created_by_account_id: createdBy,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO automation_rules (id, tenant_id, project_id, name, trigger_kind, condition_json, actions_json, enabled, created_by_account_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
  )
    .bind(
      row.id, row.tenant_id, row.project_id, row.name, row.trigger_kind,
      row.condition_json, row.actions_json, row.enabled,
      row.created_by_account_id, now, now,
    )
    .run();
  return row;
}

export async function listRules(
  env: Env,
  tenantId: string,
): Promise<AutomationRuleRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM automation_rules WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<AutomationRuleRow>();
  return results ?? [];
}

export async function getRule(
  env: Env,
  tenantId: string,
  ruleId: string,
): Promise<AutomationRuleRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM automation_rules WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL",
  )
    .bind(ruleId, tenantId)
    .first<AutomationRuleRow>();
  return row ?? null;
}

export async function updateRule(
  env: Env,
  row: AutomationRuleRow,
  input: AutomationRuleInput,
): Promise<AutomationRuleRow> {
  const now = nowIso();
  const next: AutomationRuleRow = {
    ...row,
    name: input.name,
    project_id: input.projectId,
    trigger_kind: input.trigger,
    condition_json: JSON.stringify(input.condition),
    actions_json: JSON.stringify(input.actions),
    enabled: input.enabled ? 1 : 0,
    updated_at: now,
  };
  await env.DB.prepare(
    "UPDATE automation_rules SET name = ?1, project_id = ?2, trigger_kind = ?3, condition_json = ?4, actions_json = ?5, enabled = ?6, updated_at = ?7 WHERE id = ?8",
  )
    .bind(
      next.name, next.project_id, next.trigger_kind, next.condition_json,
      next.actions_json, next.enabled, now, next.id,
    )
    .run();
  return next;
}

export async function deleteRule(env: Env, row: AutomationRuleRow): Promise<void> {
  await env.DB.prepare(
    "UPDATE automation_rules SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(nowIso(), nowIso(), row.id)
    .run();
}

async function recordRun(
  env: Env,
  tenantId: string,
  rule: AutomationRuleRow,
  target: TaskRow | null,
  result: "ok" | "error" | "skipped",
  detail: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO automation_runs (id, tenant_id, rule_id, trigger_kind, target_type, target_id, result, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      randomId(), tenantId, rule.id, rule.trigger_kind,
      target ? "task" : null, target?.id ?? null, result, detail,
      nowIso(),
    )
    .run();
}

function conditionMatches(
  condition: AutomationCondition,
  task: TaskRow,
  before: { status: string; assigneeAccountId: string | null } | undefined,
): boolean {
  if (
    condition.from_status !== undefined &&
    (!before || before.status !== condition.from_status)
  ) {
    return false;
  }
  if (
    condition.to_status !== undefined &&
    task.status !== condition.to_status
  ) {
    return false;
  }
  if (
    condition.assignee_account_id !== undefined &&
    task.assignee_account_id !== condition.assignee_account_id
  ) {
    return false;
  }
  return true;
}

export interface AutomationEvent {
  tenantId: string;
  trigger: AutomationTrigger;
  task: TaskRow;
  before?: { status: string; assigneeAccountId: string | null };
  actorAccountId: string;
}

/**
 * Fire all matching tenant rules for an event. Failures are recorded
 * in the run log and never break the caller's request.
 */
export async function runAutomationRules(
  env: Env,
  event: AutomationEvent,
): Promise<void> {

  const rules = (await listRules(env, event.tenantId)).filter(
    (r) =>
      r.trigger_kind === event.trigger &&
      Number(r.enabled) === 1 &&
      (r.project_id === null || r.project_id === event.task.project_id),
  );
  for (const rule of rules) {
    const condition = safeParse(
      rule.condition_json,
      {},
    ) as AutomationCondition;
    if (!conditionMatches(condition, event.task, event.before)) {
      await recordRun(env, event.tenantId, rule, event.task, "skipped", "条件に一致しませんでした");
      continue;
    }
    const actions = safeParse(rule.actions_json, []) as AutomationAction[];
    const applied: string[] = [];
    try {
      const principal = {kind:"session" as const,accountId:rule.created_by_account_id};
      await guardAutomationScope(env,principal,event.tenantId,rule.project_id,"admin");
      await guardAutomationScope(env,principal,event.tenantId,event.task.project_id,"admin");
      const source: ChangeSource = {accountId:rule.created_by_account_id};
      let current = event.task;
      for (const action of actions) {
        if (action.type === "set_status") {
          current = await applyTaskPatch(
            env,
            current,
            { status: action.status },
            source,
          );
          applied.push(`status=${action.status}`);
        } else if (action.type === "set_assignee") {
          current = await applyTaskPatch(
            env,
            current,
            { assigneeAccountId: action.account_id },
            source,
          );
          applied.push("assignee set");
        } else {
          let recipients: string[] = [];
          if (action.recipient === "assignee") {
            recipients = current.assignee_account_id
              ? [current.assignee_account_id]
              : [];
          } else if (action.recipient === "watchers") {
            recipients = await listWatcherIds(env, current.id);
          } else {
            recipients = await tenantAdminIds(env, event.tenantId);
          }
          if (recipients.length > 0) {
            await dispatchNotifications(env, {
              kind: "automation",
              tenantId: event.tenantId,
              actorAccountId: event.actorAccountId,
              recipientIds: recipients,
              title: `自動化「${rule.name}」がタスク「${current.title}」に適用されました`,
              payload: { task_id: current.id, rule_id: rule.id },
              relatedType: "task",
              relatedId: current.id,
            });
          }
          applied.push(`notify:${action.recipient}`);
        }
      }
      // Reload so later rules in this pass see the updated task.
      const fresh = await loadTaskAny(env, event.task.id);
      if (fresh) event.task = fresh;
      await recordRun(
        env,
        event.tenantId,
        rule,
        event.task,
        "ok",
        applied.join(", ") || "no actions",
      );
    } catch (err) {
      await recordRun(
        env,
        event.tenantId,
        rule,
        event.task,
        "error",
        err instanceof Error ? err.message.slice(0, 300) : "unknown error",
      );
    }
  }
}

export async function listRuns(
  env: Env,
  tenantId: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM automation_runs WHERE tenant_id = ?1 ORDER BY created_at DESC",
  )
    .bind(tenantId)
    .all<Record<string, unknown>>();
  return (results ?? []).slice(0, limit);
}

