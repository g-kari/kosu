/**
 * Tenant settings: weekly work pattern, per-date calendar overrides and
 * time rounding. Rounding resolves workspace -> tenant -> defaults
 * (15 minutes, nearest) and is applied per entry at aggregation time;
 * stored durations are never rewritten.
 */
import { nowIso } from "./accounts";
import { badRequest } from "./errors";
import { dateRange, isDateString, isWorkday, type RoundingMode } from "./timecalc";
import type { Env } from "./types";

export interface TenantSettings {
  weekly_workdays: number[];
  rounding_minutes: number;
  rounding_mode: RoundingMode;
}

export const DEFAULT_SETTINGS: TenantSettings = {
  weekly_workdays: [1, 2, 3, 4, 5],
  rounding_minutes: 15,
  rounding_mode: "nearest",
};

const ROUNDING_MODES: RoundingMode[] = ["nearest", "up", "down"];

export function parseWorkdays(input: unknown): number[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw badRequest('"weekly_workdays" must be a non-empty array of 1-7');
  }
  const days: number[] = [];
  for (const d of input) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 7) {
      throw badRequest('"weekly_workdays" entries must be integers 1-7');
    }
    if (!days.includes(d)) days.push(d);
  }
  return days.sort((a, b) => a - b);
}

export function parseRoundingMinutes(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isInteger(input) ||
    input < 0 ||
    input > 240
  ) {
    throw badRequest('"rounding_minutes" must be an integer 0-240');
  }
  return input;
}

export function parseRoundingMode(input: unknown): RoundingMode {
  if (typeof input !== "string" || !ROUNDING_MODES.includes(input as RoundingMode)) {
    throw badRequest('"rounding_mode" must be nearest, up or down');
  }
  return input as RoundingMode;
}

interface TenantSettingsRow {
  tenant_id: string;
  weekly_workdays: string;
  rounding_minutes: number;
  rounding_mode: string;
  updated_at: string;
}

export async function getTenantSettings(
  env: Env,
  tenantId: string,
): Promise<TenantSettings> {
  const row = await env.DB.prepare(
    "SELECT * FROM tenant_settings WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<TenantSettingsRow>();
  if (!row) return { ...DEFAULT_SETTINGS };
  let workdays = DEFAULT_SETTINGS.weekly_workdays;
  try {
    const parsed: unknown = JSON.parse(row.weekly_workdays);
    if (Array.isArray(parsed)) workdays = parsed as number[];
  } catch {
    /* fall back to defaults */
  }
  return {
    weekly_workdays: workdays,
    rounding_minutes: Number(row.rounding_minutes),
    rounding_mode: row.rounding_mode as RoundingMode,
  };
}

export async function putTenantSettings(
  env: Env,
  tenantId: string,
  patch: Partial<TenantSettings>,
): Promise<TenantSettings> {
  const current = await getTenantSettings(env, tenantId);
  const next: TenantSettings = {
    weekly_workdays: patch.weekly_workdays ?? current.weekly_workdays,
    rounding_minutes: patch.rounding_minutes ?? current.rounding_minutes,
    rounding_mode: patch.rounding_mode ?? current.rounding_mode,
  };
  const now = nowIso();
  const existing = await env.DB.prepare(
    "SELECT tenant_id FROM tenant_settings WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<{ tenant_id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE tenant_settings SET weekly_workdays = ?1, rounding_minutes = ?2, rounding_mode = ?3, updated_at = ?4 WHERE tenant_id = ?5",
    )
      .bind(
        JSON.stringify(next.weekly_workdays),
        next.rounding_minutes,
        next.rounding_mode,
        now,
        tenantId,
      )
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO tenant_settings (tenant_id, weekly_workdays, rounding_minutes, rounding_mode, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(
        tenantId,
        JSON.stringify(next.weekly_workdays),
        next.rounding_minutes,
        next.rounding_mode,
        now,
      )
      .run();
  }
  return next;
}

export interface Rounding {
  minutes: number;
  mode: RoundingMode;
}

/** Effective rounding for a workspace: workspace override wins per field. */
export async function resolveRounding(
  env: Env,
  tenantId: string,
  workspaceId: string | null,
): Promise<Rounding> {
  const tenant = await getTenantSettings(env, tenantId);
  let result: Rounding = {
    minutes: tenant.rounding_minutes,
    mode: tenant.rounding_mode,
  };
  if (workspaceId) {
    const row = await env.DB.prepare(
      "SELECT rounding_minutes, rounding_mode FROM workspace_settings WHERE workspace_id = ?1",
    )
      .bind(workspaceId)
      .first<{
        rounding_minutes: number | null;
        rounding_mode: string | null;
      }>();
    if (row) {
      result = {
        minutes:
          row.rounding_minutes === null
            ? result.minutes
            : Number(row.rounding_minutes),
        mode: (row.rounding_mode ?? result.mode) as RoundingMode,
      };
    }
  }
  return result;
}

export async function putWorkspaceRounding(
  env: Env,
  workspaceId: string,
  rounding: { minutes: number | null; mode: RoundingMode | null },
): Promise<void> {
  const now = nowIso();
  const existing = await env.DB.prepare(
    "SELECT workspace_id FROM workspace_settings WHERE workspace_id = ?1",
  )
    .bind(workspaceId)
    .first<{ workspace_id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE workspace_settings SET rounding_minutes = ?1, rounding_mode = ?2, updated_at = ?3 WHERE workspace_id = ?4",
    )
      .bind(rounding.minutes, rounding.mode, now, workspaceId)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO workspace_settings (workspace_id, rounding_minutes, rounding_mode, updated_at) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(workspaceId, rounding.minutes, rounding.mode, now)
      .run();
  }
}

/* ------------------------------------------------------------------ */
/* Calendar                                                             */
/* ------------------------------------------------------------------ */

interface CalendarDayRow {
  date: string;
  kind: string;
  note: string | null;
}

export async function listCalendarOverrides(
  env: Env,
  tenantId: string,
): Promise<Map<string, string>> {
  const res = await env.DB.prepare(
    "SELECT date, kind, note FROM tenant_calendar_days WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<CalendarDayRow>();
  const map = new Map<string, string>();
  for (const row of res.results) map.set(row.date, row.kind);
  return map;
}

export async function setCalendarDay(
  env: Env,
  tenantId: string,
  date: string,
  kind: "holiday" | "workday",
  note: string | null,
): Promise<void> {
  if (!isDateString(date)) throw badRequest('"date" must be a YYYY-MM-DD date');
  const existing = await env.DB.prepare(
    "SELECT date FROM tenant_calendar_days WHERE tenant_id = ?1 AND date = ?2",
  )
    .bind(tenantId, date)
    .first<{ date: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE tenant_calendar_days SET kind = ?1, note = ?2 WHERE tenant_id = ?3 AND date = ?4",
    )
      .bind(kind, note, tenantId, date)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO tenant_calendar_days (tenant_id, date, kind, note) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(tenantId, date, kind, note)
      .run();
  }
}

export async function clearCalendarDay(
  env: Env,
  tenantId: string,
  date: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM tenant_calendar_days WHERE tenant_id = ?1 AND date = ?2",
  )
    .bind(tenantId, date)
    .run();
}

/** Day-by-day workday flags for a range, pattern + overrides applied. */
export async function calendarRange(
  env: Env,
  tenantId: string,
  from: string,
  to: string,
): Promise<{ date: string; workday: boolean; kind: string }[]> {
  if (!isDateString(from) || !isDateString(to) || from > to) {
    throw badRequest('"from"/"to" must be YYYY-MM-DD dates with from <= to');
  }
  const days = dateRange(from, to);
  if (days.length > 366) throw badRequest("Calendar range is too large");
  const settings = await getTenantSettings(env, tenantId);
  const overrides = await listCalendarOverrides(env, tenantId);
  return days.map((date) => {
    const override = overrides.get(date);
    return {
      date,
      workday: isWorkday(date, settings.weekly_workdays, overrides),
      kind: override ?? "weekly",
    };
  });
}
