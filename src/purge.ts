/**
 * Account deletion and tenant dissolution (phase 5 item 18).
 *
 * Deleting an account physically removes the account row and every
 * trace that belongs to the person (keys, sessions, devices,
 * notifications, preferences, login history, memberships, own time
 * submissions metadata). Tenant business data survives: rows the
 * account created inside tenants that live on are handed to a
 * successor — for tenants the account owned, the successor is either
 * chosen by the account (transfer) or the tenant is dissolved
 * (everything in it is physically deleted, including R2 objects).
 *
 * The handover rules (also shown on the deletion preview):
 *  - owned tenant + successor named / another owner exists
 *      -> ownership transfers; created_by references move to the
 *         successor; the account's assignee slots become empty.
 *  - owned tenant + dissolve chosen
 *      -> the tenant and all of its data are physically deleted.
 *  - owned tenant + neither
 *      -> deletion is refused until the account decides.
 * Nullable "by" references are set to NULL; the person's own rows in
 * personal tables are deleted outright.
 */

import { ApiError, badRequest, notFound } from "./errors";
import { nowIso } from "./accounts";
import { tenantMemberIds } from "./members";
import type { Env } from "./types";

/** Tables whose rows belong to the tenant: deleted with the tenant. */
const TENANT_SCOPED_TABLES = [
  "automation_runs",
  "automation_rules",
  "report_runs",
  "report_definitions",
  "project_templates",
  "public_share_links",
  "intake_submissions",
  "intake_forms",
  "escalation_settings",
  "tenant_limits",
  "integration_sync_runs",
  "integration_connections",
  "external_items",
  "mail_inbound_tokens",
  "ical_feeds",
  "sample_projects",
  "saved_filters",
  "recent_views",
  "sync_conflicts",
  "sync_changes",
  "sync_counters",
  "notification_prefs",
  "notifications",
  "webhook_deliveries",
  "webhook_endpoints",
  "entry_change_requests",
  "time_submissions",
  "period_locks",
  "member_rates",
  "leave_records",
  "invites",
  "tenant_calendar_days",
  "tenant_settings",
  "api_keys",
  "audit_log",
  "github_sync",
  "linear_sync",
];

/** Task/project-scoped tables inside a tenant (deleted by tenant_id). */
const CONTENT_TABLES = [
  "task_labels",
  "task_custom_values",
  "task_watchers",
  "task_comments",
  "task_history",
  "attachments",
  "recurrence_rules",
  "links",
  "task_dependencies",
  "milestones",
  "time_entries",
  "tasks",
  "task_templates",
  "custom_field_defs",
  "status_defs",
  "priority_defs",
  "labels",
  "project_budgets",
];

/** Personal tables: rows keyed by the account are deleted outright. */
const PERSONAL_TABLES_BY_ACCOUNT = [
  "account_keys",
  "session_epochs",
  "user_prefs",
  "login_events",
  "sample_projects",
  "sync_devices",
  "notifications",
  "notification_prefs",
  "recent_views",
  "saved_filters",
  "member_rates",
  "leave_records",
  "task_watchers",
  "ical_feeds",
  "api_keys",
];

/** NOT NULL account references handed to the successor. */
const REASSIGN_COLUMNS: [string, string][] = [
  ["tenants", "created_by_account_id"],
  ["workspaces", "created_by_account_id"],
  ["teams", "created_by_account_id"],
  ["projects", "created_by_account_id"],
  ["attachments", "account_id"],
  ["task_comments", "account_id"],
  ["time_entries", "account_id"],
  ["time_submissions", "account_id"],
  ["automation_rules", "created_by_account_id"],
  ["custom_field_defs", "created_by_account_id"],
  ["entry_change_requests", "target_account_id"],
  ["entry_change_requests", "requester_account_id"],
  ["intake_forms", "created_by_account_id"],
  ["integration_connections", "created_by_account_id"],
  ["invites", "created_by_account_id"],
  ["labels", "created_by_account_id"],
  ["leave_records", "created_by_account_id"],
  ["mail_inbound_tokens", "created_by_account_id"],
  ["period_locks", "locked_by_account_id"],
  ["project_templates", "created_by_account_id"],
  ["public_share_links", "created_by_account_id"],
  ["recurrence_rules", "created_by_account_id"],
  ["report_definitions", "created_by_account_id"],
  ["task_templates", "created_by_account_id"],
  ["webhook_endpoints", "created_by_account_id"],
];

/** Nullable account references cleared to NULL. */
const NULLABLE_COLUMNS: [string, string][] = [
  ["tasks", "assignee_account_id"],
  ["audit_log", "account_id"],
  ["task_history", "account_id"],
  ["entry_change_requests", "decided_by_account_id"],
  ["integration_sync_runs", "created_by_account_id"],
  ["invites", "accepted_by_account_id"],
  ["links", "created_by_account_id"],
  ["member_rates", "updated_by_account_id"],
  ["project_budgets", "updated_by_account_id"],
  ["task_custom_values", "updated_by_account_id"],
  ["time_submissions", "reviewed_by_account_id"],
  ["webhook_deliveries", "recipient_account_id"],
  ["webhook_deliveries", "created_by_account_id"],
];

async function deleteWhere(
  env: Env,
  table: string,
  column: string,
  value: string,
): Promise<void> {
  await env.DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?1`)
    .bind(value)
    .run();
}

async function idsWhere(
  env: Env,
  table: string,
  column: string,
  value: string,
): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM ${table} WHERE ${column} = ?1`,
  )
    .bind(value)
    .all<{ id: string }>();
  return (results ?? []).map((r) => r.id);
}

/** Physically delete a tenant and everything inside it. */
export async function purgeTenant(env: Env, tenantId: string): Promise<void> {
  // R2 objects first: rows are about to disappear.
  const { results: attachmentRows } = await env.DB.prepare(
    "SELECT r2_key FROM attachments WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .all<{ r2_key: string }>();
  for (const row of attachmentRows ?? []) {
    await env.FILES.delete(row.r2_key);
  }
  // links has no tenant_id; it hangs off tasks.
  const taskIds = await idsWhere(env, "tasks", "tenant_id", tenantId);
  for (const taskId of taskIds) {
    await deleteWhere(env, "links", "task_id", taskId);
  }
  for (const table of CONTENT_TABLES) {
    if (table === "links") continue;
    await deleteWhere(env, table, "tenant_id", tenantId);
  }
  for (const table of TENANT_SCOPED_TABLES) {
    await deleteWhere(env, table, "tenant_id", tenantId);
  }
  const workspaceIds = await idsWhere(env, "workspaces", "tenant_id", tenantId);
  for (const wsId of workspaceIds) {
    await deleteWhere(env, "workspace_members", "workspace_id", wsId);
    await deleteWhere(env, "workspace_settings", "workspace_id", wsId);
  }
  const teamIds = await idsWhere(env, "teams", "tenant_id", tenantId);
  for (const teamId of teamIds) {
    await deleteWhere(env, "team_members", "team_id", teamId);
  }
  const projectIds = await idsWhere(env, "projects", "tenant_id", tenantId);
  for (const projectId of projectIds) {
    await deleteWhere(env, "project_members", "project_id", projectId);
  }
  await deleteWhere(env, "projects", "tenant_id", tenantId);
  await deleteWhere(env, "teams", "tenant_id", tenantId);
  await deleteWhere(env, "workspaces", "tenant_id", tenantId);
  await deleteWhere(env, "tenant_members", "tenant_id", tenantId);
  await deleteWhere(env, "tenants", "id", tenantId);
}

export interface OwnedTenant {
  tenant_id: string;
  tenant_name: string;
  member_count: number;
  other_owners: string[];
}

export interface DeletionPreview {
  account_id: string;
  email: string | null;
  owned_tenants: OwnedTenant[];
  member_tenant_ids: string[];
}

export async function previewAccountDeletion(
  env: Env,
  accountId: string,
): Promise<DeletionPreview> {
  const account = await env.DB.prepare(
    "SELECT id, email FROM accounts WHERE id = ?1",
  )
    .bind(accountId)
    .first<{ id: string; email: string | null }>();
  if (!account) throw notFound("Account not found");
  const { results: ownerRows } = await env.DB.prepare(
    "SELECT tenant_id FROM tenant_members WHERE account_id = ?1 AND role = ?2",
  )
    .bind(accountId, "owner")
    .all<{ tenant_id: string }>();
  const { results: memberRows } = await env.DB.prepare(
    "SELECT tenant_id FROM tenant_members WHERE account_id = ?1",
  )
    .bind(accountId)
    .all<{ tenant_id: string }>();
  const memberTenantIds = (memberRows ?? []).map((r) => r.tenant_id);
  const owned: OwnedTenant[] = [];
  for (const row of ownerRows ?? []) {
    const tenant = await env.DB.prepare(
      "SELECT id, name FROM tenants WHERE id = ?1 AND deleted_at IS NULL",
    )
      .bind(row.tenant_id)
      .first<{ id: string; name: string }>();
    if (!tenant) continue;
    const members = await tenantMemberIds(env, tenant.id);
    const { results: otherOwnerRows } = await env.DB.prepare(
      "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND role = ?2",
    )
      .bind(tenant.id, "owner")
      .all<{ account_id: string }>();
    owned.push({
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      member_count: members.length,
      other_owners: (otherOwnerRows ?? [])
        .map((r) => r.account_id)
        .filter((id) => id !== accountId),
    });
  }
  return {
    account_id: accountId,
    email: account.email,
    owned_tenants: owned,
    member_tenant_ids: memberTenantIds,
  };
}

export interface DeletionPlan {
  dissolveTenantIds: string[];
  /** tenant_id -> successor account id for ownership transfer. */
  successors: Record<string, string>;
}

/** Physically delete the account. Throws when an owned tenant has no
 *  resolution (no successor, not dissolved, no other owner). */
export async function purgeAccount(
  env: Env,
  accountId: string,
  plan: DeletionPlan,
): Promise<{ dissolved: string[]; transferred: string[] }> {
  const preview = await previewAccountDeletion(env, accountId);
  const dissolved: string[] = [];
  const transferred: string[] = [];
  const successorByTenant = new Map<string, string>();

  // Validate the complete ownership plan before ANY destructive mutation.
  for (const owned of preview.owned_tenants) {
    if (plan.dissolveTenantIds.includes(owned.tenant_id)) continue;
    const successor = plan.successors[owned.tenant_id] ?? owned.other_owners[0];
    if (!successor || successor === accountId) {
      throw badRequest(`Tenant ${owned.tenant_id} requires an explicit successor or dissolution`);
    }
    const existing = await env.DB.prepare(
      "SELECT role FROM tenant_members WHERE tenant_id = ?1 AND account_id = ?2",
    ).bind(owned.tenant_id, successor).first<{role:string}>();
    if (!existing) throw badRequest(`Successor for tenant ${owned.tenant_id} must be a direct tenant member`);
    successorByTenant.set(owned.tenant_id, successor);
  }
  for (const owned of preview.owned_tenants) {
    if (plan.dissolveTenantIds.includes(owned.tenant_id)) {
      await purgeTenant(env, owned.tenant_id);
      dissolved.push(owned.tenant_id);
    } else {
      const successor = successorByTenant.get(owned.tenant_id)!;
      await env.DB.prepare(
        "UPDATE tenant_members SET role = ?1 WHERE tenant_id = ?2 AND account_id = ?3",
      ).bind("owner", owned.tenant_id, successor).run();
      transferred.push(owned.tenant_id);
    }
  }

  // Successors for tenants the account merely belongs to: their owner.
  const survivingTenantIds = (
    await env.DB.prepare("SELECT id FROM tenants WHERE deleted_at IS NULL")
      .all<{ id: string }>()
  ).results ?? [];
  for (const t of survivingTenantIds) {
    if (successorByTenant.has(t.id)) continue;
    const { results: owners } = await env.DB.prepare(
      "SELECT account_id FROM tenant_members WHERE tenant_id = ?1 AND role = ?2",
    )
      .bind(t.id, "owner")
      .all<{ account_id: string }>();
    const owner = (owners ?? []).find((o) => o.account_id !== accountId);
    if (owner) successorByTenant.set(t.id, owner.account_id);
  }

  // Personal data out first.
  for (const table of PERSONAL_TABLES_BY_ACCOUNT) {
    await deleteWhere(env, table, "account_id", accountId);
  }
  await deleteWhere(env, "tenant_members", "account_id", accountId);
  const workspaceIds = (
    await env.DB.prepare("SELECT id FROM workspaces").all<{ id: string }>()
  ).results ?? [];
  for (const ws of workspaceIds) {
    await env.DB.prepare(
      "DELETE FROM workspace_members WHERE workspace_id = ?1 AND account_id = ?2",
    )
      .bind(ws.id, accountId)
      .run();
  }
  const teamIdsAll = (
    await env.DB.prepare("SELECT id FROM teams").all<{ id: string }>()
  ).results ?? [];
  for (const t of teamIdsAll) {
    await env.DB.prepare(
      "DELETE FROM team_members WHERE team_id = ?1 AND account_id = ?2",
    )
      .bind(t.id, accountId)
      .run();
  }
  const projectIdsAll = (
    await env.DB.prepare("SELECT id FROM projects").all<{ id: string }>()
  ).results ?? [];
  for (const p of projectIdsAll) {
    await env.DB.prepare(
      "DELETE FROM project_members WHERE project_id = ?1 AND account_id = ?2",
    )
      .bind(p.id, accountId)
      .run();
  }

  // Hand business references to each tenant's successor.
  for (const [table, column] of REASSIGN_COLUMNS) {
    for (const [tenantId, successor] of successorByTenant) {
      if (table === "tenants") {
        await env.DB.prepare(
          `UPDATE tenants SET ${column} = ?1 WHERE id = ?2 AND ${column} = ?3`,
        )
          .bind(successor, tenantId, accountId)
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE ${table} SET ${column} = ?1 WHERE tenant_id = ?2 AND ${column} = ?3`,
        )
          .bind(successor, tenantId, accountId)
          .run();
      }
    }
  }
  for (const [table, column] of NULLABLE_COLUMNS) {
    await env.DB.prepare(
      `UPDATE ${table} SET ${column} = ?1 WHERE ${column} = ?2`,
    )
      .bind(null, accountId)
      .run();
  }

  // Fail closed: no NOT NULL reference may remain.
  for (const [table, column] of REASSIGN_COLUMNS) {
    const row = await env.DB.prepare(
      `SELECT ${column} FROM ${table} WHERE ${column} = ?1`,
    )
      .bind(accountId)
      .first<Record<string, unknown>>();
    if (row) {
      throw new ApiError(
        500,
        "purge_incomplete",
        `Reference remains in ${table}.${column}; account was not deleted`,
      );
    }
  }

  await deleteWhere(env, "accounts", "id", accountId);
  return { dissolved, transferred };
}

