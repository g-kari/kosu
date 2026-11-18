/**
 * Sync push/pull application logic and device registry.
 *
 * Push semantics (phase 2, see docs/DESIGN.md): each change carries the
 * `base_version` the client saw. If it matches the server's current
 * version the change is applied (version + 1) and appended to the change
 * log; otherwise the server copy wins, the change is rejected, and both
 * payloads are recorded in sync_conflicts for later review. New entities
 * are pushed with base_version 0.
 */
import { canReadSyncEntity, guardSyncEntity } from "./sync-access";
import { nowIso } from "./accounts";
import { tenantAdminIds } from "./approvals";
import { notifyConflictRecorded } from "./conflicts";
import { badRequest, forbidden, notFound, conflict } from "./errors";
import { guard, loadProject, loadWorkspace, loadTeam, loadTenant } from "./hierarchy";
import {
  isSyncEntityType,
  lastSeq,
  pullChanges,
  type SyncEntityType,
} from "./sync-core";
import {
  applyMilestonePatch,
  applyEntryPatch,
  applyTaskPatch,
  insertDependency,
  insertEntry,
  insertMilestone,
  insertTask,
  loadDependencyAny,
  loadEntryAny,
  loadMilestoneAny,
  loadTaskAny,
  parseEntryInput,
  parseMilestoneInput,
  parseTaskInput,
  publicDependency,
  publicEntry,
  publicMilestone,
  publicTask,
  softDeleteDependency,
  softDeleteEntry,
  softDeleteMilestone,
  softDeleteTask,
  type TaskInput,
} from "./tasks";
import { randomId, sha256Hex } from "./tokens";
import type {
  Env,
  MilestoneRow,
  Principal,
  ProjectRow,
  SyncDeviceRow,
  TaskDependencyRow,
  TaskRow,
  TimeEntryRow,
} from "./types";

/* ------------------------------------------------------------------ */
/* Devices                                                              */
/* ------------------------------------------------------------------ */

export function publicDevice(row: SyncDeviceRow) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
  };
}

export async function registerDevice(
  env: Env,
  accountId: string,
  name: string,
  platform: string | null,
): Promise<SyncDeviceRow> {
  const row: SyncDeviceRow = {
    id: randomId(),
    account_id: accountId,
    name,
    platform,
    created_at: nowIso(),
    last_seen_at: nowIso(),
    revoked_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO sync_devices (id, account_id, name, platform, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(row.id, accountId, name, platform, row.created_at, row.last_seen_at)
    .run();
  return row;
}

export async function listDevices(
  env: Env,
  accountId: string,
): Promise<SyncDeviceRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM sync_devices WHERE account_id = ?1 ORDER BY created_at ASC",
  )
    .bind(accountId)
    .all<SyncDeviceRow>();
  return res.results;
}

export async function revokeDevice(
  env: Env,
  accountId: string,
  deviceId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM sync_devices WHERE id = ?1 AND account_id = ?2",
  )
    .bind(deviceId, accountId)
    .first<SyncDeviceRow>();
  if (!row) throw notFound("Device not found");
  if (row.revoked_at) return;
  await env.DB.prepare(
    "UPDATE sync_devices SET revoked_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), deviceId)
    .run();
}

/** Validate a device for push/pull and stamp last_seen_at. */
export async function requireActiveDevice(
  env: Env,
  accountId: string,
  deviceId: string,
): Promise<SyncDeviceRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM sync_devices WHERE id = ?1 AND account_id = ?2",
  )
    .bind(deviceId, accountId)
    .first<SyncDeviceRow>();
  if (!row) throw notFound("Device not found");
  if (row.revoked_at) throw forbidden("This device has been revoked");
  await env.DB.prepare(
    "UPDATE sync_devices SET last_seen_at = ?1 WHERE id = ?2",
  )
    .bind(nowIso(), deviceId)
    .run();
  return row;
}

/* ------------------------------------------------------------------ */
/* Push                                                                 */
/* ------------------------------------------------------------------ */

export interface PushChange {
  entity_type: string;
  entity_id: string;
  op: string;
  base_version: number;
  payload?: Record<string, unknown> | null;
}

export interface PushResult {
  entity_type: string;
  entity_id: string;
  status: "applied" | "conflict";
  version?: number;
  server_version?: number;
  server_payload?: unknown;
}

function payloadOf(
  entityType: SyncEntityType,
  row: TaskRow | TimeEntryRow | TaskDependencyRow | MilestoneRow,
): unknown {
  switch (entityType) {
    case "task":
      return publicTask(row as TaskRow);
    case "time_entry":
      return publicEntry(row as TimeEntryRow);
    case "task_dependency":
      return publicDependency(row as TaskDependencyRow);
    case "milestone":
      return publicMilestone(row as MilestoneRow);
  }
}

async function loadEntityAny(
  env: Env,
  entityType: SyncEntityType,
  entityId: string,
): Promise<TaskRow | TimeEntryRow | TaskDependencyRow | MilestoneRow | null> {
  switch (entityType) {
    case "task":
      return loadTaskAny(env, entityId);
    case "time_entry":
      return loadEntryAny(env, entityId);
    case "task_dependency":
      return loadDependencyAny(env, entityId);
    case "milestone":
      return loadMilestoneAny(env, entityId);
  }
}

async function loadProjectById(
  env: Env,
  projectId: string,
): Promise<ProjectRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?1 AND deleted_at IS NULL",
  )
    .bind(projectId)
    .first<ProjectRow>();
  if (!row) throw notFound("Project not found");
  // Verify the full ancestry is alive and consistent.
  await loadTenant(env,row.tenant_id);
  await loadWorkspace(env,row.tenant_id,row.workspace_id);
  await loadTeam(env,row.workspace_id,row.team_id);
  await loadProject(env, row.team_id, projectId);
  return row;
}

async function guardProjectWrite(
  env: Env,
  principal: Principal,
  project: ProjectRow,
): Promise<void> {
  await guard(
    env,
    principal,
    {
      tenantId: project.tenant_id,
      workspaceId: project.workspace_id,
      teamId: project.team_id,
      projectId: project.id,
    },
    "write",
  );
}

function requirePayload(
  change: PushChange,
): Record<string, unknown> {
  if (
    !change.payload ||
    typeof change.payload !== "object" ||
    Array.isArray(change.payload)
  ) {
    throw badRequest("Sync upsert requires an object payload");
  }
  return change.payload;
}

async function applyCreate(
  env: Env,
  principal: Principal,
  tenantId: string,
  entityType: SyncEntityType,
  change: PushChange,
  deviceId: string,
): Promise<PushResult> {
  const payload = requirePayload(change);
  const source = { accountId: principal.accountId, deviceId };
  if (entityType === "task") {
    const projectId = payload["project_id"];
    if (typeof projectId !== "string") {
      throw badRequest('Task payload requires "project_id"');
    }
    const project = await loadProjectById(env, projectId);
    if (project.tenant_id !== tenantId) throw notFound("Project not found");
    await guardProjectWrite(env, principal, project);
    const parsed = parseTaskInput(payload, false);
    const input: TaskInput = {
      title: parsed.title as string,
      descriptionEnc: parsed.descriptionEnc ?? null,
      status: parsed.status ?? "todo",
      priority: parsed.priority ?? "medium",
      assigneeAccountId: parsed.assigneeAccountId ?? null,
      parentTaskId: parsed.parentTaskId ?? null,
      startDate: parsed.startDate ?? null,
      dueDate: parsed.dueDate ?? null,
      sortOrder: parsed.sortOrder ?? 0,
      estimateMinutes: parsed.estimateMinutes ?? null,
    };
    const row = await insertTask(env, project, input, source, change.entity_id);
    return {
      entity_type: entityType,
      entity_id: row.id,
      status: "applied",
      version: 1,
    };
  }
  if (entityType === "time_entry") {
    const taskId = payload["task_id"];
    let project: ProjectRow | null = null;
    if (typeof taskId === "string" && taskId) {
      const task = await loadTaskAny(env, taskId);
      if (!task || task.deleted_at || !task.project_id) {
        throw badRequest("Time entry payload references an unknown task");
      }
      project = await loadProjectById(env, task.project_id);
      if (project.tenant_id !== tenantId) throw notFound("Project not found");
      await guardProjectWrite(env, principal, project);
    } else {
      await guard(env, principal, { tenantId }, "write");
    }
    if (
      payload["account_id"] !== undefined &&
      payload["account_id"] !== principal.accountId
    ) {
      throw forbidden("Time entries can only be pushed for your own account");
    }
    const parsed = parseEntryInput(payload, false);
    let workspaceId = project?.workspace_id ?? null;
    if (!workspaceId) {
      const raw = payload["workspace_id"];
      if (typeof raw !== "string" || !raw) {
        throw badRequest(
          'Time entry payload requires "workspace_id" when it has no task',
        );
      }
      // Throws 404 unless the workspace belongs to this tenant.
      await loadWorkspace(env, tenantId, raw);
      await guard(env, principal, { tenantId, workspaceId: raw }, "write");
      workspaceId = raw;
    }
    const row = await insertEntry(
      env,
      {
        tenantId,
        workspaceId,
        taskId: typeof taskId === "string" && taskId ? taskId : null,
        accountId: principal.accountId,
        startedAt: parsed.startedAt as string,
        endedAt: parsed.endedAt ?? null,
        durationSeconds: parsed.durationSeconds ?? null,
        noteEnc: parsed.noteEnc ?? null,
      },
      source,
      change.entity_id,
    );
    return {
      entity_type: entityType,
      entity_id: row.id,
      status: "applied",
      version: 1,
    };
  }
  if (entityType === "task_dependency") {
    const projectId = payload["project_id"];
    if (typeof projectId !== "string") {
      throw badRequest('Dependency payload requires "project_id"');
    }
    const project = await loadProjectById(env, projectId);
    if (project.tenant_id !== tenantId) throw notFound("Project not found");
    await guardProjectWrite(env, principal, project);
    const taskId = payload["task_id"];
    const dependsOnId = payload["depends_on_task_id"];
    if (typeof taskId !== "string" || typeof dependsOnId !== "string") {
      throw badRequest(
        'Dependency payload requires "task_id" and "depends_on_task_id"',
      );
    }
    const row = await insertDependency(
      env,
      project,
      taskId,
      dependsOnId,
      source,
      change.entity_id,
    );
    return {
      entity_type: entityType,
      entity_id: row.id,
      status: "applied",
      version: 1,
    };
  }
  // milestone
  const projectId = payload["project_id"];
  if (typeof projectId !== "string") {
    throw badRequest('Milestone payload requires "project_id"');
  }
  const project = await loadProjectById(env, projectId);
  if (project.tenant_id !== tenantId) throw notFound("Project not found");
  await guardProjectWrite(env, principal, project);
  const parsed = parseMilestoneInput(payload, false);
  const row = await insertMilestone(
    env,
    project,
    { name: parsed.name as string, date: parsed.date as string },
    source,
    change.entity_id,
  );
  return {
    entity_type: entityType,
    entity_id: row.id,
    status: "applied",
    version: 1,
  };
}

async function applyUpdateOrDelete(
  env: Env,
  principal: Principal,
  tenantId: string,
  entityType: SyncEntityType,
  change: PushChange,
  existing: TaskRow | TimeEntryRow | TaskDependencyRow | MilestoneRow,
  deviceId: string,
): Promise<PushResult> {
  const source = { accountId: principal.accountId, deviceId };
  // Time entries are personal records: only their owner may sync changes.
  if (
    entityType === "time_entry" &&
    (existing as TimeEntryRow).account_id !== principal.accountId
  ) {
    throw forbidden("Time entries can only be changed by their owner");
  }
  // Authorize against the entity's own project before touching anything.
  const projectId =
    entityType === "task"
      ? (existing as TaskRow).project_id
      : entityType === "time_entry"
        ? await projectIdOfEntry(env, existing as TimeEntryRow)
        : (existing as TaskDependencyRow | MilestoneRow).project_id;
  if (projectId) {
    const project = await loadProjectById(env, projectId);
    if (project.tenant_id !== tenantId) throw notFound("Project not found");
    await guardProjectWrite(env, principal, project);
  } else {
    await guard(env, principal, { tenantId }, "write");
  }

  let next: TaskRow | TimeEntryRow | TaskDependencyRow | MilestoneRow;
  if (change.op === "delete") {
    if (entityType === "task") {
      next = await softDeleteTask(env, existing as TaskRow, source);
    } else if (entityType === "time_entry") {
      next = await softDeleteEntry(env, existing as TimeEntryRow, source);
    } else if (entityType === "task_dependency") {
      next = await softDeleteDependency(
        env,
        existing as TaskDependencyRow,
        source,
      );
    } else {
      next = await softDeleteMilestone(env, existing as MilestoneRow, source);
    }
  } else if (entityType === "task") {
    const parsed = parseTaskInput(requirePayload(change), true);
    next = await applyTaskPatch(env, existing as TaskRow, parsed, source);
  } else if (entityType === "time_entry") {
    const parsed = parseEntryInput(requirePayload(change), true);
    next = await applyEntryPatch(env, existing as TimeEntryRow, parsed, source);
  } else if (entityType === "milestone") {
    const parsed = parseMilestoneInput(requirePayload(change), true);
    next = await applyMilestonePatch(
      env,
      existing as MilestoneRow,
      parsed,
      source,
    );
  } else {
    throw badRequest("Dependencies cannot be edited; delete and recreate");
  }
  return {
    entity_type: entityType,
    entity_id: next.id,
    status: "applied",
    version: Number(next.version),
  };
}

async function projectIdOfEntry(
  env: Env,
  entry: TimeEntryRow,
): Promise<string | null> {
  if (!entry.task_id) return null;
  const task = await loadTaskAny(env, entry.task_id);
  return task?.project_id ?? null;
}

export async function applyPush(
  env: Env,
  principal: Principal,
  tenantId: string,
  deviceId: string,
  changes: PushChange[],
): Promise<{ results: PushResult[]; lastSeq: number }> {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw badRequest('"changes" must be a non-empty array');
  }
  if (changes.length > 200) throw badRequest("Too many changes in one push");
  const results: PushResult[] = [];
  for (const change of changes) {
    if (!isSyncEntityType(change.entity_type)) {
      throw badRequest(`Unknown entity_type "${change.entity_type}"`);
    }
    if (change.op !== "upsert" && change.op !== "delete") {
      throw badRequest(`Unknown sync op "${change.op}"`);
    }
    if (
      typeof change.entity_id !== "string" ||
      change.entity_id.length === 0 ||
      change.entity_id.length > 200
    ) {
      throw badRequest("Sync change requires an entity_id");
    }
    if (
      typeof change.base_version !== "number" ||
      !Number.isInteger(change.base_version) ||
      change.base_version < 0
    ) {
      throw badRequest("Sync change requires an integer base_version >= 0");
    }
    const entityType = change.entity_type;
    const existing = await loadEntityAny(env, entityType, change.entity_id);
    if (!existing) {
      if (change.op === "delete") {
        // Deleting something the server never saw is a no-op success.
        results.push({
          entity_type: entityType,
          entity_id: change.entity_id,
          status: "applied",
          version: 0,
        });
        continue;
      }
      if (change.base_version !== 0) {
        throw badRequest(
          "New entities must be pushed with base_version 0",
        );
      }
      results.push(
        await applyCreate(env, principal, tenantId, entityType, change, deviceId),
      );
      continue;
    }
    if (existing.tenant_id !== tenantId) throw notFound("Entity not found");
    await guardSyncEntity(env, principal, tenantId, entityType, change.entity_id, "write");
    if (entityType === "time_entry" && (existing as TimeEntryRow).account_id !== principal.accountId) throw forbidden("Time entries can only be changed by their owner");
    const serverVersion = Number(existing.version);
    if (change.base_version !== serverVersion) {
      // Server wins. Record both sides for the phase-3 resolution UI.
      const serverPayload = payloadOf(entityType, existing);
      const conflictId = randomId();
      await env.DB.prepare(
        "INSERT INTO sync_conflicts (id, tenant_id, entity_type, entity_id, server_version, client_base_version, server_payload, client_payload, account_id, device_id, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open', ?11)",
      )
        .bind(
          conflictId,
          tenantId,
          entityType,
          change.entity_id,
          serverVersion,
          change.base_version,
          JSON.stringify(serverPayload),
          change.payload ? JSON.stringify(change.payload) : null,
          principal.accountId,
          deviceId,
          nowIso(),
        )
        .run();
      // Tell the tenant admins a conflict awaits resolution. A
      // notification failure must never break the push itself.
      try {
        const admins = await tenantAdminIds(env, tenantId);
        await notifyConflictRecorded(
          env,
          tenantId,
          {
            id: conflictId,
            entity_type: entityType,
            entity_id: change.entity_id,
          },
          admins,
        );
      } catch (err) {
        console.error("conflict notification failed", err);
      }
      results.push({
        entity_type: entityType,
        entity_id: change.entity_id,
        status: "conflict",
        server_version: serverVersion,
        server_payload: serverPayload,
      });
      continue;
    }
    results.push(
      await applyUpdateOrDelete(
        env,
        principal,
        tenantId,
        entityType,
        change,
        existing,
        deviceId,
      ),
    );
  }
  return { results, lastSeq: await lastSeq(env, tenantId) };
}

/** Authorization epoch includes memberships, live ancestry, and purged entity identities.
 * Only its digest is returned; a change invalidates incremental client mirrors. */
export async function syncScopeToken(env: Env, principal: Principal, tenantId: string) {
  const state: unknown[] = [principal.accountId, tenantId];
  for (const table of ["tenant_members", "workspace_members", "team_members", "project_members"]) {
    const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE account_id = ?1`).bind(principal.accountId).all<Record<string,unknown>>();
    state.push(rows.results.map(r=>JSON.stringify(r)).sort());
  }
  for (const table of ["tenants", "workspaces", "teams", "projects"]) {
    const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${table === "tenants" ? "id" : "tenant_id"} = ?1`).bind(tenantId).all<Record<string,unknown>>();
    state.push(rows.results.map(r=>JSON.stringify([r.id,r.workspace_id,r.team_id,r.project_id,r.task_id,r.deleted_at])).sort());
  }
  const deletions = await env.DB.prepare("SELECT seq FROM sync_changes WHERE tenant_id = ?1 AND op = ?2 ORDER BY seq DESC LIMIT 1").bind(tenantId,"delete").all<{seq:number}>();
  state.push(deletions.results);
  const epoch=await env.DB.prepare("SELECT revision FROM sync_access_epochs WHERE tenant_id = ?1").bind(tenantId).first<{revision:number}>();
  state.push(epoch?.revision ?? 0);
  return sha256Hex(JSON.stringify(state));
}

export async function syncPull(
  env: Env,
  principal: Principal,
  tenantId: string,
  sinceSeq: number,
  limit: number,
  scopeToken?: string,
) {
  const scope = await syncScopeToken(env, principal, tenantId);
  if (scopeToken !== undefined && scopeToken !== scope) return {changes: [], next_since: 0, last_seq: await lastSeq(env,tenantId), has_more: true, reset: true, scope_token: scope};
  const { changes, lastSeq: current, hasMore } = await pullChanges(
    env,
    tenantId,
    sinceSeq,
    limit,
  );
  const visible = [];
  for (const row of changes) {
    if (await canReadSyncEntity(env, principal, tenantId, row.entity_type, row.entity_id)) visible.push(row);
  }
  const mapped = visible.map((row) => ({
    seq: Number(row.seq),
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    op: row.op,
    payload: row.payload ? JSON.parse(row.payload) : null,
    account_id: row.account_id,
    device_id: row.device_id,
    created_at: row.created_at,
  }));
  if (scope !== await syncScopeToken(env,principal,tenantId)) throw conflict("SYNC_SCOPE_CHANGED", "Access changed during synchronization; retry without applying this page");
  const last = changes[changes.length - 1];
  return {
    changes: mapped,
    reset: false,
    scope_token: scope,
    // Advance over inspected changes even when this page is entirely filtered.
    // (last_seq alone is the tenant-wide head and would skip pages.)
    next_since: last ? Number(last.seq) : sinceSeq,
    last_seq: current,
    has_more: hasMore,
  };
}

export async function syncStatus(
  env: Env,
  principal: Principal,
  tenantId: string,
) {
  const conflicts = await env.DB.prepare(
    "SELECT id FROM sync_conflicts WHERE tenant_id = ?1 AND status = ?2",
  )
    .bind(tenantId, "open")
    .all<{ id: string }>();
  const devices = await listDevices(env, principal.accountId);
  return {
    tenant_id: tenantId,
    last_seq: await lastSeq(env, tenantId),
    open_conflicts: conflicts.results.length,
    devices: devices.filter((d) => !d.revoked_at).map(publicDevice),
    server_time: nowIso(),
  };
}

export async function listConflicts(env: Env, tenantId: string) {
  const res = await env.DB.prepare(
    "SELECT * FROM sync_conflicts WHERE tenant_id = ?1 AND status = ?2 ORDER BY created_at ASC",
  )
    .bind(tenantId, "open")
    .all<{
      id: string;
      entity_type: string;
      entity_id: string;
      server_version: number;
      client_base_version: number;
      server_payload: string | null;
      client_payload: string | null;
      account_id: string | null;
      device_id: string | null;
      created_at: string;
    }>();
  return res.results.map((row) => ({
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    server_version: Number(row.server_version),
    client_base_version: Number(row.client_base_version),
    server_payload: row.server_payload ? JSON.parse(row.server_payload) : null,
    client_payload: row.client_payload ? JSON.parse(row.client_payload) : null,
    account_id: row.account_id,
    device_id: row.device_id,
    created_at: row.created_at,
  }));
}

