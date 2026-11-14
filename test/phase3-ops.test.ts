import { describe, expect, it, vi } from "vitest";
import { runDeadlineReminders } from "../src/notify";
import { FakeDb, makeEnv } from "./fake-db";
import {
  buildHierarchy,
  call,
  setupOwner,
  setupSecondUser,
} from "./phase2-helpers";
import {
  createVaultMaterial,
  decryptText,
  encryptText,
} from "../client/vault.js";
import { ClientSearchIndex } from "../client/search.js";

type Json = Record<string, any>;

async function j(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

async function inviteAccept(
  db: FakeDb,
  ownerCookie: string,
  tenantPath: string,
  second: { cookie: string },
  body: Json,
) {
  const created = await call(db, `${tenantPath}/invites`, {
    method: "POST",
    cookie: ownerCookie,
    body,
  });
  expect(created.status).toBe(201);
  const createdBody = await j(created);
  const token = (createdBody.accept_url as string).split("/invite/")[1];
  const accept = await call(db, "/api/v1/invites/accept", {
    method: "POST",
    cookie: second.cookie,
    body: { token },
  });
  expect(accept.status).toBe(200);
}

/** Second user as tenant member + project editor. */
async function addFullMember(
  db: FakeDb,
  owner: { cookie: string },
  h: {
    tenantPath: string;
    workspaceId: string;
    teamId: string;
    projectId: string;
  },
  second: { cookie: string },
) {
  await inviteAccept(db, owner.cookie, h.tenantPath, second, {
    level: "tenant",
    email: "second@example.com",
    role: "member",
  });
  await inviteAccept(db, owner.cookie, h.tenantPath, second, {
    level: "project",
    email: "second@example.com",
    role: "editor",
    workspace_id: h.workspaceId,
    team_id: h.teamId,
    project_id: h.projectId,
  });
}

async function createTask(
  db: FakeDb,
  cookie: string,
  projectPath: string,
  body: Json,
): Promise<Json> {
  const res = await call(db, `${projectPath}/tasks`, {
    method: "POST",
    cookie,
    body,
  });
  expect(res.status).toBe(201);
  return (await j(res)).task as Json;
}

async function createEntry(
  db: FakeDb,
  cookie: string,
  projectPath: string,
  taskId: string,
  body: Json,
): Promise<Json> {
  const res = await call(db, `${projectPath}/tasks/${taskId}/time-entries`, {
    method: "POST",
    cookie,
    body,
  });
  expect(res.status).toBe(201);
  return (await j(res)).entry as Json;
}

describe("reports, rates, budgets and leave", () => {
  it("aggregates time with costs, exports CSV and prints HTML", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "集計対象",
    });
    await createEntry(db, owner.cookie, h.projectPath, task.id, {
      started_at: "2026-10-05T09:00:00.000Z",
      ended_at: "2026-10-05T10:00:00.000Z",
    });

    // Rates are admin-only.
    const rate = await call(db, `${h.tenantPath}/rates/${owner.accountId}`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { rate_cents_per_hour: 6000, currency: "JPY" },
    });
    expect(rate.status).toBe(200);

    const budget = await call(
      db,
      `${h.tenantPath}/projects/${h.projectId}/budget`,
      {
        method: "PUT",
        cookie: owner.cookie,
        body: { budget_cents: 5000, currency: "JPY" },
      },
    );
    expect(budget.status).toBe(200);

    const report = await call(
      db,
      `${h.tenantPath}/report?from=2026-10-01&to=2026-10-31&group_by=member`,
      { cookie: owner.cookie },
    );
    expect(report.status).toBe(200);
    const reportBody = await j(report);
    const group = reportBody.report.groups.find(
      (g: Json) => g.key === owner.accountId,
    ) as Json;
    expect(group.rounded_seconds).toBe(3600);
    expect(group.cost_cents).toBe(6000);
    // 2026-10 has 22 weekdays (Mon-Fri) by the default calendar.
    expect(group.expected_seconds).toBe(22 * 8 * 3600);

    const byProject = await call(
      db,
      `${h.tenantPath}/report?from=2026-10-01&to=2026-10-31&group_by=project`,
      { cookie: owner.cookie },
    );
    const projectGroup = (await j(byProject)).report.groups.find(
      (g: Json) => g.key === h.projectId,
    ) as Json;
    expect(projectGroup.budget_cents).toBe(5000);
    expect(projectGroup.over_budget).toBe(true);

    const csv = await call(
      db,
      `${h.tenantPath}/report?from=2026-10-01&to=2026-10-31&group_by=member&format=csv`,
      { cookie: owner.cookie },
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("cost_cents");

    const print = await call(
      db,
      `${h.tenantPath}/report/print?from=2026-10-01&to=2026-10-31&group_by=member`,
      { cookie: owner.cookie },
    );
    expect(print.status).toBe(200);
    expect(print.headers.get("content-type")).toContain("text/html");
    expect(await print.text()).toContain("工数レポート");

    // Leave reduces the member's expected seconds (22 -> 21 days).
    const leave = await call(db, `${h.tenantPath}/leave`, {
      method: "POST",
      cookie: owner.cookie,
      body: { date: "2026-10-06", kind: "vacation" },
    });
    expect(leave.status).toBe(201);
    const report2 = await call(
      db,
      `${h.tenantPath}/report?from=2026-10-01&to=2026-10-31&group_by=member`,
      { cookie: owner.cookie },
    );
    const group2 = (await j(report2)).report.groups.find(
      (g: Json) => g.key === owner.accountId,
    ) as Json;
    expect(group2.expected_seconds).toBe(21 * 8 * 3600);
  });
});

describe("submissions, locks, change requests and proxy entry", () => {
  it("freezes submitted periods for the owner but not for admins", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const second = await setupSecondUser(db);
    await addFullMember(db, owner, h, second);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "提出対象",
    });
    const entry = await createEntry(db, second.cookie, h.projectPath, task.id, {
      started_at: "2026-10-07T09:00:00.000Z",
      ended_at: "2026-10-07T10:00:00.000Z",
    });

    const submit = await call(db, `${h.tenantPath}/submissions`, {
      method: "POST",
      cookie: second.cookie,
      body: { period_start: "2026-10-01", period_end: "2026-10-31" },
    });
    expect(submit.status).toBe(201);
    const submission = (await j(submit)).submission as Json;

    // While submitted, the owner cannot edit their own entry.
    const frozen = await call(db, `${h.tenantPath}/time-entries/${entry.id}`, {
      method: "PATCH",
      cookie: second.cookie,
      body: { ended_at: "2026-10-07T11:00:00.000Z" },
    });
    expect(frozen.status).toBe(403);
    expect((await j(frozen)).error.code).toBe("ENTRY_FROZEN");

    const decide = await call(
      db,
      `${h.tenantPath}/submissions/${submission.id}/decide`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: { decision: "approved" },
      },
    );
    expect(decide.status).toBe(200);

    // Still frozen for the owner after approval; admins may edit.
    const stillFrozen = await call(
      db,
      `${h.tenantPath}/time-entries/${entry.id}`,
      {
        method: "PATCH",
        cookie: second.cookie,
        body: { ended_at: "2026-10-07T11:00:00.000Z" },
      },
    );
    expect(stillFrozen.status).toBe(403);
    const adminEdit = await call(
      db,
      `${h.tenantPath}/time-entries/${entry.id}`,
      {
        method: "PATCH",
        cookie: owner.cookie,
        body: { ended_at: "2026-10-07T11:00:00.000Z" },
      },
    );
    expect(adminEdit.status).toBe(200);
  });

  it("blocks edits in locked months except through approved change requests", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const second = await setupSecondUser(db);
    await addFullMember(db, owner, h, second);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "ロック対象",
    });
    const entry = await createEntry(db, second.cookie, h.projectPath, task.id, {
      started_at: "2026-11-04T09:00:00.000Z",
      ended_at: "2026-11-04T10:00:00.000Z",
    });

    const lock = await call(db, `${h.tenantPath}/period-locks/2026-11/lock`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(lock.status).toBe(200);

    const blocked = await call(db, `${h.tenantPath}/time-entries/${entry.id}`, {
      method: "PATCH",
      cookie: second.cookie,
      body: { ended_at: "2026-11-04T12:00:00.000Z" },
    });
    expect(blocked.status).toBe(403);
    expect((await j(blocked)).error.code).toBe("PERIOD_LOCKED");
    // Admins are blocked too.
    const blockedAdmin = await call(
      db,
      `${h.tenantPath}/time-entries/${entry.id}`,
      {
        method: "PATCH",
        cookie: owner.cookie,
        body: { ended_at: "2026-11-04T12:00:00.000Z" },
      },
    );
    expect(blockedAdmin.status).toBe(403);

    // Change request -> approval applies the edit despite the lock.
    const request = await call(db, `${h.tenantPath}/change-requests`, {
      method: "POST",
      cookie: second.cookie,
      body: {
        entry_id: entry.id,
        type: "edit",
        payload: { ended_at: "2026-11-04T12:00:00.000Z" },
        reason_enc: "v1.cmVhc29u",
      },
    });
    expect(request.status).toBe(201);
    const changeRequest = (await j(request)).change_request as Json;
    const decide = await call(
      db,
      `${h.tenantPath}/change-requests/${changeRequest.id}/decide`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: { decision: "approved" },
      },
    );
    expect(decide.status).toBe(200);
    // The tenant entry list returns the caller's own entries.
    const entries = await call(db, `${h.tenantPath}/time-entries`, {
      cookie: second.cookie,
    });
    const updated = (await j(entries)).entries.find(
      (e: Json) => e.id === entry.id,
    ) as Json;
    expect(updated.ended_at).toBe("2026-11-04T12:00:00.000Z");

    // Unlock restores direct edits.
    const unlock = await call(
      db,
      `${h.tenantPath}/period-locks/2026-11/unlock`,
      { method: "POST", cookie: owner.cookie },
    );
    expect(unlock.status).toBe(200);
    const after = await call(db, `${h.tenantPath}/time-entries/${entry.id}`, {
      method: "PATCH",
      cookie: second.cookie,
      body: { ended_at: "2026-11-04T13:00:00.000Z" },
    });
    expect(after.status).toBe(200);
  });

  it("lets an admin record time on behalf of a member (proxy)", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const second = await setupSecondUser(db);
    await addFullMember(db, owner, h, second);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "代理対象",
    });
    const proxy = await call(db, `${h.tenantPath}/time-entries/proxy`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        account_id: second.accountId,
        task_id: task.id,
        started_at: "2026-11-05T09:00:00.000Z",
        ended_at: "2026-11-05T10:30:00.000Z",
      },
    });
    expect(proxy.status).toBe(201);
    expect((await j(proxy)).entry.account_id).toBe(second.accountId);

    const denied = await call(db, `${h.tenantPath}/time-entries/proxy`, {
      method: "POST",
      cookie: second.cookie,
      body: {
        account_id: second.accountId,
        task_id: task.id,
        started_at: "2026-11-05T09:00:00.000Z",
        ended_at: "2026-11-05T10:30:00.000Z",
      },
    });
    expect(denied.status).toBe(403);
  });
});

describe("notification preferences and webhooks", () => {
  it("honours per-kind in-app opt-outs", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const second = await setupSecondUser(db);
    await addFullMember(db, owner, h, second);

    await createTask(db, owner.cookie, h.projectPath, {
      title: "通知あり",
      assignee_account_id: second.accountId,
    });
    const before = await call(
      db,
      `/api/v1/me/notifications?tenant_id=${h.tenantId}`,
      { cookie: second.cookie },
    );
    expect(
      (await j(before)).notifications.some(
        (n: Json) => n.kind === "task_assigned",
      ),
    ).toBe(true);

    const prefs = await call(db, `${h.tenantPath}/notification-prefs`, {
      method: "PUT",
      cookie: second.cookie,
      body: {
        kinds: { task_assigned: { in_app: false, webhook: false } },
        quiet_start_min: null,
        quiet_end_min: null,
        tz_offset_minutes: 540,
      },
    });
    expect(prefs.status).toBe(200);

    await createTask(db, owner.cookie, h.projectPath, {
      title: "通知なし",
      assignee_account_id: second.accountId,
    });
    const after = await call(
      db,
      `/api/v1/me/notifications?tenant_id=${h.tenantId}`,
      { cookie: second.cookie },
    );
    const assigned = (await j(after)).notifications.filter(
      (n: Json) => n.kind === "task_assigned",
    ) as Json[];
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.title).toContain("通知あり");
  });

  it("creates webhook endpoints with a one-time secret and logs deliveries", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const second = await setupSecondUser(db);
    await addFullMember(db, owner, h, second);

    const created = await call(db, `${h.tenantPath}/webhooks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { url: "https://hooks.invalid/kosu", events: ["task_assigned"] },
    });
    expect(created.status).toBe(201);
    const createdBody = await j(created);
    expect(createdBody.secret).toMatch(/^whk_/);
    expect(createdBody.webhook.secret_enc).toBeUndefined();
    expect(JSON.stringify(createdBody)).not.toContain("secret_enc");

    // An assignment event fans out to the endpoint. The network is
    // stubbed to fail fast; the delivery attempt must still be logged,
    // with the signing header present.
    const seen: { url: string; signature: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: string, init?: { headers?: Record<string, string> }) => {
        seen.push({
          url: String(url),
          signature: init?.headers?.["x-kosu-signature"] ?? null,
        });
        throw new Error("network unreachable (stub)");
      },
    );
    try {
      await createTask(db, owner.cookie, h.projectPath, {
        title: "Webhook 対象",
        assignee_account_id: second.accountId,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://hooks.invalid/kosu");
    expect(seen[0]?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    const deliveries = db.rows("webhook_deliveries");
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0]?.["event"]).toBe("task_assigned");
    expect(deliveries[0]?.["error"]).toContain("stub");
  });
});

describe("sync conflict diffs and resolution", () => {
  it("shows per-field diffs and adopts the chosen side", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "サーバー名",
      status: "todo",
    });
    const now = new Date().toISOString();
    db.seed("sync_conflicts", {
      id: "conflict-1",
      tenant_id: h.tenantId,
      entity_type: "task",
      entity_id: task.id,
      server_version: 2,
      client_base_version: 1,
      server_payload: JSON.stringify({ title: "サーバー名", status: "todo" }),
      client_payload: JSON.stringify({
        title: "クライアント名",
        status: "doing",
      }),
      account_id: owner.accountId,
      device_id: "device-1",
      status: "open",
      created_at: now,
      resolved_at: null,
      resolved_by_account_id: null,
      resolution: null,
    });

    const detail = await call(db, `${h.tenantPath}/sync-conflicts/conflict-1`, {
      cookie: owner.cookie,
    });
    expect(detail.status).toBe(200);
    const conflict = (await j(detail)).conflict as Json;
    const titleDiff = conflict.diff.find((d: Json) => d.field === "title");
    expect(titleDiff.server).toBe("サーバー名");
    expect(titleDiff.client).toBe("クライアント名");
    expect(titleDiff.differs).toBe(true);

    const resolve = await call(
      db,
      `${h.tenantPath}/sync-conflicts/conflict-1/resolve`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: { choice: "client" },
      },
    );
    expect(resolve.status).toBe(200);
    const after = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      cookie: owner.cookie,
    });
    const afterTask = (await j(after)).task as Json;
    expect(afterTask.title).toBe("クライアント名");
    expect(afterTask.status).toBe("doing");

    const list = await call(db, `${h.tenantPath}/sync-conflicts?status=open`, {
      cookie: owner.cookie,
    });
    expect((await j(list)).conflicts).toHaveLength(0);
  });
});

describe("deadline reminders", () => {
  it("notifies the assignee about overdue tasks, once per day", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .slice(0, 10);
    await createTask(db, owner.cookie, h.projectPath, {
      title: "期限切れ",
      due_date: yesterday,
      assignee_account_id: owner.accountId,
    });
    const env = makeEnv(db);
    const first = await runDeadlineReminders(
      env as never,
      new Date().toISOString(),
    );
    expect(first.events).toBe(1);
    // A second run the same day must not duplicate the notification
    // (dedupe key per task + threshold + day).
    await runDeadlineReminders(env as never, new Date().toISOString());
    const notes = await call(
      db,
      `/api/v1/me/notifications?tenant_id=${h.tenantId}`,
      { cookie: owner.cookie },
    );
    const reminders = (await j(notes)).notifications.filter(
      (n: Json) => n.kind === "deadline_reminder",
    ) as Json[];
    expect(reminders).toHaveLength(1);
  });
});

describe("client-side search over decrypted bodies", () => {
  it("finds terms that only exist inside encrypted text", async () => {
    const material = await createVaultMaterial(10_000);
    const enc = (text: string) => encryptText(material.adkBytes, text);
    const index = new ClientSearchIndex({
      decrypt: (value: string) => decryptText(material.adkBytes, value),
    });
    await index.rebuild({
      tasks: [
        {
          id: "t1",
          title: "定例会議",
          description_enc: await enc("請求書の締切は月末です"),
        },
        {
          id: "t2",
          title: "買い物",
          description_enc: await enc("牛乳と卵"),
        },
      ],
      entries: [
        { id: "e1", task_id: "t2", note_enc: await enc("請求書を送った") },
      ],
      comments: [],
    });
    const hits = index.search("請求書");
    expect(hits.map((hit) => hit.id).sort()).toEqual(["e1", "t1"]);
    expect(index.search("存在しない語")).toHaveLength(0);
  });
});
