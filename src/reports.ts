/**
 * Reports, rates, budgets and leave (phase 3).
 *
 * The time report aggregates a tenant's entries over a date range
 * (attributed by start date, UTC) with the phase-2 rounding rules
 * applied per entry. Costs use the member's current hourly rate:
 * cost = rounded_seconds / 3600 * rate_cents_per_hour, rounded to whole
 * cents. The same figure serves as the billable amount — Kosu does not
 * distinguish cost from billing rates in this phase.
 *
 * Member grouping adds an expectation baseline: workdays in the range
 * (tenant calendar) minus the member's leave days, times 8 hours.
 */
import { nowIso } from "./accounts";
import { badRequest, notFound } from "./errors";
import {
  getTenantSettings,
  listCalendarOverrides,
} from "./settings";
import { entryDurationSeconds, loadTaskAny } from "./tasks";
import {
  dateRange,
  isDateString,
  isWorkday,
  roundSeconds,
} from "./timecalc";
import { resolveRounding } from "./settings";
import { randomId } from "./tokens";
import type {
  Env,
  LeaveRecordRow,
  TimeEntryRow,
} from "./types";

/* ------------------------------------------------------------------ */
/* Rates and budgets                                                    */
/* ------------------------------------------------------------------ */

export interface MemberRate {
  account_id: string;
  rate_cents_per_hour: number;
  currency: string;
  updated_at: string;
}

export async function listRates(env: Env, tenantId: string): Promise<MemberRate[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM member_rates WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<{
      account_id: string;
      rate_cents_per_hour: number;
      currency: string;
      updated_at: string;
    }>();
  return res.results.map((r) => ({
    account_id: r.account_id,
    rate_cents_per_hour: Number(r.rate_cents_per_hour),
    currency: r.currency,
    updated_at: r.updated_at,
  }));
}

export async function getRate(
  env: Env,
  tenantId: string,
  accountId: string,
): Promise<MemberRate | null> {
  const rates = await listRates(env, tenantId);
  return rates.find((r) => r.account_id === accountId) ?? null;
}

export async function putRate(
  env: Env,
  tenantId: string,
  accountId: string,
  rateCentsPerHour: number,
  currency: string,
  updatedBy: string,
): Promise<MemberRate> {
  const now = nowIso();
  const existing = await getRate(env, tenantId, accountId);
  if (existing) {
    await env.DB.prepare(
      "UPDATE member_rates SET rate_cents_per_hour = ?1, currency = ?2, updated_by_account_id = ?3, updated_at = ?4 WHERE tenant_id = ?5 AND account_id = ?6",
    )
      .bind(rateCentsPerHour, currency, updatedBy, now, tenantId, accountId)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO member_rates (tenant_id, account_id, rate_cents_per_hour, currency, updated_by_account_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(tenantId, accountId, rateCentsPerHour, currency, updatedBy, now)
      .run();
  }
  return {
    account_id: accountId,
    rate_cents_per_hour: rateCentsPerHour,
    currency,
    updated_at: now,
  };
}

export interface ProjectBudget {
  project_id: string;
  budget_cents: number;
  currency: string;
  updated_at: string;
}

export async function getBudget(
  env: Env,
  projectId: string,
): Promise<ProjectBudget | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM project_budgets WHERE project_id = ?1",
  )
    .bind(projectId)
    .first<{
      project_id: string;
      budget_cents: number;
      currency: string;
      updated_at: string;
    }>();
  if (!row) return null;
  return {
    project_id: row.project_id,
    budget_cents: Number(row.budget_cents),
    currency: row.currency,
    updated_at: row.updated_at,
  };
}

export async function putBudget(
  env: Env,
  tenantId: string,
  projectId: string,
  budgetCents: number,
  currency: string,
  updatedBy: string,
): Promise<ProjectBudget> {
  const now = nowIso();
  const existing = await getBudget(env, projectId);
  if (existing) {
    await env.DB.prepare(
      "UPDATE project_budgets SET budget_cents = ?1, currency = ?2, updated_by_account_id = ?3, updated_at = ?4 WHERE project_id = ?5",
    )
      .bind(budgetCents, currency, updatedBy, now, projectId)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO project_budgets (project_id, tenant_id, budget_cents, currency, updated_by_account_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(projectId, tenantId, budgetCents, currency, updatedBy, now)
      .run();
  }
  return {
    project_id: projectId,
    budget_cents: budgetCents,
    currency,
    updated_at: now,
  };
}

/* ------------------------------------------------------------------ */
/* Leave                                                                */
/* ------------------------------------------------------------------ */

export const LEAVE_KINDS = ["vacation", "absence", "sick", "other"] as const;

export function publicLeave(row: LeaveRecordRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    account_id: row.account_id,
    date: row.date,
    kind: row.kind,
    note_enc: row.note_enc,
    created_by: row.created_by_account_id,
    created_at: row.created_at,
  };
}

export async function createLeave(
  env: Env,
  input: {
    tenantId: string;
    accountId: string;
    date: string;
    kind: string;
    noteEnc: string | null;
    createdByAccountId: string;
  },
): Promise<LeaveRecordRow> {
  if (!isDateString(input.date)) {
    throw badRequest('"date" must be a YYYY-MM-DD date');
  }
  if (!(LEAVE_KINDS as readonly string[]).includes(input.kind)) {
    throw badRequest('"kind" must be vacation, absence, sick or other');
  }
  const member = await env.DB.prepare(
    "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
  )
    .bind(input.tenantId, input.accountId)
    .first<{ account_id: string }>();
  if (!member) throw badRequest("Leave target is not a tenant member");
  const row: LeaveRecordRow = {
    id: randomId(),
    tenant_id: input.tenantId,
    account_id: input.accountId,
    date: input.date,
    kind: input.kind,
    note_enc: input.noteEnc,
    created_by_account_id: input.createdByAccountId,
    created_at: nowIso(),
    deleted_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO leave_records (id, tenant_id, account_id, date, kind, note_enc, created_by_account_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      row.id, row.tenant_id, row.account_id, row.date, row.kind,
      row.note_enc, row.created_by_account_id, row.created_at,
    )
    .run();
  return row;
}

export async function listLeave(
  env: Env,
  tenantId: string,
  from: string,
  to: string,
  accountId?: string | null,
): Promise<LeaveRecordRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM leave_records WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(tenantId)
    .all<LeaveRecordRow>();
  return res.results
    .filter(
      (r) =>
        r.date >= from &&
        r.date <= to &&
        (accountId === undefined || accountId === null || r.account_id === accountId),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function deleteLeave(env: Env, leaveId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM leave_records WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(leaveId)
    .first<LeaveRecordRow>();
  if (!row) throw notFound("Leave record not found");
  await env.DB.prepare("UPDATE leave_records SET deleted_at = ?1 WHERE id = ?2")
    .bind(nowIso(), leaveId)
    .run();
}

/* ------------------------------------------------------------------ */
/* Time report                                                          */
/* ------------------------------------------------------------------ */

export type ReportGroupBy = "project" | "member" | "task" | "day";

export interface ReportGroup {
  key: string;
  label: string;
  seconds: number;
  rounded_seconds: number;
  cost_cents: number;
  entries: number;
  expected_seconds?: number;
  budget_cents?: number | null;
  over_budget?: boolean;
}

export interface TimeReport {
  tenant_id: string;
  from: string;
  to: string;
  group_by: ReportGroupBy;
  currency: string;
  groups: ReportGroup[];
  totals: {
    seconds: number;
    rounded_seconds: number;
    cost_cents: number;
    entries: number;
  };
}

export async function buildTimeReport(
  env: Env,
  input: {
    tenantId: string;
    from: string;
    to: string;
    groupBy: ReportGroupBy;
    projectId?: string | null;
    accountId?: string | null;
  },
  now: string = nowIso(),
): Promise<TimeReport> {
  if (!isDateString(input.from) || !isDateString(input.to)) {
    throw badRequest('"from" and "to" must be YYYY-MM-DD dates');
  }
  if (input.from > input.to) throw badRequest('"from" must be <= "to"');
  if (dateRange(input.from, input.to).length > 366) {
    throw badRequest("Report range is too large (max 366 days)");
  }
  const entriesRes = await env.DB.prepare(
    "SELECT * FROM time_entries WHERE tenant_id = ?1 AND deleted_at IS NULL",
  )
    .bind(input.tenantId)
    .all<TimeEntryRow>();
  const entries = entriesRes.results.filter((e) => {
    const day = e.started_at.slice(0, 10);
    return (
      day >= input.from &&
      day <= input.to &&
      (input.accountId === undefined ||
        input.accountId === null ||
        e.account_id === input.accountId)
    );
  });

  const rates = new Map(
    (await listRates(env, input.tenantId)).map((r) => [r.account_id, r]),
  );
  const currencies = new Set([...rates.values()].map((r) => r.currency));
  const currency = currencies.size === 1 ? ([...currencies][0] ?? "JPY") : "JPY";

  const roundingCache = new Map<string, { minutes: number; mode: "nearest" | "up" | "down" }>();
  const groups = new Map<string, ReportGroup>();
  const taskProject = new Map<string, { projectId: string | null; title: string }>();
  let totalSeconds = 0;
  let totalRounded = 0;
  let totalCost = 0;

  for (const entry of entries) {
    let projectId: string | null = null;
    let taskTitle: string | null = null;
    if (entry.task_id) {
      let info = taskProject.get(entry.task_id);
      if (!info) {
        const task = await loadTaskAny(env, entry.task_id);
        info = {
          projectId: task?.project_id ?? null,
          title: task?.title ?? "(deleted task)",
        };
        taskProject.set(entry.task_id, info);
      }
      projectId = info.projectId;
      taskTitle = info.title;
    }
    if (input.projectId && projectId !== input.projectId) continue;
    let rounding = roundingCache.get(entry.workspace_id);
    if (!rounding) {
      rounding = await resolveRounding(env, input.tenantId, entry.workspace_id);
      roundingCache.set(entry.workspace_id, rounding);
    }
    const seconds = entryDurationSeconds(entry, now);
    const rounded = roundSeconds(seconds, rounding.minutes, rounding.mode);
    const rate = rates.get(entry.account_id);
    const cost = rate
      ? Math.round((rounded / 3600) * rate.rate_cents_per_hour)
      : 0;

    let key: string;
    let label: string;
    switch (input.groupBy) {
      case "project":
        key = projectId ?? "none";
        label = projectId ?? "プロジェクトなし";
        break;
      case "member":
        key = entry.account_id;
        label = entry.account_id;
        break;
      case "task":
        key = entry.task_id ?? "none";
        label = taskTitle ?? "タスクなし";
        break;
      case "day":
        key = entry.started_at.slice(0, 10);
        label = key;
        break;
    }
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label,
        seconds: 0,
        rounded_seconds: 0,
        cost_cents: 0,
        entries: 0,
      };
      groups.set(key, group);
    }
    group.seconds += seconds;
    group.rounded_seconds += rounded;
    group.cost_cents += cost;
    group.entries += 1;
    totalSeconds += seconds;
    totalRounded += rounded;
    totalCost += cost;
  }

  const groupList = [...groups.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  if (input.groupBy === "project") {
    for (const group of groupList) {
      if (group.key === "none") continue;
      const budget = await getBudget(env, group.key);
      group.budget_cents = budget ? budget.budget_cents : null;
      group.over_budget = budget
        ? group.cost_cents > budget.budget_cents
        : false;
      // The label becomes the project name for readability.
      const project = await env.DB.prepare(
        "SELECT name FROM projects WHERE id = ?1",
      )
        .bind(group.key)
        .first<{ name: string }>();
      if (project) group.label = project.name;
    }
  }

  if (input.groupBy === "member") {
    const settings = await getTenantSettings(env, input.tenantId);
    const overrides = await listCalendarOverrides(env, input.tenantId);
    const days = dateRange(input.from, input.to);
    const workdays = days.filter((d) =>
      isWorkday(d, settings.weekly_workdays, overrides),
    ).length;
    for (const group of groupList) {
      const leave = await listLeave(
        env,
        input.tenantId,
        input.from,
        input.to,
        group.key,
      );
      const leaveDays = new Set(leave.map((l) => l.date)).size;
      group.expected_seconds = Math.max(0, workdays - leaveDays) * 8 * 3600;
    }
  }

  return {
    tenant_id: input.tenantId,
    from: input.from,
    to: input.to,
    group_by: input.groupBy,
    currency,
    groups: groupList,
    totals: {
      seconds: totalSeconds,
      rounded_seconds: totalRounded,
      cost_cents: totalCost,
      entries: entries.length === 0 ? 0 : groupList.reduce((s, g) => s + g.entries, 0),
    },
  };
}

/** CSV rendering of a report (one row per group plus a total row). */
export function reportToCsv(report: TimeReport): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  const groupName =
    report.group_by === "project"
      ? "project"
      : report.group_by === "member"
        ? "member"
        : report.group_by === "task"
          ? "task"
          : "day";
  lines.push(
    [
      groupName,
      "label",
      "seconds",
      "rounded_seconds",
      "cost_cents",
      `currency`,
      "entries",
      "expected_seconds",
      "budget_cents",
    ]
      .map(esc)
      .join(","),
  );
  for (const g of report.groups) {
    lines.push(
      [
        g.key,
        g.label,
        g.seconds,
        g.rounded_seconds,
        g.cost_cents,
        report.currency,
        g.entries,
        g.expected_seconds ?? "",
        g.budget_cents ?? "",
      ]
        .map(esc)
        .join(","),
    );
  }
  lines.push(
    [
      "total",
      "",
      report.totals.seconds,
      report.totals.rounded_seconds,
      report.totals.cost_cents,
      report.currency,
      report.totals.entries,
      "",
      "",
    ]
      .map(esc)
      .join(","),
  );
  return lines.join("\n") + "\n";
}
