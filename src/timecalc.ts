/**
 * Date, rounding and work-calendar arithmetic (pure functions).
 *
 * Dates are YYYY-MM-DD strings interpreted in the caller's local timezone;
 * the API takes an explicit local date (and a UTC offset in minutes for
 * instant ranges) so the server never has to guess a user's timezone.
 * Weekday math uses UTC noon to stay clear of DST edges.
 */

export type RoundingMode = "nearest" | "up" | "down";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = parseDate(value);
  return formatDate(d) === value;
}

export function parseDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

export function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(date: string): number {
  const day = parseDate(date).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, -(isoWeekday(date) - 1));
}

/** Every date from `from` to `to` inclusive (both YYYY-MM-DD). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Is `date` a workday under a weekly pattern plus per-date overrides?
 * `overrides` maps date -> "holiday" | "workday" and wins over the pattern.
 */
export function isWorkday(
  date: string,
  weeklyWorkdays: number[],
  overrides: Map<string, string>,
): boolean {
  const override = overrides.get(date);
  if (override === "holiday") return false;
  if (override === "workday") return true;
  return weeklyWorkdays.includes(isoWeekday(date));
}

/** Round a duration in seconds to a multiple of `minutes`. */
export function roundSeconds(
  seconds: number,
  minutes: number,
  mode: RoundingMode,
): number {
  if (!minutes || minutes <= 0) return seconds;
  const unit = minutes * 60;
  if (mode === "up") return Math.ceil(seconds / unit) * unit;
  if (mode === "down") return Math.floor(seconds / unit) * unit;
  return Math.round(seconds / unit) * unit;
}

/**
 * UTC instant range [start, end) covering one local date at a fixed UTC
 * offset (minutes east of UTC, e.g. 540 for JST).
 */
export function localDayRangeUtc(
  date: string,
  tzOffsetMinutes: number,
): { start: string; end: string } {
  const startMs =
    Date.parse(`${date}T00:00:00.000Z`) - tzOffsetMinutes * 60_000;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * 60 * 60_000).toISOString(),
  };
}

/** Whole seconds between two ISO instants (never negative). */
export function secondsBetween(startIso: string, endIso: string): number {
  const diff = Math.floor(
    (Date.parse(endIso) - Date.parse(startIso)) / 1000,
  );
  return Number.isFinite(diff) && diff > 0 ? diff : 0;
}
