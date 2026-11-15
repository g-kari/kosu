import type {Env} from './types';

/** Collect write-only steps and commit through one D1 transactional batch.
 * Reads deliberately observe committed state, not pending writes. The callback
 * must not branch on results of queued writes. Used by inbound mail creation. */
export async function atomicWrites<T>(env:Env, action:(transaction:Env)=>Promise<T>):Promise<T> {
 const pending:D1PreparedStatement[]=[];
 const originals=new WeakMap<object,D1PreparedStatement>();
 const queuedResult=()=>({success:true,results:[],meta:{}} as unknown as D1Result);
 const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{
  const proxy=new Proxy(statement, {get(target,key){
   if(key==='bind') return (...args:unknown[])=>wrap(target.bind(...args));
   if(key==='run') return async()=>{pending.push(target);return queuedResult();};
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});originals.set(proxy,statement);return proxy;
 };
 const db=new Proxy(env.DB,{get(target,key){
  if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql));
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{pending.push(...statements.map(s=>originals.get(s)??s));return statements.map(queuedResult);};
  if(key==='exec')throw new Error('exec is not supported in atomicWrites');
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const result=await action({...env,DB:db});
 if(pending.length)await env.DB.batch(pending);
 return result;
}
