import {expect,it} from 'vitest';
import {FakeDb,makeEnv} from './fake-db';
import {setupOwner,setupSecondUser,buildHierarchy,call} from './phase2-helpers';
import {applyEntryPatch,insertEntry} from '../src/tasks';
import {UI_SCRIPT} from '../src/routes/ui';

it('checks replacement task scope centrally including approved-request edits',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),h=await buildHierarchy(db,owner.cookie),member=await setupSecondUser(db),env=makeEnv(db);
 const a=await call(db,h.projectPath+'/tasks',{method:'POST',cookie:owner.cookie,body:{title:'a'}});
 const task=(await a.json() as {task:{id:string}}).task;
 const p=await call(db,h.projectPath.slice(0,h.projectPath.lastIndexOf('/')),{method:'POST',cookie:owner.cookie,body:{name:'private'}});
 const other=(await p.json() as {project:{id:string}}).project;
 const b=await call(db,h.projectPath.slice(0,h.projectPath.lastIndexOf('/')+1)+other.id+'/tasks',{method:'POST',cookie:owner.cookie,body:{title:'b'}});
 const otherTask=(await b.json() as {task:{id:string}}).task;
 db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
 db.tables.set('project_members',[{project_id:h.projectId,account_id:member.accountId,role:'editor'}]);
 const entry=await insertEntry(env,{tenantId:h.tenantId,workspaceId:h.workspaceId,taskId:task.id,accountId:member.accountId,startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:01:00Z',durationSeconds:60,noteEnc:null},{accountId:member.accountId});
 await expect(applyEntryPatch(env,entry,{taskId:otherTask.id},{accountId:member.accountId,viaApprovedRequest:true})).rejects.toMatchObject({status:404});
 await expect(applyEntryPatch(env,entry,{taskId:'missing'},{accountId:owner.accountId,admin:true})).rejects.toMatchObject({status:404});
 const foreign=await buildHierarchy(db,owner.cookie);
 const f=await call(db,foreign.projectPath+'/tasks',{method:'POST',cookie:owner.cookie,body:{title:'f'}});
 const ft=(await f.json() as {task:{id:string}}).task;
 await expect(applyEntryPatch(env,entry,{taskId:ft.id},{accountId:owner.accountId,admin:true})).rejects.toMatchObject({status:400});
 const ok=await applyEntryPatch(env,entry,{taskId:otherTask.id},{accountId:owner.accountId,admin:true});
 expect(ok.task_id).toBe(otherTask.id);expect(ok.workspace_id).toBe(h.workspaceId);
});

it('clears cached and in-memory keys before logout even when the request fails',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db),page=await call(db,'/app',{cookie:owner.cookie});
 const html=await page.text();
 const script=html.match(/document\.getElementById\("logoutBtn"\)\.onclick = async \(\) => \{([\s\S]*?)\n\};/)![1]!;
 const storage=new Map([['kosu_adk','old-key'],['kosu_adk_owner','owner']]);
 const sessionStorage={getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)};
 const win:{KosuUI?:{vault:{adk:unknown};lock:()=>void}}={};
 new Function('window','document','sessionStorage','localStorage',UI_SCRIPT)(win,{},sessionStorage,{setItem:()=>{}});
 win.KosuUI!.vault.adk='in-memory';
 const location={href:''};
 await new Function('window','fetch','location',`return (async()=>{${script}})()`)(win,async()=>{throw Error('offline');},location);
 expect(win.KosuUI!.vault.adk).toBeNull();expect(storage.size).toBe(0);expect(location.href).toBe('/');
});

it('restores a browser key only after confirming the same account',async()=>{
 for(const savedOwner of ['same','other',null]){
  const storage=new Map<string,string>([['kosu_adk','AQID']]);if(savedOwner)storage.set('kosu_adk_owner',savedOwner);
  const sessionStorage={getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)};
  const win:{KosuUI?:{vault:{adk:unknown};onReady:(fn:()=>void)=>void}}={};
  const doc={getElementById:(id:string)=>id==='busybar'?{style:{}}:null};
  const fetcher=async(path:string)=>new Response(JSON.stringify(path==='/api/v1/me'?{account:{id:'same',default_tenant_id:'t'},tenants:[{id:'t'}]}:path==='/me'?{account:{id:'same'}}:path.endsWith('/workspaces')?{workspaces:[]}:{entry:null}),{status:200});
  new Function('window','document','sessionStorage','localStorage','fetch','setInterval',UI_SCRIPT)(win,doc,sessionStorage,{getItem:()=>null,setItem:()=>{}},fetcher,()=>0);
  await new Promise<void>(resolve=>win.KosuUI!.onReady(resolve));
  if(savedOwner==='same')expect(Array.from(win.KosuUI!.vault.adk as Uint8Array)).toEqual([1,2,3]);
  else{expect(win.KosuUI!.vault.adk).toBeNull();expect(storage.has('kosu_adk')).toBe(false);}
 }
});


it('invalidates another tab and fails closed before decryption after account changes',async()=>{
 const listeners:Record<string,(e:unknown)=>void>={};
 const storage=new Map<string,string>([['kosu_adk','AQID'],['kosu_adk_owner','A']]);
 const sessionStorage={getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)};
 const win:any={addEventListener:(name:string,fn:(e:unknown)=>void)=>{listeners[name]=fn;}};
 const doc={getElementById:(id:string)=>id==='busybar'?{style:{}}:null};
 let account='A';
 const fetcher=async(path:string)=>new Response(JSON.stringify(path==='/api/v1/me'?{account:{id:account,default_tenant_id:'t'},tenants:[{id:'t'}]}:path==='/me'?{account:{id:account}}:path.endsWith('/workspaces')?{workspaces:[]}:{entry:null}),{status:200});
 new Function('window','document','sessionStorage','localStorage','fetch','setInterval',UI_SCRIPT)(win,doc,sessionStorage,{getItem:()=>null,setItem:()=>{}},fetcher,()=>0);
 await new Promise<void>(resolve=>win.KosuUI.onReady(resolve));
 expect(win.KosuUI.vault.adk).not.toBeNull();
 listeners.storage!({key:'kosu_vault_logout'});
 expect(win.KosuUI.vault.adk).toBeNull();expect(storage.has('kosu_adk')).toBe(false);
 // A suspended tab can miss the storage event. Crypto must independently recheck identity.
 win.KosuUI.vault.adk=new Uint8Array(32);storage.set('kosu_adk','old');account='B';
 await expect(win.KosuUI.encryptText('private')).rejects.toThrow();
 expect(win.KosuUI.vault.adk).toBeNull();expect(storage.has('kosu_adk')).toBe(false);
});

it('cannot commit a delayed unlock or vault creation after logout',async()=>{
 for(const operation of ['unlock','createVault']){
  const storage=new Map<string,string>(),listeners:Record<string,(e:unknown)=>void>={};
  const win:any={addEventListener:(name:string,fn:(e:unknown)=>void)=>{listeners[name]=fn;}};
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const fetcher=async(path:string,opts?:RequestInit)=>{
   if(path.endsWith('/recover')||(path.endsWith('/encryption-key')&&opts?.method==='PUT')){expect(JSON.parse(String(opts?.body)).expected_account_id).toBe('A');entered();await gate;return new Response('{}');}
   return new Response(JSON.stringify(path==='/api/v1/me'?{account:{id:'A',default_tenant_id:'t'},tenants:[{id:'t'}]}:path==='/me'?{account:{id:'A'}}:path.endsWith('/workspaces')?{workspaces:[]}:path.endsWith('/encryption-key')?{vault:{exists:true,kdf:{salt:'AQID',iterations:1},wrapped_key:'v1.'+btoa('a'.repeat(20))}}:{entry:null}));
  };
  const cryptoMock={getRandomValues:(a:Uint8Array)=>a.fill(1),subtle:{importKey:async()=>({}),deriveKey:async()=>({}),decrypt:async()=>new Uint8Array(32).buffer,encrypt:async()=>new Uint8Array(32).buffer}};
  new Function('window','document','sessionStorage','localStorage','fetch','setInterval','crypto',UI_SCRIPT)(win,{getElementById:(id:string)=>id==='busybar'?{style:{}}:null},{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},{getItem:()=>null,setItem:()=>{}},fetcher,()=>0,cryptoMock);
  await new Promise<void>(r=>win.KosuUI.onReady(r));
  if(operation==='createVault')await win.KosuUI.prepareVault();
  const pending=operation==='createVault'?win.KosuUI.createVault(true):win.KosuUI.unlock('code');await started;
  listeners.storage!({key:'kosu_vault_logout'});release();
  await expect(pending).rejects.toThrow();expect(win.KosuUI.vault.adk).toBeNull();expect(storage.has('kosu_adk')).toBe(false);
 }
});
it('rejects vault requests prepared for another authenticated account',async()=>{
 const db=new FakeDb(),owner=await setupOwner(db);
 for(const [path,method] of [['/api/v1/me/encryption-key','PUT'],['/api/v1/me/encryption-key/recover','POST']]){
  expect((await call(db,path!,{method,cookie:owner.cookie,body:{expected_account_id:'different',recovery_code:'code'}})).status).toBe(403);
 }
});

it('obtains the recovery code before PUT so a later identity-check failure is recoverable',async()=>{
 const storage=new Map<string,string>(),win:any={};let puts=0;
 const fetcher=async(path:string,opts?:RequestInit)=>{
  if(path.endsWith('/encryption-key')&&opts?.method==='PUT'){puts++;return new Response(JSON.stringify({account_id:'A',vault:{exists:true}}));}
  if(path==='/me'){if(puts)throw Error('offline after successful write');return new Response(JSON.stringify({account:{id:'A'}}));}
  return new Response(JSON.stringify(path==='/api/v1/me'?{account:{id:'A',default_tenant_id:'t'},tenants:[{id:'t'}]}:path.endsWith('/workspaces')?{workspaces:[]}:{entry:null}));
 };
 const cryptoMock={getRandomValues:(a:Uint8Array)=>a.fill(1),subtle:{importKey:async()=>({}),deriveKey:async()=>({}),encrypt:async()=>new Uint8Array(32).buffer}};
 new Function('window','document','sessionStorage','localStorage','fetch','setInterval','crypto',UI_SCRIPT)(win,{getElementById:(id:string)=>id==='busybar'?{style:{}}:null},{getItem:(k:string)=>storage.get(k),setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},{getItem:()=>null,setItem:()=>{}},fetcher,()=>0,cryptoMock);
 await new Promise<void>(r=>win.KosuUI.onReady(r));
 const code=await win.KosuUI.prepareVault();expect(code).toMatch(/^[A-Z2-7-]+$/);expect(puts).toBe(0);
 await expect(win.KosuUI.createVault(false)).rejects.toThrow();expect(puts).toBe(0);
 await expect(win.KosuUI.createVault(true)).rejects.toThrow('offline');expect(puts).toBe(1);expect(storage.has('kosu_adk')).toBe(false);
});
