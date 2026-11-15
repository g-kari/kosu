import {expect,it} from 'vitest';
import {FakeDb,makeEnv} from './fake-db';
import {setupOwner,setupSecondUser,buildHierarchy,call} from './phase2-helpers';
import {insertRule,runAutomationRules} from '../src/automation';
import type {TaskRow} from '../src/types';

it('authorizes both existing and replacement automation scopes',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),member=await setupSecondUser(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
 const body={name:'rule',project_id:h.projectId,trigger:'task_created',actions:[{type:'set_status',status:'doing'}]};
 expect((await call(db,h.tenantPath+'/automation-rules',{method:'POST',cookie:member.cookie,body})).status).toBe(404);
 db.tables.set('project_members',[{project_id:h.projectId,account_id:member.accountId,role:'admin'}]);
 const created=await call(db,h.tenantPath+'/automation-rules',{method:'POST',cookie:member.cookie,body});expect(created.status).toBe(201);
 const rule=(await created.json() as {rule:{id:string}}).rule;
 expect((await call(db,h.tenantPath+'/automation-rules/'+rule.id,{method:'PATCH',cookie:member.cookie,body:{...body,project_id:null}})).status).toBe(403);
 db.tables.set('project_members',[]);
 expect((await call(db,h.tenantPath+'/automation-rules/'+rule.id,{method:'DELETE',cookie:member.cookie})).status).toBe(404);
});
it('does not execute legacy or revoked creators under the triggering users authority',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),member=await setupSecondUser(db),env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
 const res=await call(db,h.projectPath+'/tasks',{method:'POST',cookie:owner.cookie,body:{title:'private'}});const task=(await res.json() as {task:TaskRow}).task;
 await insertRule(env,h.tenantId,{name:'legacy',projectId:h.projectId,trigger:'task_created',condition:{},actions:[{type:'set_status',status:'doing'}],enabled:true},member.accountId);
 await runAutomationRules(env,{tenantId:h.tenantId,trigger:'task_created',task,actorAccountId:owner.accountId});
 expect(db.tables.get('tasks')![0]!.status).toBe('todo');
 expect(db.tables.get('automation_runs')!.at(-1)!.result).toBe('error');
 db.tables.set('project_members',[{project_id:h.projectId,account_id:member.accountId,role:'admin'}]);
 await runAutomationRules(env,{tenantId:h.tenantId,trigger:'task_created',task,actorAccountId:owner.accountId});
 expect(db.tables.get('tasks')![0]!.status).toBe('doing');
});
it('keeps template capture, reuse, and destination-team permissions separate',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),member=await setupSecondUser(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
 const url=h.tenantPath+'/project-templates';
 expect((await call(db,url,{method:'POST',cookie:member.cookie,body:{project_id:h.projectId}})).status).toBe(404);
 const created=await call(db,url,{method:'POST',cookie:owner.cookie,body:{project_id:h.projectId}});expect(created.status).toBe(201);
 const template=(await created.json() as {template:{id:string}}).template;
 expect((await (await call(db,url,{cookie:member.cookie})).json() as {templates:unknown[]}).templates).toHaveLength(0);
 db.tables.set('project_members',[{project_id:h.projectId,account_id:member.accountId,role:'viewer'}]);
 expect((await (await call(db,url,{cookie:member.cookie})).json() as {templates:unknown[]}).templates).toHaveLength(1);
 expect((await call(db,url+'/'+template.id+'/instantiate',{method:'POST',cookie:member.cookie,body:{team_id:h.teamId}})).status).toBe(404);
 db.tables.set('team_members',[{team_id:h.teamId,account_id:member.accountId,role:'member'}]);
 expect((await call(db,url+'/'+template.id+'/instantiate',{method:'POST',cookie:member.cookie,body:{team_id:h.teamId}})).status).toBe(201);
});
it('lets tenant admins manage stored templates and orphan rules without allowing execution',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie);
 const created=await call(db,h.tenantPath+'/project-templates',{method:'POST',cookie:owner.cookie,body:{project_id:h.projectId}});
 const template=(await created.json() as {template:{id:string}}).template;
 const r=await call(db,h.tenantPath+'/automation-rules',{method:'POST',cookie:owner.cookie,body:{name:'saved',project_id:h.projectId,trigger:'task_created',actions:[]}});
 const rule=(await r.json() as {rule:{id:string}}).rule;
 db.tables.get('projects')!.find(x=>x.id===h.projectId)!.deleted_at='2026-01-01';
 const list=await call(db,h.tenantPath+'/project-templates',{cookie:owner.cookie});expect((await list.json() as {templates:unknown[]}).templates).toHaveLength(1);
 expect((await call(db,h.tenantPath+'/project-templates/'+template.id+'/instantiate',{method:'POST',cookie:owner.cookie,body:{team_id:h.teamId}})).status).toBe(201);
 expect((await call(db,h.tenantPath+'/automation-rules/'+rule.id,{method:'DELETE',cookie:owner.cookie})).status).toBe(200);
 expect((await call(db,h.tenantPath+'/project-templates/'+template.id,{method:'DELETE',cookie:owner.cookie})).status).toBe(200);
});
