import {expect,it} from 'vitest';
import s1 from '../migrations/0001_init.sql?raw';
import s2 from '../migrations/0002_hierarchy.sql?raw';
import s3 from '../migrations/0003_phase2.sql?raw';
import s4 from '../migrations/0004_phase3.sql?raw';
import s5 from '../migrations/0005_phase4.sql?raw';
import s6 from '../migrations/0006_phase5.sql?raw';
import s8 from '../migrations/0008_mail_bounds.sql?raw';

it('enforces quotas, replay uniqueness, and mail rate bounds in real SQLite',async(ctx)=>{
 let db:any;try{const mod=await import(/* @vite-ignore */ ('node:'+'sqlite'));db=new mod.DatabaseSync(':memory:');}catch{ctx.skip();return;}
 try{
  for(const sql of [s1,s2,s3,s4,s5,s6,s8])db.exec(sql);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec("INSERT INTO tenant_limits (tenant_id,max_tasks,updated_at) VALUES ('limited',1,'now')");
  const insert=(id:string,tenant='rate')=>db.exec(`INSERT INTO tasks (id,tenant_id,workspace_id,title) VALUES ('${id}','${tenant}','w','mail')`);
  insert('mail_first','limited');expect(()=>insert('mail_second','limited')).toThrow('capacity');
  for(let i=0;i<60;i++)insert('mail_'+i);
  expect(()=>insert('mail_overflow')).toThrow('rate limit');
  expect(db.prepare("SELECT id FROM tasks WHERE tenant_id='rate'").all()).toHaveLength(60);
  insert('ordinary');
  expect(()=>insert('ordinary')).toThrow();
 }finally{db.close();}
});
it('D1-style transactional batching rolls back receipts, task and history on later failure',async(ctx)=>{
 const {atomicWrites}=await import('../src/atomic-writes');
 let db:any;try{const mod=await import(/* @vite-ignore */ ('node:'+'sqlite'));db=new mod.DatabaseSync(':memory:');}catch{ctx.skip();return;}
 try{
  db.exec('CREATE TABLE receipts(id TEXT PRIMARY KEY);CREATE TABLE tasks(id TEXT PRIMARY KEY);CREATE TABLE history(id TEXT PRIMARY KEY);');
  const prepare=(sql:string,values:unknown[]=[]):any=>({bind:(...v:unknown[])=>prepare(sql,v),run:async()=>{db.prepare(sql).run(...values);return {success:true};}});
  const env={DB:{prepare,batch:async(statements:any[])=>{db.exec('BEGIN');try{for(const s of statements)await s.run();db.exec('COMMIT');return [];}catch(e){db.exec('ROLLBACK');throw e;}}}} as any;
  await expect(atomicWrites(env,async e=>{
   await e.DB.prepare('INSERT INTO receipts VALUES (?)').bind('m').run();await e.DB.prepare('INSERT INTO tasks VALUES (?)').bind('t').run();
   await e.DB.prepare('INSERT INTO missing_history VALUES (?)').bind('h').run();
  })).rejects.toThrow();
  expect(db.prepare('SELECT * FROM receipts').all()).toHaveLength(0);expect(db.prepare('SELECT * FROM tasks').all()).toHaveLength(0);
 }finally{db.close();}
});
