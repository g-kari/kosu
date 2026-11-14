/**
 * Time approval flow (phase 3): submissions, period locks and
 * correction / proxy requests.
 *
 * Flow: a member submits a date period -> a tenant admin approves or
 * rejects it. While a period is submitted or approved, the owner's
 * entries inside it are frozen for the owner (see src/locks.ts);
 * rejection returns the period to a draft state. A separate month lock
 * freezes a whole month for everyone until an admin unlocks it.
 *
 * Correction requests are how frozen (or anyone's) entries get changed:
 * the requester proposes an edit/create/delete, a decider (tenant
 * admin, or the entry owner when someone else proposed it) approves,
 * and the change is applied with admin rights, bypassing the freeze.
 * Proxy input is the direct form of the same idea: an admin records an
 * entry on another member's behalf without a request round-trip.
 */
import { nowIso } from "./accounts";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import { isMonthLocked } from "./locks";
import { dispatchNotifications } from "./notify";
import {
  applyEntryPatch,
  insertEntry,
  loadEntry,
  parseEntryInput,
  publicEntry,
  softDeleteEntry,
} from "./tasks";
import { isDateString } from "./timecalc";
import { randomId } from "./tokens";
import type {
  Env,
  EntryChangeRequestRow,
  Principal,
  TimeSubmissionRow,
} from "./types";

/* ------------------------------------------------------------------ */
/* Submissions                                                          */
/* ------------------------------------------------------------------ */

export function publicSubmission(row: TimeSubmissionRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    account_id: row.account_id,
    period_start: row.period_start,
    period_end: row.period_end,
    status: row.status,
    submitted_at: row.submitted_at,
    reviewed_by: row.reviewed_by_account_id,
    reviewed_at: row.reviewed_at,
    review_note_enc: row.review_note_enc,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createSubmission(
  env: Env,
  principal: Principal,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<TimeSubmissionRow> {
  if (!isDateString(periodStart) || !isDateString(periodEnd)) {
    throw badRequest('"period_start" and "period_end" must be YYYY-MM-DD dates');
  }
  if (periodStart > periodEnd) {
    throw badRequest('"period_start" must be <= "period_end"');
  }
  const existing = await env.DB.prepare(
    "SELECT * FROM time_submissions WHERE tenant_id = ?1 AND account_id = ?2",
  )
    .bind(tenantId, principal.accountId)
    .all<TimeSubmissionRow>();
  for (const row of existing.results) {
    if (
      (row.status === "submitted" || row.status === "approved") &&
      row.period_start <= periodEnd &&
      periodStart <= row.period_end
    ) {
      throw conflict(
        "SUBMISSION_OVERLAP",
        "An active submission already covers part of this period",
      );
    }
  }
  const now = nowIso();
  const row: TimeSubmissionRow = {
    id: randomId(),
    tenant_id: tenantId,
    account_id: principal.accountId,
    period_start: periodStart,
    period_end: periodEnd,
    status: "submitted",
    submitted_at: now,
    reviewed_by_account_id: null,
    reviewed_at: null,
    review_note_enc: null,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO time_submissions (id, tenant_id, account_id, period_start, period_end, status, submitted_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      row.id, tenantId, principal.accountId, periodStart, periodEnd,
      "submitted", now, now, now,
    )
    .run();
  // Notify the tenant admins that a period awaits review.
  const admins = await tenantAdminIds(env, tenantId);
  await dispatchNotifications(env, {
    kind: "submission_submitted",
    tenantId,
    actorAccountId: principal.accountId,
    recipientIds: admins,
    title: `工数の提出がありました（${periodStart} 〜 ${periodEnd}）`,
    payload: { submission_id: row.id, period_start: periodStart, period_end: periodEnd },
    relatedType: "submission",
    relatedId: row.id,
  });
  return row;
}

export async function listSubmissions(
  env: Env,
  tenantId: string,
  accountId: string | null,
): Promise<TimeSubmissionRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM time_submissions WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<TimeSubmissionRow>();
  return res.results
    .filter((r) => accountId === null || r.account_id === accountId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function decideSubmission(
  env: Env,
  principal: Principal,
  tenantId: string,
  submissionId: string,
  decision: "approved" | "rejected",
  reviewNoteEnc: string | null,
): Promise<TimeSubmissionRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM time_submissions WHERE id = ?1 AND tenant_id = ?2",
  )
    .bind(submissionId, tenantId)
    .first<TimeSubmissionRow>();
  if (!row) throw notFound("Submission not found");
  if (row.status !== "submitted") {
    throw conflict("SUBMISSION_DECIDED", "This submission was already decided");
  }
  const now = nowIso();
  const next: TimeSubmissionRow = {
    ...row,
    status: decision,
    reviewed_by_account_id: principal.accountId,
    reviewed_at: now,
    review_note_enc: reviewNoteEnc,
    updated_at: now,
  };
  await env.DB.prepare(
    "UPDATE time_submissions SET status = ?1, reviewed_by_account_id = ?2, reviewed_at = ?3, review_note_enc = ?4, updated_at = ?5 WHERE id = ?6",
  )
    .bind(decision, principal.accountId, now, reviewNoteEnc, now, submissionId)
    .run();
  await dispatchNotifications(env, {
    kind: "submission_decided",
    tenantId,
    actorAccountId: principal.accountId,
    recipientIds: [row.account_id],
    title:
      decision === "approved"
        ? `工数が承認されました（${row.period_start} 〜 ${row.period_end}）`
        : `工数が差し戻されました（${row.period_start} 〜 ${row.period_end}）`,
    payload: { submission_id: row.id, decision },
    relatedType: "submission",
    relatedId: row.id,
  });
  return next;
}

/* ------------------------------------------------------------------ */
/* Period locks                                                         */
/* ------------------------------------------------------------------ */

export async function listLocks(
  env: Env,
  tenantId: string,
): Promise<{ period: string; locked_by: string; locked_at: string }[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM period_locks WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<{ period: string; locked_by_account_id: string; locked_at: string }>();
  return res.results
    .map((r) => ({
      period: r.period,
      locked_by: r.locked_by_account_id,
      locked_at: r.locked_at,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export async function lockPeriod(
  env: Env,
  principal: Principal,
  tenantId: string,
  period: string,
): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw badRequest('"period" must be YYYY-MM');
  }
  if (await isMonthLocked(env, tenantId, period)) return;
  await env.DB.prepare(
    "INSERT INTO period_locks (tenant_id, period, locked_by_account_id, locked_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(tenantId, period, principal.accountId, nowIso())
    .run();
}

export async function unlockPeriod(
  env: Env,
  tenantId: string,
  period: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM period_locks WHERE tenant_id = ?1 AND period = ?2",
  )
    .bind(tenantId, period)
    .run();
}

/* ------------------------------------------------------------------ */
/* Change requests (corrections and proxy input)                        */
/* ------------------------------------------------------------------ */

export function publicChangeRequest(row: EntryChangeRequestRow) {
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
    entry_id: row.entry_id,
    target_account_id: row.target_account_id,
    requester_account_id: row.requester_account_id,
    type: row.type,
    payload,
    reason_enc: row.reason_enc,
    status: row.status,
    decided_by: row.decided_by_account_id,
    decided_at: row.decided_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function tenantAdminIds(
  env: Env,
  tenantId: string,
): Promise<string[]> {
  const res = await env.DB.prepare(
    "SELECT account_id, role FROM tenant_members WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<{ account_id: string; role: string }>();
  return res.results
    .filter((r) => r.role === "owner" || r.role === "admin")
    .map((r) => r.account_id);
}

export async function createChangeRequest(
  env: Env,
  principal: Principal,
  tenantId: string,
  input: {
    entryId: string | null;
    type: "edit" | "create" | "delete";
    payload: Record<string, unknown>;
    reasonEnc: string | null;
  },
): Promise<EntryChangeRequestRow> {
  let targetAccountId = principal.accountId;
  if (input.type === "create") {
    const rawTarget = input.payload["account_id"];
    if (rawTarget !== undefined && rawTarget !== null) {
      if (typeof rawTarget !== "string") {
        throw badRequest('"payload.account_id" must be an account id');
      }
      targetAccountId = rawTarget;
    }
    // Validate the proposed entry fields now, so approval cannot fail
    // on shape errors later.
    parseEntryInput(input.payload, false);
  } else {
    if (!input.entryId) throw badRequest('"entry_id" is required');
    const entry = await loadEntry(env, input.entryId);
    if (entry.tenant_id !== tenantId) throw notFound("Time entry not found");
    targetAccountId = entry.account_id;
    if (input.type === "edit") parseEntryInput(input.payload, true);
  }
  const now = nowIso();
  const row: EntryChangeRequestRow = {
    id: randomId(),
    tenant_id: tenantId,
    entry_id: input.entryId,
    target_account_id: targetAccountId,
    requester_account_id: principal.accountId,
    type: input.type,
    payload_json: JSON.stringify(input.payload),
    reason_enc: input.reasonEnc,
    status: "pending",
    decided_by_account_id: null,
    decided_at: null,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO entry_change_requests (id, tenant_id, entry_id, target_account_id, requester_account_id, type, payload_json, reason_enc, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
  )
    .bind(
      row.id, tenantId, row.entry_id, row.target_account_id,
      row.requester_account_id, row.type, row.payload_json,
      row.reason_enc, "pending", now, now,
    )
    .run();
  const admins = await tenantAdminIds(env, tenantId);
  const recipients = [...new Set([...admins, targetAccountId])];
  await dispatchNotifications(env, {
    kind: "change_request_created",
    tenantId,
    actorAccountId: principal.accountId,
    recipientIds: recipients,
    title: "打刻の修正申請がありました",
    payload: { change_request_id: row.id, type: input.type },
    relatedType: "change_request",
    relatedId: row.id,
  });
  return row;
}

export async function listChangeRequests(
  env: Env,
  tenantId: string,
  filter: { accountId?: string; all: boolean },
): Promise<EntryChangeRequestRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM entry_change_requests WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<EntryChangeRequestRow>();
  return res.results
    .filter(
      (r) =>
        filter.all ||
        r.requester_account_id === filter.accountId ||
        r.target_account_id === filter.accountId,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function decideChangeRequest(
  env: Env,
  principal: Principal,
  tenantId: string,
  requestId: string,
  decision: "approved" | "rejected",
  deciderIsAdmin: boolean,
): Promise<EntryChangeRequestRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM entry_change_requests WHERE id = ?1 AND tenant_id = ?2",
  )
    .bind(requestId, tenantId)
    .first<EntryChangeRequestRow>();
  if (!row) throw notFound("Change request not found");
  if (row.status !== "pending") {
    throw conflict("REQUEST_DECIDED", "This request was already decided");
  }
  // Who may decide: a tenant admin, or the entry owner when the
  // requester is someone else. The requester never decides their own.
  const mayDecide =
    deciderIsAdmin ||
    (row.target_account_id === principal.accountId &&
      row.requester_account_id !== principal.accountId);
  if (!mayDecide) {
    throw forbidden("Only a tenant admin or the entry owner can decide");
  }
  if (decision === "approved") {
    await applyChangeRequest(env, principal, row);
  }
  const now = nowIso();
  const next: EntryChangeRequestRow = {
    ...row,
    status: decision,
    decided_by_account_id: principal.accountId,
    decided_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    "UPDATE entry_change_requests SET status = ?1, decided_by_account_id = ?2, decided_at = ?3, updated_at = ?4 WHERE id = ?5",
  )
    .bind(decision, principal.accountId, now, now, requestId)
    .run();
  await dispatchNotifications(env, {
    kind: "change_request_decided",
    tenantId,
    actorAccountId: principal.accountId,
    recipientIds: [row.requester_account_id],
    title:
      decision === "approved"
        ? "打刻の修正申請が承認されました"
        : "打刻の修正申請が差し戻されました",
    payload: { change_request_id: row.id, decision },
    relatedType: "change_request",
    relatedId: row.id,
  });
  return next;
}

/** Apply an approved request with admin rights (freeze bypassed). */
async function applyChangeRequest(
  env: Env,
  principal: Principal,
  row: EntryChangeRequestRow,
): Promise<void> {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const source = { accountId: principal.accountId, admin: true, viaApprovedRequest: true };
  if (row.type === "create") {
    const parsed = parseEntryInput(payload, false);
    const taskId =
      typeof payload["task_id"] === "string" && payload["task_id"]
        ? (payload["task_id"] as string)
        : null;
    let workspaceId: string | null = null;
    if (taskId) {
      const task = await env.DB.prepare(
        "SELECT * FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
      )
        .bind(taskId)
        .first<{ workspace_id: string; tenant_id: string }>();
      if (!task || task.tenant_id !== row.tenant_id) {
        throw notFound("Task not found");
      }
      workspaceId = task.workspace_id;
    } else if (typeof payload["workspace_id"] === "string") {
      workspaceId = payload["workspace_id"] as string;
    }
    if (!workspaceId) {
      throw badRequest('Change request payload requires "workspace_id" or "task_id"');
    }
    await insertEntry(
      env,
      {
        tenantId: row.tenant_id,
        workspaceId,
        taskId,
        accountId: row.target_account_id,
        startedAt: parsed.startedAt as string,
        endedAt: parsed.endedAt ?? null,
        durationSeconds: parsed.durationSeconds ?? null,
        noteEnc: parsed.noteEnc ?? null,
      },
      source,
    );
    return;
  }
  if (!row.entry_id) throw badRequest('"entry_id" is required');
  const entry = await loadEntry(env, row.entry_id);
  if (row.type === "edit") {
    await applyEntryPatch(env, entry, parseEntryInput(payload, true), source);
  } else {
    await softDeleteEntry(env, entry, source);
  }
}

/** Direct proxy input: an admin records an entry for another member. */
export async function proxyCreateEntry(
  env: Env,
  principal: Principal,
  tenantId: string,
  payload: Record<string, unknown>,
) {
  const targetRaw = payload["account_id"];
  if (typeof targetRaw !== "string" || !targetRaw) {
    throw badRequest('"account_id" (the member to record for) is required');
  }
  const member = await env.DB.prepare(
    "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
  )
    .bind(tenantId, targetRaw)
    .first<{ account_id: string }>();
  if (!member) throw badRequest("Target account is not a tenant member");
  const parsed = parseEntryInput(payload, false);
  const taskId =
    typeof payload["task_id"] === "string" && payload["task_id"]
      ? (payload["task_id"] as string)
      : null;
  let workspaceId: string | null = null;
  if (taskId) {
    const task = await env.DB.prepare(
      "SELECT * FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
    )
      .bind(taskId)
      .first<{ workspace_id: string; tenant_id: string }>();
    if (!task || task.tenant_id !== tenantId) throw notFound("Task not found");
    workspaceId = task.workspace_id;
  } else if (typeof payload["workspace_id"] === "string") {
    workspaceId = payload["workspace_id"] as string;
  }
  if (!workspaceId) {
    throw badRequest('"workspace_id" or "task_id" is required');
  }
  const row = await insertEntry(
    env,
    {
      tenantId,
      workspaceId,
      taskId,
      accountId: targetRaw,
      startedAt: parsed.startedAt as string,
      endedAt: parsed.endedAt ?? null,
      durationSeconds: parsed.durationSeconds ?? null,
      noteEnc: parsed.noteEnc ?? null,
    },
    { accountId: principal.accountId, admin: true },
  );
  return publicEntry(row);
}
