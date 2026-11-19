import {expect,it,vi} from 'vitest';
import {FakeDb,makeEnv} from './fake-db';
import {setupOwner,setupSecondUser,buildHierarchy,call} from './phase2-helpers';
import {createConnection,updateConnection,connectionToken,runConnectionSync} from '../src/integrations';
import {createShareLink,revokeShareLink,createIntakeForm,revokeIntakeForm,setIntakeFormEnabled} from '../src/public-links';
import {applyTimeImport} from '../src/importers';
import type {ProjectRow} from '../src/types';

it('binds saved TimeCrowd tokens to their origin and refuses redirect following',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),env=makeEnv(db);
 const {row}=await createConnection(env,{tenantId:h.tenantId,provider:'timecrowd',projectId:h.projectId,name:'test',config:{base_url:'https://timecrowd.net/api/v1'},token:'test-token',createdByAccountId:owner.accountId});
 const same=await updateConnection(env,row,{config:{base_url:'https://timecrowd.net:443/api/v2'}},owner.accountId);
 expect(await connectionToken(env,same)).toBe('test-token');
 const changed=await updateConnection(env,same,{config:{base_url:'https://untrusted.example/api'}},owner.accountId);
 expect(await connectionToken(env,changed)).toBeNull();
 const replacement=await updateConnection(env,changed,{token:'explicit-new-token'},owner.accountId);
 expect(await connectionToken(env,replacement)).toBe('explicit-new-token');
 const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{expect(init?.redirect).toBe('error');return new Response('[]',{status:200});});
 await runConnectionSync(env,row,db.tables.get("projects")![0] as unknown as ProjectRow,owner.accountId,"manual",fetcher);expect(fetcher).toHaveBeenCalledTimes(2);
});
it('binds public capability mutations to the authorized project',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),env=makeEnv(db);
 const {link}=await createShareLink(env,{tenantId:h.tenantId,projectId:h.projectId,createdBy:owner.accountId,label:null,expiresAt:null});
 const {form}=await createIntakeForm(env,{tenantId:h.tenantId,projectId:h.projectId,createdBy:owner.accountId,title:null});
 const otherResponse=await call(db,h.projectPath.slice(0,h.projectPath.lastIndexOf('/')),{method:'POST',cookie:owner.cookie,body:{name:'other'}});
 const {project:other}=await otherResponse.json() as {project:{id:string}};
 const otherPath=h.projectPath.slice(0,h.projectPath.lastIndexOf('/')+1)+other.id;
 expect((await call(db,`${otherPath}/share-links/${link.id}`,{method:'DELETE',cookie:owner.cookie})).status).toBe(404);
 expect((await call(db,`${otherPath}/intake-forms/${form.id}`,{method:'DELETE',cookie:owner.cookie})).status).toBe(404);
 expect((await call(db,`${otherPath}/intake-forms/${form.id}`,{method:'PATCH',cookie:owner.cookie,body:{enabled:false}})).status).toBe(404);
 expect((await call(db,`${h.projectPath}/intake-forms/${form.id}`,{method:'PATCH',cookie:owner.cookie,body:{enabled:false}})).status).toBe(200);
 expect((await call(db,`${h.projectPath}/share-links/${link.id}`,{method:'DELETE',cookie:owner.cookie})).status).toBe(200);

});
it('does not import submitted periods or leave orphan tasks for a non-admin editor',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),member=await setupSecondUser(db),env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
 db.tables.set('project_members',[{project_id:h.projectId,account_id:member.accountId,role:'editor'}]);
 db.tables.set('time_submissions',[{id:'sub',tenant_id:h.tenantId,account_id:member.accountId,status:'approved',period_start:'2026-01-01',period_end:'2026-01-31'}]);
 const project=db.tables.get('projects')![0] as unknown as ProjectRow;
 const row={taskTitle:'imported',startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:01:00Z',durationSeconds:60,sourceKey:'row-1'};
 const blocked=await applyTimeImport(env,project,'csv',[row],member.accountId);expect(blocked.created_entries).toBe(0);expect(blocked.created_tasks).toBe(0);expect(blocked.skipped_invalid).toBe(1);
 const allowed=await applyTimeImport(env,project,'csv',[{...row,startedAt:'2026-02-01T00:00:00Z',endedAt:'2026-02-01T00:01:00Z'}],member.accountId);expect(allowed.created_entries).toBe(1);
});
