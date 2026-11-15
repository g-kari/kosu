import {expect,it} from 'vitest';
import {FakeDb} from './fake-db';
import {setupOwner,buildHierarchy,call} from './phase2-helpers';

it('deduplicates mail delivery and respects configured task capacity',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie);
 const created=await call(db,h.projectPath+'/mail-inbound-tokens',{method:'POST',cookie:owner.cookie,body:{label:'mail'}});
 const token=(await created.json() as {token:string}).token;
 const post=(body:unknown)=>call(db,'/inbound/mail/'+token,{method:'POST',body});
 const first=await post({subject:'one',message_id:'message-1'});expect(first.status).toBe(201);const result=await first.json() as {task_id:string};
 const second=await post({subject:'altered replay',message_id:'message-1'});expect(second.status).toBe(200);expect((await second.json() as {task_id:string}).task_id).toBe(result.task_id);
 expect(db.tables.get('tasks')!.length).toBe(1);
 db.tables.set('tenant_limits',[{tenant_id:h.tenantId,max_tasks:1,max_members:null,max_attachment_bytes:null}]);
 expect((await post({subject:'two',message_id:'message-2'})).status).toBe(422);
 expect((await post({subject:'one',message_id:'message-1'})).status).toBe(200);
 db.tables.get('workspaces')![0]!.deleted_at='2026-01-01';
 expect((await post({subject:'three',message_id:'message-3'})).status).toBe(404);
});
it('treats ID-less same-text deliveries as distinct and retains identified receipts after purge',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie);
 const token=(await (await call(db,h.projectPath+'/mail-inbound-tokens',{method:'POST',cookie:owner.cookie,body:{label:'mail'}})).json() as {token:string}).token;
 const post=(body:unknown)=>call(db,'/inbound/mail/'+token,{method:'POST',body});
 expect((await post({subject:'daily same text'})).status).toBe(201);expect((await post({subject:'daily same text'})).status).toBe(201);
 const original=await post({subject:'identified',message_id:'stable-id'});expect(original.status).toBe(201);
 db.tables.set('tasks',[]);
 expect((await post({subject:'identified',message_id:'stable-id'})).status).toBe(200);expect(db.tables.get('tasks')).toHaveLength(0);
});
it('does not convert an atomic write failure into duplicate success',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie);
 const token=(await (await call(db,h.projectPath+'/mail-inbound-tokens',{method:'POST',cookie:owner.cookie,body:{label:'mail'}})).json() as {token:string}).token;
 const original=db.batch.bind(db);let failed=true;
 db.batch=async(statements)=>{if(failed){failed=false;throw Error('synthetic history write failure');}return original(statements);};
 expect((await call(db,'/inbound/mail/'+token,{method:'POST',body:{subject:'retry',message_id:'retry'}})).status).toBe(500);
 expect(db.tables.get('tasks')??[]).toHaveLength(0);expect(db.tables.get('mail_receipts')??[]).toHaveLength(0);
 expect((await call(db,'/inbound/mail/'+token,{method:'POST',body:{subject:'retry',message_id:'retry'}})).status).toBe(201);
 expect(db.tables.get('tasks')).toHaveLength(1);expect(db.tables.get('task_history')).toHaveLength(1);
});
