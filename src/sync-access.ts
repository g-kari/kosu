/** Resolve synchronization authorization from stored ancestry, never client payloads. */
import { ApiError, forbidden, notFound } from "./errors";
import { guard, loadTenant, loadWorkspace, loadTeam } from "./hierarchy";
import type { Env, Principal, ProjectRow, TaskRow, TimeEntryRow } from "./types";

const TABLES: Record<string, string> = {
  task: "tasks", time_entry: "time_entries", task_dependency: "task_dependencies", milestone: "milestones",
};
export async function guardSyncEntity(
  env: Env, principal: Principal, tenantId: string, entityType: string,
  entityId: string, need: "read" | "write",
) {
  await loadTenant(env,tenantId);
  const table = TABLES[entityType];
  if (!table) throw notFound("Entity not found");
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?1`)
    .bind(entityId).first<Record<string, unknown>>();
  if (!row || row.tenant_id !== tenantId) throw notFound("Entity not found");
  let projectId = row.project_id as string | null;
  if (entityType === "time_entry" && row.task_id) {
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?1")
      .bind(row.task_id).first<TaskRow>();
    if (!task || task.tenant_id !== tenantId) throw notFound("Task not found");
    projectId = task.project_id;
  }
  let ref: {tenantId:string;workspaceId?:string;teamId?:string;projectId?:string};
  if (projectId) {
    const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?1")
      .bind(projectId).first<ProjectRow>();
    if (!project || project.tenant_id !== tenantId || project.deleted_at) throw notFound("Project not found");
    await loadWorkspace(env,tenantId,project.workspace_id);
    await loadTeam(env,project.workspace_id,project.team_id);
    ref = {tenantId, workspaceId:project.workspace_id, teamId:project.team_id, projectId};
  } else if (entityType === "time_entry" && row.workspace_id) {
    const workspace = await env.DB.prepare("SELECT * FROM workspaces WHERE id = ?1")
      .bind(row.workspace_id).first<{tenant_id:string;deleted_at:string|null}>();
    if (!workspace || workspace.tenant_id !== tenantId || workspace.deleted_at) throw notFound("Workspace not found");
    ref = {tenantId,workspaceId:row.workspace_id as string};
  } else throw notFound("Entity scope not found");
  const result = await guard(env,principal,ref,need);
  if (entityType === "time_entry" && need === "write" && row.account_id !== principal.accountId && !result.access.admin) {
    throw forbidden("Time entries can only be changed by their owner or administrator");
  }
  return result;
}
export async function canReadSyncEntity(env:Env, principal:Principal, tenantId:string, entityType:string, entityId:string):Promise<boolean> {
  try { await guardSyncEntity(env,principal,tenantId,entityType,entityId,"read"); return true; }
  catch (error) { if(error instanceof ApiError && (error.status===403 || error.status===404)) return false; throw error; }
}
