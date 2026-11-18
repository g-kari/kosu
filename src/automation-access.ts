import {guard,loadTenant,loadWorkspace,loadTeam} from './hierarchy';
import {notFound} from './errors';
import type {Env,Principal,ProjectRow} from './types';

/** Tenant-wide rules require a tenant administrator; scoped rules use stored ancestry. */
export async function guardAutomationScope(env:Env,principal:Principal,tenantId:string,projectId:string|null,need:'read'|'admin') {
 await loadTenant(env,tenantId);
 if(!projectId)return guard(env,principal,{tenantId},'admin');
 const project=await env.DB.prepare('SELECT * FROM projects WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL').bind(projectId,tenantId).first<ProjectRow>();
 if(!project)throw notFound('Project not found');
 await loadWorkspace(env,tenantId,project.workspace_id);await loadTeam(env,project.workspace_id,project.team_id);
 return guard(env,principal,{tenantId,workspaceId:project.workspace_id,teamId:project.team_id,projectId},need);
}

/** Administrators may inspect/reassign/remove saved rules after their target disappears. */
export async function guardStoredAutomationScope(env:Env,principal:Principal,tenantId:string,projectId:string|null,need:'read'|'admin') {
 await loadTenant(env,tenantId);
 const tenant=await guard(env,principal,{tenantId},'read');
 if(tenant.access.admin)return tenant;
 return guardAutomationScope(env,principal,tenantId,projectId,need);
}
