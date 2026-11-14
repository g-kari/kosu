/**
 * Per-account display preferences (phase 5 items 8-9): theme, locale
 * and the week's starting weekday. Stored server-side so every device
 * shows the same UI; defaults match phase 1-4 behaviour.
 */

import { badRequest } from "./errors";
import { nowIso } from "./accounts";
import type { Env, UserPrefsRow } from "./types";

export interface UserPrefs {
  theme: "system" | "light" | "dark";
  locale: "ja" | "en";
  week_start: number; // ISO weekday 1 (Mon) .. 7 (Sun)
}

export const DEFAULT_PREFS: UserPrefs = {
  theme: "system",
  locale: "ja",
  week_start: 1,
};

export async function getUserPrefs(
  env: Env,
  accountId: string,
): Promise<UserPrefs> {
  const row = await env.DB.prepare(
    "SELECT * FROM user_prefs WHERE account_id = ?1",
  )
    .bind(accountId)
    .first<UserPrefsRow>();
  if (!row) return { ...DEFAULT_PREFS };
  return {
    theme:
      row.theme === "light" || row.theme === "dark" ? row.theme : "system",
    locale: row.locale === "en" ? "en" : "ja",
    week_start: Math.min(7, Math.max(1, Number(row.week_start) || 1)),
  };
}

export function parsePrefsPatch(
  body: Record<string, unknown>,
): Partial<UserPrefs> {
  const out: Partial<UserPrefs> = {};
  if (body["theme"] !== undefined) {
    const v = body["theme"];
    if (v !== "system" && v !== "light" && v !== "dark") {
      throw badRequest('"theme" must be system, light or dark');
    }
    out.theme = v;
  }
  if (body["locale"] !== undefined) {
    const v = body["locale"];
    if (v !== "ja" && v !== "en") {
      throw badRequest('"locale" must be ja or en');
    }
    out.locale = v;
  }
  if (body["week_start"] !== undefined) {
    const v = body["week_start"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 7) {
      throw badRequest('"week_start" must be an ISO weekday 1-7');
    }
    out.week_start = v;
  }
  return out;
}

export async function saveUserPrefs(
  env: Env,
  accountId: string,
  patch: Partial<UserPrefs>,
): Promise<UserPrefs> {
  const current = await getUserPrefs(env, accountId);
  const next: UserPrefs = { ...current, ...patch };
  const now = nowIso();
  const existing = await env.DB.prepare(
    "SELECT account_id FROM user_prefs WHERE account_id = ?1",
  )
    .bind(accountId)
    .first<{ account_id: string }>();
  if (existing) {
    await env.DB.prepare(
      "UPDATE user_prefs SET theme = ?1, locale = ?2, week_start = ?3, updated_at = ?4 WHERE account_id = ?5",
    )
      .bind(next.theme, next.locale, next.week_start, now, accountId)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO user_prefs (account_id, theme, locale, week_start, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(accountId, next.theme, next.locale, next.week_start, now)
      .run();
  }
  return next;
}
