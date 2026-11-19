import {expect,it} from 'vitest';
import {FakeDb} from './fake-db';
import {call} from './phase2-helpers';

it('purges private response caches before auth transitions even when offline',async()=>{
 const source=await (await call(new FakeDb(),'/sw.js')).text();
 for(const path of ['/auth/logout','/auth/login','/auth/callback']){
  const callbacks:Record<string,Function>={},events:string[]=[];
  new Function('self','caches','fetch',source)({addEventListener:(name:string,fn:Function)=>{callbacks[name]=fn;}},{delete:async()=>{events.push('purged');return true;}},async()=>{events.push('network');throw Error('offline');});
  let pending:Promise<unknown>|undefined;
  callbacks.fetch!({request:new Request('https://kosu.0g0.xyz'+path,{method:path==='/auth/logout'?'POST':'GET'}),respondWith:(p:Promise<unknown>)=>{pending=p;}});
  await expect(pending).rejects.toThrow('offline');expect(events).toEqual(['purged','network','purged']);
 }
});
it('does not provide cached identity, vault state, or bearer-authenticated API replies',async()=>{
 const source=await (await call(new FakeDb(),'/sw.js')).text(),callbacks:Record<string,Function>={};
 new Function('self','caches','fetch',source)({addEventListener:(name:string,fn:Function)=>{callbacks[name]=fn;}},{},()=>{throw Error('must bypass');});
 for(const request of [new Request('https://kosu.0g0.xyz/api/v1/me'),new Request('https://kosu.0g0.xyz/api/v1/me/prefs'),new Request('https://kosu.0g0.xyz/api/v1/tenants/t/tasks',{headers:{authorization:'Bearer synthetic'}}),new Request('https://kosu.0g0.xyz/api/v1/tenants/t/tasks',{cache:'no-store'})]){
  let intercepted=false;callbacks.fetch!({request,respondWith:()=>{intercepted=true;}});expect(intercepted).toBe(false);
 }
});

it('does not repopulate another account cache from an in-flight response',async()=>{
 const source=await (await call(new FakeDb(),'/sw.js')).text(),callbacks:Record<string,Function>={};
 let resolve!: (r:Response)=>void;
 const delayed=new Promise<Response>(r=>resolve=r);
 let writes=0;
 new Function('self','caches','fetch',source)({addEventListener:(name:string,fn:Function)=>{callbacks[name]=fn;}},{delete:async()=>true,open:async()=>({put:async()=>{writes++;}})},async(req:Request)=>req.url.endsWith('/auth/logout')?new Response('{}'):delayed);
 let first!:Promise<Response>,logout!:Promise<Response>;
 callbacks.fetch!({request:new Request('https://kosu.0g0.xyz/api/v1/tenants/t/tasks'),respondWith:(p:Promise<Response>)=>{first=p;}});
 callbacks.fetch!({request:new Request('https://kosu.0g0.xyz/auth/logout',{method:'POST'}),respondWith:(p:Promise<Response>)=>{logout=p;}});
 await logout;resolve(new Response(JSON.stringify({private:'old-account'})));expect((await first).status).toBe(409);expect(writes).toBe(0);
});
it('rejects a cached response resolved after an account transition',async()=>{
 const source=await (await call(new FakeDb(),'/sw.js')).text(),callbacks:Record<string,Function>={};
 let release!:(r:Response)=>void,entered!:()=>void;
 const started=new Promise<void>(r=>entered=r),delayed=new Promise<Response>(r=>release=r);
 new Function('self','caches','fetch',source)({addEventListener:(name:string,fn:Function)=>callbacks[name]=fn},{delete:async()=>true,open:async()=>({match:()=>{entered();return delayed;}})},async(req:Request)=>{if(req.url.endsWith('/auth/logout'))return new Response('{}');throw Error('offline');});
 let first!:Promise<Response>,logout!:Promise<Response>;
 callbacks.fetch!({request:new Request('https://kosu.0g0.xyz/api/v1/tenants/t/tasks'),respondWith:(p:Promise<Response>)=>first=p});
 await started;callbacks.fetch!({request:new Request('https://kosu.0g0.xyz/auth/logout',{method:'POST'}),respondWith:(p:Promise<Response>)=>logout=p});await logout;
 release(new Response('old private plaintext'));const result=await first;expect(result.status).toBe(409);expect(await result.text()).not.toContain('plaintext');
});
it('does not delete a new account cache when an old detached cache write completes',async()=>{
 const source=await (await call(new FakeDb(),'/sw.js')).text(),callbacks:Record<string,Function>={};let finish!:()=>void,entered!:()=>void;
 const started=new Promise<void>(r=>entered=r),pending=new Promise<void>(r=>finish=r);let deletes=0,newWrites=0;
 const oldCache={put:async()=>{entered();await pending;}},newCache={put:async()=>{newWrites++;}};
 new Function('self','caches','fetch',source)({addEventListener:(name:string,fn:Function)=>callbacks[name]=fn},{delete:async()=>{deletes++;return true;},open:async()=>deletes?newCache:oldCache},async()=>new Response('{}'));
 const dispatch=(path:string)=>{let p!:Promise<Response>;callbacks.fetch!({request:new Request('https://kosu.0g0.xyz'+path),respondWith:(v:Promise<Response>)=>p=v});return p;};
 await dispatch('/api/v1/tenants/old/tasks');await started;await dispatch('/auth/logout');await dispatch('/api/v1/tenants/new/tasks');await Promise.resolve();finish();await Promise.resolve();await Promise.resolve();
 expect(newWrites).toBe(1);expect(deletes).toBe(2);
});
it('fences cache reads and writes for the entire overlapping auth transition window',async()=>{
 const source=await (await call(new FakeDb(),'/sw.js')).text(),callbacks:Record<string,Function>={};
 const releases:Array<()=>void>=[];let apiCalls=0;
 new Function('self','caches','fetch',source)({addEventListener:(name:string,fn:Function)=>callbacks[name]=fn},{delete:async()=>true,open:async()=>({match:async()=>undefined,put:async()=>{throw Error('must not cache');}})},async(req:Request)=>{if(req.url.includes('/auth/'))return new Promise<Response>(r=>releases.push(()=>r(new Response('{}'))));apiCalls++;throw Error('offline');});
 const dispatch=(path:string)=>{let p!:Promise<Response>;callbacks.fetch!({request:new Request('https://kosu.0g0.xyz'+path),respondWith:(v:Promise<Response>)=>p=v});return p;};
 const logout=dispatch('/auth/logout'),login=dispatch('/auth/login');await Promise.resolve();await Promise.resolve();
 expect((await dispatch('/api/v1/tenants/t/tasks')).status).toBe(409);expect(apiCalls).toBe(0);
 releases[0]!();await logout;expect((await dispatch('/api/v1/tenants/t/tasks')).status).toBe(409);
 releases[1]!();await login;expect((await dispatch('/api/v1/tenants/t/tasks')).status).toBe(503);expect(apiCalls).toBe(1);
});
