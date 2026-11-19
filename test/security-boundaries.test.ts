import { describe, expect, it, vi, afterEach } from "vitest";
import { shell } from "../src/routes/pages";
import { parseExpiresAt, createShareLink, resolveShareToken } from "../src/public-links";
import { reportToCsv, type TimeReport } from "../src/reports";
import { deliverSlackNotification } from "../src/notify";
import { encryptField } from "../src/crypto";
import { FakeDb, makeEnv } from "./fake-db";
import { buildHierarchy, call, setupOwner, setupSecondUser } from "./phase2-helpers";

afterEach(() => vi.useRealTimers());
describe("security regression boundaries", () => {
  it("escapes title markup but preserves normal title and trusted app script", () => {
    const html = shell('</title><script>alert(1)</script><title>', "", "trusted()");
    expect(html).not.toContain('</title><script>alert(1)');
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<script>trusted()</script>');
    expect(shell('日本語 & title', '', '')).toContain('日本語 &amp; title');
  });
  it("canonicalizes expiry and rejects expired or malformed legacy timestamps", async () => {
    expect(parseExpiresAt({ expires_at: '2030-01-01T09:00:00+09:00' })).toBe('2030-01-01T00:00:00.000Z');
    const db = new FakeDb(); const owner = await setupOwner(db); const h = await buildHierarchy(db, owner.cookie);
    const env = makeEnv(db);
    for (const expiresAt of ['2030-01-01T01:00:00+09:00', 'not-a-date']) {
      const {token} = await createShareLink(env, {tenantId:h.tenantId, projectId:h.projectId, label:null, createdBy:owner.accountId, expiresAt});
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00Z'));
      expect(await resolveShareToken(env,token)).toBeNull(); vi.restoreAllMocks();
    }
    const {token} = await createShareLink(env, {tenantId:h.tenantId, projectId:h.projectId, label:null, createdBy:owner.accountId, expiresAt:'2099-01-01T00:00:00Z'});
    expect(await resolveShareToken(env,token)).not.toBeNull();
  });
  it("neutralizes spreadsheet text formulae and quotes carriage returns without altering numbers", () => {
    const report = {group_by:'task',currency:'JPY',groups:[{key:'id',label:'\t=1+1\rrow',seconds:-3,rounded_seconds:0,cost_cents:0,entries:1}],totals:{seconds:-3,rounded_seconds:0,cost_cents:0,entries:1}} as TimeReport;
    const csv = reportToCsv(report);
    expect(csv).toContain('"\'\t=1+1\rrow"'); expect(csv).toContain(',-3,0,0,');
  });
  it("does not send to revoked Slack connections and preserves enabled live ones", async () => {
    const db = new FakeDb(); const env = makeEnv(db); const fetcher = vi.fn(async()=>new Response('',{status:200}));
    const secret = await encryptField(env.FIELD_ENCRYPTION_KEY,'https://hooks.slack.com/services/test');
    db.tables.set('integration_connections',[{id:'deleted',tenant_id:'t',provider:'slack',enabled:1,secret_enc:secret,deleted_at:'2026-01-01',created_at:'2025-01-01'}]);
    expect(await deliverSlackNotification(env,{tenantId:'t',kind:'task',title:'x'},fetcher)).toBe(false); expect(fetcher).not.toHaveBeenCalled();
    db.tables.get('integration_connections')![0]!.deleted_at=null;
    expect(await deliverSlackNotification(env,{tenantId:'t',kind:'task',title:'x'},fetcher)).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("iCal excludes private projects from plain members and allows explicit viewers", async () => {
    const db = new FakeDb(); const owner = await setupOwner(db); const h = await buildHierarchy(db,owner.cookie); const member = await setupSecondUser(db);
    db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:member.accountId,role:'member'});
    expect((await call(db,`${h.projectPath}/tasks`,{method:'POST',cookie:owner.cookie,body:{title:'Private calendar task',due_date:'2030-01-01'}})).status).toBe(201);
    const feed = await call(db,`${h.tenantPath}/ical-feeds`,{method:'POST',cookie:member.cookie,body:{name:'mine'}});
    expect(feed.status).toBe(201); const data = await feed.json() as {token:string};
    const path = `/feeds/ical/${data.token}.ics`;
    expect(await (await call(db,path)).text()).not.toContain('Private calendar task');
    db.tables.set('project_members',[{project_id:h.projectId,account_id:member.accountId,role:'viewer'}]);
    expect(await (await call(db,path)).text()).toContain('Private calendar task');
  });
  it.each(['tenants', 'workspaces', 'teams'])("iCal withholds tasks after %s deletion", async (table) => {
    const db = new FakeDb(); const owner = await setupOwner(db); const h = await buildHierarchy(db,owner.cookie);
    await call(db,`${h.projectPath}/tasks`,{method:'POST',cookie:owner.cookie,body:{title:'Deleted hierarchy task',due_date:'2030-01-01'}});
    const feed = await call(db,`${h.tenantPath}/ical-feeds`,{method:'POST',cookie:owner.cookie,body:{name:'mine'}});
    const data = await feed.json() as {token:string};
    db.tables.get(table)![0]!.deleted_at = '2026-01-01T00:00:00Z';
    expect(await (await call(db,`/feeds/ical/${data.token}.ics`)).text()).not.toContain('Deleted hierarchy task');
  });
  it("requires current project access even for an attachment uploader", async () => {
    const db = new FakeDb(); const owner = await setupOwner(db); const h = await buildHierarchy(db,owner.cookie); const former = await setupSecondUser(db);
    db.tables.get('tenant_members')!.push({tenant_id:h.tenantId,account_id:former.accountId,role:'member'});
    const taskResponse = await call(db,`${h.projectPath}/tasks`,{method:'POST',cookie:owner.cookie,body:{title:'Private'}});
    const {task} = await taskResponse.json() as {task:{id:string}};
    db.tables.set('attachments',[{id:'a',tenant_id:h.tenantId,task_id:task.id,account_id:former.accountId,r2_key:'x',deleted_at:null}]);
    const response = await call(db,`${h.tenantPath}/attachments/a`,{method:'DELETE',cookie:former.cookie});
    expect(response.status).toBe(404); expect(db.tables.get('attachments')![0]!.deleted_at).toBeNull();
  });
});
