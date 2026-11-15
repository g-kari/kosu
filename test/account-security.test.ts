import {expect,it} from 'vitest';
import {FakeDb,makeEnv} from './fake-db';
import {setupOwner,setupSecondUser,buildHierarchy,call} from './phase2-helpers';
import {purgeAccount} from '../src/purge';

it('rejects tenant API keys for account state and checks tenant scope on Gantt aliases',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),other=await buildHierarchy(db,owner.cookie);
 const issued=await call(db,h.tenantPath+'/api-keys',{method:'POST',cookie:owner.cookie,body:{name:'scoped',scopes:['read','write']}});
 expect(issued.status).toBe(201);const apiKey=(await issued.json() as {api_key:string}).api_key;
 for(const path of ['/me','/api/v1/me','/api/v1/me/prefs','/api/v1/me/login-events','/api/v1/me/encryption-key','/api/v1/sync/devices','/api/v1/me/recent'])expect((await call(db,path,{apiKey})).status,path).toBe(403);
 expect((await call(db,'/api/v1/tenants',{method:'POST',apiKey,body:{name:'escape'}})).status).toBe(403);
 expect((await call(db,`/api/v1/projects/${other.projectId}/gantt`,{apiKey})).status).toBe(404);
 expect((await call(db,`/api/v1/projects/${h.projectId}/gantt`,{apiKey})).status).toBe(200);
 expect((await call(db,h.projectPath+'/tasks',{method:'POST',apiKey,body:{title:'authorized'}})).status).toBe(201);
});
it('never guesses a new owner or partially dissolves before finding an invalid plan',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),other=await buildHierarchy(db,owner.cookie),member=await setupSecondUser(db),env=makeEnv(db);
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
 await expect(purgeAccount(env,owner.accountId,{dissolveTenantIds:[],successors:{}})).rejects.toMatchObject({status:400});
 expect(db.tables.get('tenant_members')!.find(x=>x.account_id===member.accountId)!.role).toBe('member');
 await expect(purgeAccount(env,owner.accountId,{dissolveTenantIds:[h.tenantId],successors:{}})).rejects.toMatchObject({status:400});
 expect(db.tables.get('tenants')!.some(x=>x.id===h.tenantId)).toBe(true);
 await expect(purgeAccount(env,owner.accountId,{dissolveTenantIds:[other.tenantId],successors:{[h.tenantId]:owner.accountId}})).rejects.toMatchObject({status:400});
 db.tables.get('tenant_members')!.splice(db.tables.get('tenant_members')!.findIndex(x=>x.account_id===member.accountId),1);
 db.tables.set('project_members',[{project_id:h.projectId,account_id:member.accountId,role:'admin'}]);
 await expect(purgeAccount(env,owner.accountId,{dissolveTenantIds:[other.tenantId],successors:{[h.tenantId]:member.accountId}})).rejects.toMatchObject({status:400});
 expect(db.tables.get('tenants')!.some(x=>x.id===other.tenantId)).toBe(true);
});
