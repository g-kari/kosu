import {expect,it} from 'vitest';
import {FakeDb,makeEnv} from './fake-db';
import {setupOwner,setupSecondUser,buildHierarchy,call} from './phase2-helpers';
import {insertDefinition,runDefinition,runDueReports} from '../src/report-builder';

it('restricts persisted reports and snapshots to tenant administrators',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),member=await setupSecondUser(db),env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
 const definition={group_by:'project' as const,range:{kind:'this_month' as const}};
 const row=await insertDefinition(env,{tenantId:h.tenantId,name:'private',definition,schedule:'daily',createdBy:owner.accountId});
 for(const [suffix,method] of [['','GET'],['/'+row.id+'/runs','GET'],['/'+row.id+'/run','POST'],['','POST'],['/'+row.id,'PATCH'],['/'+row.id,'DELETE']]){
  expect((await call(db,h.tenantPath+'/report-definitions'+suffix,{method,cookie:member.cookie,body:method==='POST'||method==='PATCH'?{name:'x',definition}:undefined})).status).toBe(403);
 }
 db.tables.get('tenant_members')!.find(x=>x.account_id===owner.accountId&&x.tenant_id===h.tenantId)!.role='member';
 await expect(runDefinition(env,row)).rejects.toMatchObject({status:403});
});
it('bounds saved definitions and snapshots, preserving existing definitions on edits',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),env=makeEnv(db);
 const args={tenantId:h.tenantId,name:'report',definition:{group_by:'project' as const,range:{kind:'this_month' as const}},schedule:'off',createdBy:owner.accountId};
 const row=await insertDefinition(env,args);
 const rows=db.tables.get('report_definitions')!;for(let i=1;i<100;i++)rows.push({...row,id:'def-'+i});
 await expect(insertDefinition(env,args)).rejects.toMatchObject({status:400});
 const updated=await call(db,h.tenantPath+'/report-definitions/'+row.id,{method:'PATCH',cookie:owner.cookie,body:{name:'edited'}});expect(updated.status).toBe(200);expect((await updated.json() as {definition:{id:string}}).definition.id).toBe(row.id);expect(rows.length).toBe(100);
 db.tables.set('report_runs',Array.from({length:1000},(_,i)=>({id:'run-'+i,tenant_id:h.tenantId})));
 await expect(runDefinition(env,row)).rejects.toMatchObject({status:400});
 expect(db.tables.get('report_runs')!.length).toBe(1000);
});
it('allows explicit admin capacity recovery without automatic deletion or foreign-tenant purge',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),member=await setupSecondUser(db),env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
 const args={tenantId:h.tenantId,name:'report',definition:{group_by:'project' as const,range:{kind:'this_month' as const}},schedule:'off',createdBy:owner.accountId};
 const row=await insertDefinition(env,args);
 db.tables.set('report_definitions',Array.from({length:100},(_,i)=>({...row,id:'d'+i,deleted_at:'2026-01-01'})));
 db.tables.set('report_runs',Array.from({length:1000},(_,i)=>({id:'r'+i,tenant_id:h.tenantId,definition_id:'d0',created_at:'2026-01-01'})));
 const base=h.tenantPath+'/report-storage';
 expect((await call(db,base,{cookie:member.cookie})).status).toBe(403);
 const listing=await (await call(db,base,{cookie:owner.cookie})).json() as {definitions:unknown[];runs:unknown[]};expect(listing.definitions).toHaveLength(100);expect(listing.runs).toHaveLength(1000);
 expect((await call(db,base+'/definitions/d0',{method:'DELETE',cookie:owner.cookie})).status).toBe(400);
 expect((await call(db,base+'/definitions/d0?confirm=permanent',{method:'DELETE',cookie:member.cookie})).status).toBe(403);
 expect((await call(db,base+'/definitions/d0?confirm=permanent',{method:'DELETE',cookie:owner.cookie})).status).toBe(200);
 const replacement=await insertDefinition(env,args);expect(replacement.id).toBeTruthy();
 expect((await call(db,base+'/runs/r0?confirm=permanent',{method:'DELETE',cookie:owner.cookie})).status).toBe(200);
 expect((await runDefinition(env,replacement)).runId).toBeTruthy();
 db.tables.get('report_runs')!.push({id:'foreign',tenant_id:'other'});
 expect((await call(db,base+'/runs/foreign?confirm=permanent',{method:'DELETE',cookie:owner.cookie})).status).toBe(404);
});
