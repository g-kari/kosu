import {expect,it} from 'vitest';
import s1 from '../migrations/0001_init.sql?raw';
import s2 from '../migrations/0002_hierarchy.sql?raw';
import s3 from '../migrations/0003_phase2.sql?raw';
import s4 from '../migrations/0004_phase3.sql?raw';
import s5 from '../migrations/0005_phase4.sql?raw';
import s6 from '../migrations/0006_phase5.sql?raw';
import s9 from '../migrations/0009_sync_access_epoch.sql?raw';

it('records reassignment epochs atomically without resetting ordinary edits or new entries',async(ctx)=>{
 let db:any;try{const mod=await import(/* @vite-ignore */ ('node:'+'sqlite'));db=new mod.DatabaseSync(':memory:');}catch{ctx.skip();return;}
 try{
  for(const sql of [s1,s2,s3,s4,s5,s6,s9])db.exec(sql);db.exec('PRAGMA foreign_keys=OFF');
  db.exec("INSERT INTO tasks(id,tenant_id,workspace_id,project_id,title) VALUES('a','t','w','p','visible')");
  db.exec("INSERT INTO tasks(id,tenant_id,workspace_id,project_id,title) VALUES('b','t','w','private','hidden')");
  db.exec("INSERT INTO time_entries(id,tenant_id,workspace_id,task_id,account_id,started_at) VALUES('e','t','w','a','owner','2026-01-01')");
  expect(db.prepare('SELECT * FROM sync_access_epochs').all()).toHaveLength(0);
  db.exec("UPDATE tasks SET title='ordinary edit' WHERE id='a'");expect(db.prepare('SELECT * FROM sync_access_epochs').all()).toHaveLength(0);
  db.exec("UPDATE time_entries SET task_id='b' WHERE id='e'");expect(db.prepare("SELECT revision FROM sync_access_epochs WHERE tenant_id='t'").get().revision).toBe(1);
  db.exec("UPDATE tasks SET project_id='other' WHERE id='a'");expect(db.prepare("SELECT revision FROM sync_access_epochs WHERE tenant_id='t'").get().revision).toBe(2);
 }finally{db.close();}
});
