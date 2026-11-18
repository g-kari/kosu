import {it,expect} from 'vitest';
import {MemoryLocalDb} from '../client/local-db.js';
import {SyncEngine} from '../client/sync-engine.js';
import {FakeDb} from './fake-db';
import {buildHierarchy,call,setupOwner,setupSecondUser} from './phase2-helpers';
it('real client refreshes grants and purge, quarantines revoked edits before any push',async()=>{
 const db=new FakeDb(), owner=await setupOwner(db), h=await buildHierarchy(db,owner.cookie), user=await setupSecondUser(db);
 db.tables.get('tenant_members').push({tenant_id:h.tenantId,account_id:user.accountId,role:'member'});
 const {task}=await (await call(db,`${h.projectPath}/tasks`,{method:'POST',cookie:owner.cookie,body:{title:'private'}})).json();
 const local=new MemoryLocalDb();let pushes=0;
 const engine=new SyncEngine({db:local,fetchFn:(path,opts)=>{if(path.endsWith('/push')) pushes++;return call(db,path,{cookie:user.cookie,method:opts.method,body:opts.body?JSON.parse(opts.body):undefined});}});
 await engine.pull(h.tenantId); expect(await local.getEntity('task',task.id)).toBeNull();
 db.tables.set('project_members',[{project_id:h.projectId,account_id:user.accountId,role:'editor'}]);
 await engine.pull(h.tenantId);expect((await local.getEntity('task',task.id)).title).toBe('private');
 await engine.queueChange({entity_type:'task',entity_id:task.id,op:'upsert',base_version:1,payload:{...task,title:'unsent'}});
 db.tables.set('project_members',[]);await engine.push(h.tenantId);
 expect(pushes).toBe(0);expect(await local.getEntity('task',task.id)).toBeNull();expect(await local.listOutbox()).toHaveLength(0);
 expect((await local.getMeta('sync_quarantine'))[0].changes[0].payload.title).toBe('unsent');
 db.tables.set('project_members',[{project_id:h.projectId,account_id:user.accountId,role:'editor'}]);await engine.pull(h.tenantId);
 db.tables.set('tasks',[]);db.tables.get('sync_changes').push({seq:2,tenant_id:h.tenantId,entity_type:'task',entity_id:task.id,op:'delete',payload:null});
 await engine.pull(h.tenantId);expect(await local.getEntity('task',task.id)).toBeNull();
});
it('does not upload account A queued plaintext with account B session',async()=>{
 const local=new MemoryLocalDb();await local.setMeta('sync_account_id','A');await local.enqueue({account_id:'A',payload:{title:'A private'}});let sent=false;
 const engine=new SyncEngine({db:local,fetchFn:async(path)=>{if(path!='/me')sent=true;return new Response(JSON.stringify({account:{id:'B'}}),{status:200});}});
 await expect(engine.push('tenant')).rejects.toThrow('another account');expect(sent).toBe(false);expect(await local.listOutbox()).toHaveLength(1);
});
it('does not adopt legacy unowned data into the current account',async()=>{
 const db=new MemoryLocalDb();await db.enqueue({payload:{title:'old A private'}});
 const engine=new SyncEngine({db,fetchFn:async()=>new Response(JSON.stringify({account:{id:'B'}}))});
 await expect(engine.pull('tenant')).rejects.toThrow('no verified owner');expect(await db.getMeta('sync_account_id')).toBeNull();expect(await db.getMeta('sync_quarantine')).toBeNull();
});
it('initial handshake preserves fresh verified-owner edits and uploads normally',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),local=new MemoryLocalDb();
 const engine=new SyncEngine({db:local,fetchFn:(path,opts)=>call(db,path,{cookie:owner.cookie,method:opts.method,body:opts.body?JSON.parse(opts.body):undefined})});
 await engine.queueChange({entity_type:'task',entity_id:'new-local',op:'upsert',base_version:0,payload:{tenant_id:h.tenantId,project_id:h.projectId,title:'fresh'}});
 expect((await engine.push(h.tenantId)).applied).toBe(1);expect(await local.getMeta('sync_quarantine')).toBeNull();
});
it('clears a formerly visible entry after a scope-reassignment epoch change',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),local=new MemoryLocalDb();
 const engine=new SyncEngine({db:local,fetchFn:(path,opts)=>call(db,path,{cookie:owner.cookie,method:opts.method,body:opts.body?JSON.parse(opts.body):undefined})});
 await engine.pull(h.tenantId);
 await local.putEntity('time_entry',{id:'old',tenant_id:h.tenantId,title:'previous scope'});
 db.tables.set('sync_access_epochs',[{tenant_id:h.tenantId,revision:1}]);
 await engine.pull(h.tenantId);expect(await local.getEntity('time_entry','old')).toBeNull();
});
