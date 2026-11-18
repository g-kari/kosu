import { expect, it } from "vitest";
import { FakeDb, makeEnv } from "./fake-db";
import { buildHierarchy, call, setupOwner, setupSecondUser } from "./phase2-helpers";
import { applyPush, syncPull } from "../src/sync";
import { resolveConflict } from "../src/conflicts";
import type { Principal, SyncConflictRow } from "../src/types";

it("hides inaccessible sync records while advancing cursors and preserves owner access", async () => {
 const db=new FakeDb(), owner=await setupOwner(db), h=await buildHierarchy(db,owner.cookie), second=await setupSecondUser(db), env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:second.accountId,role:'member'});
 await call(db,`${h.projectPath}/tasks`,{method:'POST',cookie:owner.cookie,body:{title:'private'}});
 const p:Principal={kind:'session',accountId:second.accountId};
 const denied=await syncPull(env,p,h.tenantId,0,1);
 expect(denied.changes).toEqual([]);expect(denied.next_since).toBeGreaterThan(0);
 const allowed=await syncPull(env,{kind:'session',accountId:owner.accountId},h.tenantId,0,1);
 expect(allowed.changes).toHaveLength(1);
});
it("checks stale pushes before recording or returning private server payloads", async () => {
 const db=new FakeDb(), owner=await setupOwner(db), h=await buildHierarchy(db,owner.cookie), second=await setupSecondUser(db), env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:second.accountId,role:'member'});
 const res=await call(db,`${h.projectPath}/tasks`,{method:'POST',cookie:owner.cookie,body:{title:'private'}}); const {task}=await res.json() as {task:{id:string}};
 await expect(applyPush(env,{kind:'session',accountId:second.accountId},h.tenantId,'device',[{entity_type:'task',entity_id:task.id,op:'upsert',base_version:0,payload:{title:'attack'}}])).rejects.toMatchObject({status:404});
 expect(db.tables.get('sync_conflicts')??[]).toHaveLength(0);
});
it("blocks legacy conflict payloads after current project access was revoked", async () => {
 const db=new FakeDb(), owner=await setupOwner(db), h=await buildHierarchy(db,owner.cookie), second=await setupSecondUser(db), env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:second.accountId,role:'member'});
 const res=await call(db,`${h.projectPath}/tasks`,{method:'POST',cookie:owner.cookie,body:{title:'private'}}); const {task}=await res.json() as {task:{id:string}};
 const row={id:'conflict',tenant_id:h.tenantId,entity_type:'task',entity_id:task.id,account_id:second.accountId,status:'open',client_payload:'{"title":"attack"}'} as SyncConflictRow;
 db.tables.set('sync_conflicts',[{...row}]);
 for(const choice of ['server','client'] as const) await expect(resolveConflict(env,{kind:'session',accountId:second.accountId},row,choice)).rejects.toMatchObject({status:404});
 expect(db.tables.get('tasks')![0]!.title).toBe('private'); expect(db.tables.get('sync_conflicts')![0]!.status).toBe('open');
 for(const suffix of ['', '/conflict']) {
   const response=await call(db,`${h.tenantPath}/sync-conflicts${suffix}`,{cookie:second.cookie});
   expect(await response.text()).not.toContain('attack');
 }
});
it("requires workspace access for unattached entries", async () => {
 const db=new FakeDb(), owner=await setupOwner(db), h=await buildHierarchy(db,owner.cookie), second=await setupSecondUser(db), env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:second.accountId,role:'member'});
 const change={entity_type:'time_entry',entity_id:'new-entry',op:'upsert',base_version:0,payload:{workspace_id:h.workspaceId,started_at:'2026-01-01T00:00:00Z',ended_at:'2026-01-01T00:01:00Z'}};
 await expect(applyPush(env,{kind:'session',accountId:second.accountId},h.tenantId,'device',[change])).rejects.toMatchObject({status:404});
 db.tables.set('workspace_members',[{workspace_id:h.workspaceId,account_id:second.accountId,role:'member'}]);
 const result=await applyPush(env,{kind:'session',accountId:second.accountId},h.tenantId,'device',[change]);expect(result.results[0]!.status).toBe('applied');
 db.tables.set('workspace_members',[]);
 await expect(applyPush(env,{kind:'session',accountId:second.accountId},h.tenantId,'device',[{...change,base_version:1,op:'delete'}])).rejects.toMatchObject({status:404});
});
it("invalidates the sync epoch after purge, grant, revoke and deleted ancestry",async()=>{
 const db=new FakeDb(), owner=await setupOwner(db), h=await buildHierarchy(db,owner.cookie), second=await setupSecondUser(db),env=makeEnv(db);
 const p:Principal={kind:'session',accountId:second.accountId};
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:second.accountId,role:'member'});
 const {task}=await (await call(db,`${h.projectPath}/tasks`,{method:'POST',cookie:owner.cookie,body:{title:'private'}})).json() as {task:{id:string}};
 let page=await syncPull(env,p,h.tenantId,0,100,'');expect(page.reset).toBe(true);
 page=await syncPull(env,p,h.tenantId,0,100,page.scope_token);expect(page.changes).toHaveLength(0);
 const old=page.scope_token;
 db.tables.set('project_members',[{project_id:h.projectId,account_id:second.accountId,role:'editor'}]);
 page=await syncPull(env,p,h.tenantId,page.next_since,100,old);expect(page.reset).toBe(true);
 page=await syncPull(env,p,h.tenantId,0,100,page.scope_token);expect(page.changes).toHaveLength(1);
 db.tables.get('workspaces')![0]!.deleted_at=new Date().toISOString();
 const reset=await syncPull(env,p,h.tenantId,page.next_since,100,page.scope_token);expect(reset.reset).toBe(true);
 const hidden=await syncPull(env,p,h.tenantId,0,100,reset.scope_token);expect(hidden.changes).toHaveLength(0);
 await expect(applyPush(env,p,h.tenantId,'device',[{entity_type:'task',entity_id:task.id,op:'upsert',base_version:1,payload:{title:'no'}}])).rejects.toMatchObject({status:404});
 db.tables.get('workspaces')![0]!.deleted_at=null;
 const before=await syncPull(env,p,h.tenantId,0,100,'');
 db.tables.set('tasks',[]);db.tables.get('sync_changes')!.push({seq:2,tenant_id:h.tenantId,entity_type:'task',entity_id:task.id,op:'delete',payload:null});
 expect((await syncPull(env,p,h.tenantId,1,100,before.scope_token)).reset).toBe(true);
});
