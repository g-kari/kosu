/**
 * Time-entry freeze rules (phase 3 approval flow).
 *
 * Two independent freezes can make an entry immutable:
 *
 *  - Period lock: a tenant admin locks a whole month (YYYY-MM). Locked
 *    months reject every direct create/update/delete, for everyone
 *    including admins. The single exception is an *approved change
 *    request* (see src/approvals.ts), which is the sanctioned path for
 *    correcting a locked month; unlocking is the other explicit path.
 *  - Submission freeze: while one of the entry owner's submissions is
 *    `submitted` (under review) or `approved`, the owner cannot change
 *    entries inside the submitted period. Admins (tenant admin or the
 *    entry project's admin, as flagged by the caller) may still edit.
 *
 * Dates are compared on the entry's start instant: the lock month is the
 * UTC month of started_at, submission coverage uses the UTC date.
 * This module is deliberately dependency-light (no imports from
 * tasks.ts) so tasks.ts can call it without an import cycle.
 */
import { ApiError } from "./errors";
import type { Env } from "./types";

export function monthOf(instantIso: string): string {
  return instantIso.slice(0, 7);
}

export function dateOf(instantIso: string): string {
  return instantIso.slice(0, 10);
}

export async function isMonthLocked(
  env: Env,
  tenantId: string,
  month: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT period FROM period_locks WHERE tenant_id = ?1 AND period = ?2",
  )
    .bind(tenantId, month)
    .first<{ period: string }>();
  return row !== null;
}

interface SubmissionCoverRow {
  id: string;
  status: string;
  period_start: string;
  period_end: string;
}

/** The submitted/approved submission covering a date for an account. */
export async function coveringSubmission(
  env: Env,
  tenantId: string,
  accountId: string,
  date: string,
): Promise<SubmissionCoverRow | null> {
  const res = await env.DB.prepare(
    "SELECT * FROM time_submissions WHERE tenant_id = ?1 AND account_id = ?2",
  )
    .bind(tenantId, accountId)
    .all<SubmissionCoverRow>();
  for (const row of res.results) {
    if (
      (row.status === "submitted" || row.status === "approved") &&
      row.period_start <= date &&
      date <= row.period_end
    ) {
      return row;
    }
  }
  return null;
}

/**
 * Throw when an entry starting at any of `startedAts` may not be changed
 * by the actor. `entryAccountId` is the owner of the entry being changed
 * (for creates, the account the entry will belong to).
 */
export async function assertEntryEditable(
  env: Env,
  input: {
    tenantId: string;
    entryAccountId: string;
    actorAccountId: string;
    actorIsAdmin: boolean;
    /** True only when applying an approved change request. */
    viaApprovedRequest?: boolean;
    startedAts: string[];
  },
): Promise<void> {
  for (const startedAt of input.startedAts) {
    const month = monthOf(startedAt);
    if (
      !input.viaApprovedRequest &&
      (await isMonthLocked(env, input.tenantId, month))
    ) {
      throw new ApiError(
        403,
        "PERIOD_LOCKED",
        `Period ${month} is locked`,
      );
    }
    if (!input.actorIsAdmin && !input.viaApprovedRequest) {
      const cover = await coveringSubmission(
        env,
        input.tenantId,
        input.entryAccountId,
        dateOf(startedAt),
      );
      if (cover) {
        throw new ApiError(
          403,
          "ENTRY_FROZEN",
          cover.status === "approved"
            ? "This period has been approved and is frozen"
            : "This period is submitted and under review",
        );
      }
    }
  }
}
