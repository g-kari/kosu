/**
 * Phase 5 tests: automation rules, project templates, completion-based
 * recurrence, report definitions + scheduling, estimate units,
 * escalation, PWA shell, preferences / i18n, tenant limits, API key IP
 * allowlists, login alerts, task pagination, share links, intake
 * forms, onboarding samples, account deletion and the operator view.
 */
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { FakeDb, makeEnv } from "./fake-db";
import {
  buildHierarchy,
  call,
  ORIGIN,
  setupOwner,
  setupSecondUser,
} from "./phase2-helpers";
import { runDeadlineEscalations } from "../src/escalation";
import { runDueReports } from "../src/report-builder";
import { recordLoginEvent } from "../src/security";

type Json = Record<string, unknown>;
const j = async (res: Response): Promise<Json> => (await res.json()) as Json;

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

async function inviteAndAccept(
  db: FakeDb,
  ownerCookie: string,
  tenantPath: string,
  secondCookie: string,
) {
  const created = await call(db, `${tenantPath}/invites`, {
    method: "POST",
    cookie: ownerCookie,
    body: { level: "tenant", email: "second@example.com", role: "member" },
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as { accept_url: string };
  const token = body.accept_url.split("/invite/")[1] as string;
  const accept = await call(db, "/api/v1/invites/accept", {
    method: "POST",
    cookie: secondCookie,
    body: { token },
  });
  expect(accept.status).toBe(200);
}

function todayPlus(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe("automation rules", () => {
  it("runs set_assignee on status change and logs runs", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const second = await setupSecondUser(db);
    const h = await buildHierarchy(db, owner.cookie);
    await inviteAndAccept(db, owner.cookie, h.tenantPath, second.cookie);

    const created = await call(db, `${h.tenantPath}/automation-rules`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "着手で担当を付ける",
        trigger: "task_status_changed",
        condition: { to_status: "doing" },
        actions: [{ type: "set_assignee", account_id: second.accountId }],
      },
    });
    expect(created.status).toBe(201);
    const rule = (await j(created)).rule as Json;

    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "自動化対象",
    });
    const patched = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { status: "doing" },
    });
    expect(patched.status).toBe(200);
    expect(((await j(patched)).task as Json).assignee_account_id).toBe(
      second.accountId,
    );

    const runs = await call(db, `${h.tenantPath}/automation-runs`, {
      cookie: owner.cookie,
    });
    const runRows = (await j(runs)).runs as Json[];
    expect(runRows.some((r) => r.rule_id === rule.id && r.result === "ok")).toBe(
      true,
    );

    // Disable, then the same change no longer applies the action.
    const upd = await call(
      db,
      `${h.tenantPath}/automation-rules/${rule.id}`,
      {
        method: "PATCH",
        cookie: owner.cookie,
        body: {
          name: "着手で担当を付ける",
          trigger: "task_status_changed",
          condition: { to_status: "doing" },
          actions: [{ type: "set_assignee", account_id: second.accountId }],
          enabled: false,
        },
      },
    );
    expect(upd.status).toBe(200);
    const task2 = await createTask(db, owner.cookie, h.projectPath, {
      title: "対象2",
      assignee_account_id: owner.accountId,
    });
    const patched2 = await call(db, `${h.projectPath}/tasks/${task2.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { status: "doing" },
    });
    expect(((await j(patched2)).task as Json).assignee_account_id).toBe(
      owner.accountId,
    );

    const del = await call(db, `${h.tenantPath}/automation-rules/${rule.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    const list = await call(db, `${h.tenantPath}/automation-rules`, {
      cookie: owner.cookie,
    });
    expect(((await j(list)).rules as Json[]).length).toBe(0);
  });

  it("rejects invalid rules", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const bad = await call(db, `${h.tenantPath}/automation-rules`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "x", trigger: "nope", actions: [] },
    });
    expect(bad.status).toBe(400);
  });
});

describe("project templates", () => {
  it("captures tasks, dependencies and milestones, then instantiates shifted", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const a = await createTask(db, owner.cookie, h.projectPath, {
      title: "設計",
      start_date: "2026-12-01",
      due_date: "2026-12-05",
    });
    const b = await createTask(db, owner.cookie, h.projectPath, {
      title: "実装",
      start_date: "2026-12-06",
      due_date: "2026-12-10",
    });
    const dep = await call(db, `${h.projectPath}/dependencies`, {
      method: "POST",
      cookie: owner.cookie,
      body: { task_id: b.id, depends_on_task_id: a.id },
    });
    expect(dep.status).toBe(201);
    const ms = await call(db, `${h.projectPath}/milestones`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "リリース", date: "2026-12-15" },
    });
    expect(ms.status).toBe(201);

    const cap = await call(db, `${h.tenantPath}/project-templates`, {
      method: "POST",
      cookie: owner.cookie,
      body: { project_id: h.projectId, name: "開発テンプレ" },
    });
    expect(cap.status).toBe(201);
    const template = (await j(cap)).template as Json;
    expect(template.task_count).toBe(2);

    const inst = await call(
      db,
      `${h.tenantPath}/project-templates/${template.id}/instantiate`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: { team_id: h.teamId, name: "新規プロジェクト", start_date: "2027-01-10" },
      },
    );
    expect(inst.status).toBe(201);
    const instBody = await j(inst);
    expect(instBody.task_count).toBe(2);
    const newProject = instBody.project as Json;
    const newPath = `/api/v1/tenants/${h.tenantId}/workspaces/${h.workspaceId}/teams/${h.teamId}/projects/${newProject.id}`;
    const tasks = (await j(await call(db, `${newPath}/tasks`, { cookie: owner.cookie }))).tasks as Json[];
    const design = tasks.find((t) => t.title === "設計") as Json;
    const impl = tasks.find((t) => t.title === "実装") as Json;
    // Base date 2026-12-01 -> start 2027-01-10 shifts everything +40d.
    expect(design.start_date).toBe("2027-01-10");
    expect(design.due_date).toBe("2027-01-14");
    expect(impl.due_date).toBe("2027-01-19");
    const gantt = await j(
      await call(db, `/api/v1/projects/${newProject.id}/gantt`, {
        cookie: owner.cookie,
      }),
    );
    expect((gantt.dependencies as Json[]).length).toBe(1);
    expect((gantt.milestones as Json[]).length).toBe(1);
    expect((gantt.milestones as Json[])[0]?.date).toBe("2027-01-24");
  });
});

describe("completion-based recurrence", () => {
  it("derives the next due date from the completion date", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "完了ベース",
      due_date: "2020-01-01",
    });
    const rule = await call(db, `${h.projectPath}/tasks/${task.id}/recurrence`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { freq: "weekly", interval: 1, basis: "completion" },
    });
    expect(rule.status).toBe(200);
    expect(((await j(rule)).recurrence as Json).basis).toBe("completion");

    const done = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { status: "done" },
    });
    expect(done.status).toBe(200);
    const tasks = (await j(await call(db, `${h.projectPath}/tasks`, { cookie: owner.cookie }))).tasks as Json[];
    const spawned = tasks.find((t) => t.id !== task.id) as Json;
    expect(spawned).toBeTruthy();
    expect(spawned.due_date).toBe(todayPlus(7));
  });
});

describe("estimate units", () => {
  it("stores story points and T-shirt size next to minutes", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "見積もり",
      estimate_minutes: 120,
      estimate_points: 5,
      estimate_size: "M",
    });
    expect(task.estimate_points).toBe(5);
    expect(task.estimate_size).toBe("M");
    const patched = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { estimate_points: 8, estimate_size: "L" },
    });
    const after = (await j(patched)).task as Json;
    expect(after.estimate_points).toBe(8);
    expect(after.estimate_size).toBe("L");
    const bad = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "bad", estimate_size: "XXL" },
    });
    expect(bad.status).toBe(400);
  });
});

describe("report definitions", () => {
  it("defines, runs and lists scheduled reports; cron runs due ones", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "対象",
    });
    const entry = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/time-entries`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: {
          started_at: `${todayPlus(0)}T09:00:00Z`,
          ended_at: `${todayPlus(0)}T10:00:00Z`,
        },
      },
    );
    expect(entry.status).toBe(201);

    const created = await call(db, `${h.tenantPath}/report-definitions`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "週次レポート",
        definition: { group_by: "project", range: { kind: "last_days", days: 7 } },
        schedule: "weekly",
      },
    });
    expect(created.status).toBe(201);
    const def = (await j(created)).definition as Json;
    expect(def.next_run_at).toBeTruthy();

    const run = await call(
      db,
      `${h.tenantPath}/report-definitions/${def.id}/run`,
      { method: "POST", cookie: owner.cookie, body: {} },
    );
    expect(run.status).toBe(200);
    const report = (await j(run)).report as Json;
    expect((report.totals as Json).seconds).toBe(3600);

    // Make it due and run the cron-side sweep.
    const rows = db.tables.get("report_definitions") ?? [];
    for (const row of rows) row["next_run_at"] = "2020-01-01T00:00:00Z";
    const swept = await runDueReports(makeEnv(db) as never);
    expect(swept.ran).toBe(1);
    const runs = await call(
      db,
      `${h.tenantPath}/report-definitions/${def.id}/runs`,
      { cookie: owner.cookie },
    );
    expect(((await j(runs)).runs as Json[]).length).toBe(2);
  });
});

describe("deadline escalation", () => {
  it("notifies the assignee before the deadline and admins after", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const second = await setupSecondUser(db);
    const h = await buildHierarchy(db, owner.cookie);
    await inviteAndAccept(db, owner.cookie, h.tenantPath, second.cookie);

    const put = await call(db, `${h.tenantPath}/escalation`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { enabled: true, before_days: 3, overdue_admin_days: 1, repeat_days: 2 },
    });
    expect(put.status).toBe(200);

    const soon = await createTask(db, owner.cookie, h.projectPath, {
      title: "もうすぐ締切",
      due_date: todayPlus(3),
      assignee_account_id: second.accountId,
    });
    expect(soon.id).toBeTruthy();
    const overdue = await createTask(db, owner.cookie, h.projectPath, {
      title: "超過タスク",
      due_date: todayPlus(-1),
      assignee_account_id: second.accountId,
    });
    expect(overdue.id).toBeTruthy();

    const env = makeEnv(db);
    const result = await runDeadlineEscalations(env as never);
    expect(result.notifications).toBeGreaterThanOrEqual(3);

    const notes = await call(
      db,
      `/api/v1/me/notifications?tenant_id=${h.tenantId}`,
      { cookie: second.cookie },
    );
    const list = (await j(notes)).notifications as Json[];
    const esc = list.filter((n) => {
      const payload = (n.payload ?? {}) as Json;
      return payload.escalation_stage !== undefined;
    });
    expect(esc.length).toBe(2);

    const ownerNotes = await call(
      db,
      `/api/v1/me/notifications?tenant_id=${h.tenantId}`,
      { cookie: owner.cookie },
    );
    const ownerList = (await j(ownerNotes)).notifications as Json[];
    // The owner (tenant admin) is only on the overdue stage.
    expect(
      ownerList.some((n) => ((n.payload ?? {}) as Json).escalation_stage === 2),
    ).toBe(true);
    // Repeat run inside the same day is deduplicated.
    const again = await runDeadlineEscalations(env as never);
    expect(again.notifications).toBe(0);
  });
});

describe("usage and limits", () => {
  it("blocks task creation and member joins at the limit", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    await createTask(db, owner.cookie, h.projectPath, { title: "1件目" });

    const usage = await call(db, `${h.tenantPath}/usage`, {
      cookie: owner.cookie,
    });
    const usageBody = await j(usage);
    expect((usageBody.usage as Json).tasks).toBe(1);
    expect((usageBody.usage as Json).members).toBe(1);

    const put = await call(db, `${h.tenantPath}/limits`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { max_tasks: 1, max_members: 1 },
    });
    expect(put.status).toBe(200);

    const blocked = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "2件目" },
    });
    expect(blocked.status).toBe(422);
    expect(((await j(blocked)).error as Json).code).toBe("limit_exceeded");

    const second = await setupSecondUser(db);
    const created = await call(db, `${h.tenantPath}/invites`, {
      method: "POST",
      cookie: owner.cookie,
      body: { level: "tenant", email: "second@example.com", role: "member" },
    });
    const token = ((await created.json()) as { accept_url: string }).accept_url.split("/invite/")[1] as string;
    const accept = await call(db, "/api/v1/invites/accept", {
      method: "POST",
      cookie: second.cookie,
      body: { token },
    });
    expect(accept.status).toBe(422);
  });
});

describe("api key ip allowlist", () => {
  it("rejects calls from outside the allowed range", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const issued = await call(db, `${h.tenantPath}/api-keys`, {
      method: "POST",
      cookie: owner.cookie,
      body: { name: "restricted", scopes: ["read"], ip_allowlist: ["203.0.113.0/24"] },
    });
    expect(issued.status).toBe(201);
    const { api_key: apiKey } = (await issued.json()) as { api_key: string };

    const env = makeEnv(db);
    const allowed = await app.request(
      `${ORIGIN}/api/v1/tenants/${h.tenantId}`,
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "cf-connecting-ip": "203.0.113.9",
        },
      },
      env,
    );
    expect(allowed.status).toBe(200);
    const denied = await app.request(
      `${ORIGIN}/api/v1/tenants/${h.tenantId}`,
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "cf-connecting-ip": "198.51.100.9",
        },
      },
      env,
    );
    expect(denied.status).toBe(403);
  });
});

describe("login alerts", () => {
  it("alerts only on a new device/ip combination", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const env = makeEnv(db) as never;
    await recordLoginEvent(env, owner.accountId, "192.0.2.1", "UA-One");
    await recordLoginEvent(env, owner.accountId, "192.0.2.1", "UA-One");
    await recordLoginEvent(env, owner.accountId, "192.0.2.55", "UA-Two");
    const notes = await call(
      db,
      `/api/v1/me/notifications?tenant_id=${h.tenantId}`,
      { cookie: owner.cookie },
    );
    const list = (await j(notes)).notifications as Json[];
    expect(list.filter((n) => n.kind === "login_alert").length).toBe(1);
    const events = await call(db, "/api/v1/me/login-events", {
      cookie: owner.cookie,
    });
    expect(((await j(events)).events as Json[]).length).toBe(3);
  });
});

describe("pagination, pwa and pages", () => {
  it("paginates the task list with a cursor", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    for (let i = 0; i < 5; i++) {
      await createTask(db, owner.cookie, h.projectPath, { title: `T${i}` });
    }
    // Force identical created_at values: fast environments create all
    // rows within one millisecond, which ties the sort prefix. The
    // cursor must still page correctly (regression test for CI).
    for (const row of db.tables.get("tasks") ?? []) {
      row.created_at = "2026-01-01T00:00:00.000Z";
    }
    const all = await call(db, `${h.projectPath}/tasks`, { cookie: owner.cookie });
    expect(((await j(all)).tasks as Json[]).length).toBe(5);
    const page1 = await call(db, `${h.projectPath}/tasks?limit=2`, {
      cookie: owner.cookie,
    });
    const p1 = await j(page1);
    expect((p1.tasks as Json[]).length).toBe(2);
    expect(p1.next_cursor).toBeTruthy();
    const page2 = await call(
      db,
      `${h.projectPath}/tasks?limit=2&cursor=${encodeURIComponent(p1.next_cursor as string)}`,
      { cookie: owner.cookie },
    );
    const p2 = await j(page2);
    expect((p2.tasks as Json[]).length).toBe(2);
    const ids = new Set([
      ...(p1.tasks as Json[]).map((t) => t.id),
      ...(p2.tasks as Json[]).map((t) => t.id),
    ]);
    expect(ids.size).toBe(4);
    const page3 = await call(
      db,
      `${h.projectPath}/tasks?limit=2&cursor=${encodeURIComponent(p2.next_cursor as string)}`,
      { cookie: owner.cookie },
    );
    const p3 = await j(page3);
    expect((p3.tasks as Json[]).length).toBe(1);
    expect(p3.next_cursor).toBeNull();
  });

  it("serves the PWA assets and app chrome", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    await buildHierarchy(db, owner.cookie);
    const env = makeEnv(db);
    const manifest = await app.request(`${ORIGIN}/manifest.webmanifest`, {}, env);
    expect(manifest.status).toBe(200);
    expect(((await manifest.json()) as Json).short_name).toBe("Kosu");
    const sw = await app.request(`${ORIGIN}/sw.js`, {}, env);
    expect(sw.status).toBe(200);
    expect(await sw.text()).toContain("kosu-shell");
    const icon = await app.request(`${ORIGIN}/icons/icon-192.png`, {}, env);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/png");
    const manifestIcons = ((await (await app.request(`${ORIGIN}/manifest.webmanifest`, {}, env)).json()) as Json).icons as Json[];
    expect(manifestIcons.map((i) => i.src)).toContain("/icons/icon-512.png");
    expect(manifestIcons.map((i) => i.src)).toContain("/icons/icon-maskable-512.png");

    const page = await call(db, "/app", { cookie: owner.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('id="palette"');
    expect(html).toContain('class="skip"');
    expect(html).toContain("serviceWorker");
    // Phase 8: the shared stylesheet is an external cacheable asset.
    const cssHref = /<link rel="stylesheet" href="([^"]+)">/.exec(html);
    expect(cssHref).toBeTruthy();
    const css = await call(db, (cssHref as RegExpExecArray)[1]!);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain(":focus-visible");
  });

  it("serves the legal pages as placeholders", async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const terms = await app.request(`${ORIGIN}/terms`, {}, env);
    expect(terms.status).toBe(200);
    expect(await terms.text()).toContain("プレースホルダー");
    const privacy = await app.request(`${ORIGIN}/privacy`, {}, env);
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain("アカウント削除機能");
  });
});

describe("preferences", () => {
  it("round-trips theme, locale and week start", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    await buildHierarchy(db, owner.cookie);
    const patched = await call(db, "/api/v1/me/prefs", {
      method: "PATCH",
      cookie: owner.cookie,
      body: { theme: "dark", locale: "en", week_start: 7 },
    });
    expect(patched.status).toBe(200);
    const prefs = (await j(patched)).prefs as Json;
    expect(prefs.theme).toBe("dark");
    expect(prefs.locale).toBe("en");
    expect(prefs.week_start).toBe(7);
    const bad = await call(db, "/api/v1/me/prefs", {
      method: "PATCH",
      cookie: owner.cookie,
      body: { week_start: 9 },
    });
    expect(bad.status).toBe(400);
    const page = await call(db, "/app/preferences", { cookie: owner.cookie });
    const html = await page.text();
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain("Display preferences");
  });
});

describe("share links and intake forms", () => {
  it("publishes progress read-only and accepts tasks with rate limits", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const doneTask = await createTask(db, owner.cookie, h.projectPath, {
      title: "完了タスク",
    });
    await call(db, `${h.projectPath}/tasks/${doneTask.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { status: "done" },
    });

    const linkRes = await call(db, `${h.projectPath}/share-links`, {
      method: "POST",
      cookie: owner.cookie,
      body: {},
    });
    expect(linkRes.status).toBe(201);
    const linkBody = await j(linkRes);
    const token = linkBody.token as string;
    const env = makeEnv(db);
    const page = await app.request(`${ORIGIN}/share/${token}`, {}, env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("プロジェクトX");
    expect(html).toContain("progressbar");
    const badPage = await app.request(`${ORIGIN}/share/nope`, {}, env);
    expect(badPage.status).toBe(404);
    const del = await call(
      db,
      `${h.projectPath}/share-links/${(linkBody.link as Json).id}`,
      { method: "DELETE", cookie: owner.cookie },
    );
    expect(del.status).toBe(200);
    const gone = await app.request(`${ORIGIN}/share/${token}`, {}, env);
    expect(gone.status).toBe(404);

    const formRes = await call(db, `${h.projectPath}/intake-forms`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "要望受付" },
    });
    expect(formRes.status).toBe(201);
    const formBody = await j(formRes);
    const formToken = formBody.token as string;
    const post = (title: string, website = "") =>
      app.request(
        `${ORIGIN}/intake/${formToken}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ title, website }).toString(),
        },
        env,
      );
    const formPage = await app.request(`${ORIGIN}/intake/${formToken}`, {}, env);
    expect(formPage.status).toBe(200);
    const first = await post("外部からの要望");
    expect(first.status).toBe(200);
    const trap = await post("bot", "http://spam.example");
    expect(trap.status).toBe(200);
    let tasks = (await j(await call(db, `${h.projectPath}/tasks`, { cookie: owner.cookie }))).tasks as Json[];
    expect(tasks.filter((t) => t.title === "外部からの要望").length).toBe(1);
    expect(tasks.filter((t) => t.title === "bot").length).toBe(0);
    for (let i = 0; i < 9; i++) {
      const res = await post(`追加${i}`);
      expect(res.status).toBe(200);
    }
    const limited = await post("制限される");
    expect(limited.status).toBe(429);
    tasks = (await j(await call(db, `${h.projectPath}/tasks`, { cookie: owner.cookie }))).tasks as Json[];
    expect(tasks.filter((t) => t.title === "制限される").length).toBe(0);
  });
});

describe("onboarding sample", () => {
  it("adds and removes the sample project", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const add = await call(db, `${h.tenantPath}/onboarding/sample`, {
      method: "POST",
      cookie: owner.cookie,
      body: {},
    });
    expect(add.status).toBe(201);
    const addBody = await j(add);
    expect(addBody.created).toBe(true);
    const again = await call(db, `${h.tenantPath}/onboarding/sample`, {
      method: "POST",
      cookie: owner.cookie,
      body: {},
    });
    expect((await j(again)).created).toBe(false);
    const sampleProjectId = addBody.sample_project_id as string;
    const samplePath = `/api/v1/tenants/${h.tenantId}/workspaces/${(addBody.project as Json).workspace_id}/teams/${(addBody.project as Json).team_id}/projects/${sampleProjectId}`;
    const tasks = await call(db, `${samplePath}/tasks`, { cookie: owner.cookie });
    expect(((await j(tasks)).tasks as Json[]).length).toBe(3);
    const remove = await call(db, `${h.tenantPath}/onboarding/sample`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect((await j(remove)).removed).toBe(true);
    const state = await call(db, `${h.tenantPath}/onboarding/sample`, {
      cookie: owner.cookie,
    });
    expect((await j(state)).sample_project_id).toBeNull();
  });
});

describe("account deletion", () => {
  it("transfers owned tenants to the named successor", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const second = await setupSecondUser(db);
    const h = await buildHierarchy(db, owner.cookie);
    await inviteAndAccept(db, owner.cookie, h.tenantPath, second.cookie);
    await createTask(db, owner.cookie, h.projectPath, { title: "引き継ぐ仕事" });

    const preview = await call(db, "/api/v1/me/deletion-preview", {
      cookie: owner.cookie,
    });
    const previewBody = (await j(preview)).preview as Json;
    expect((previewBody.owned_tenants as Json[]).length).toBe(1);

    const wrong = await call(db, "/api/v1/me", {
      method: "DELETE",
      cookie: owner.cookie,
      body: { confirm: "wrong" },
    });
    expect(wrong.status).toBe(400);

    const del = await call(db, "/api/v1/me", {
      method: "DELETE",
      cookie: owner.cookie,
      body: {
        confirm: "user@example.com",
        successors: { [h.tenantId]: second.accountId },
      },
    });
    expect(del.status).toBe(200);
    const delBody = await j(del);
    expect(delBody.deleted).toBe(true);
    expect(delBody.transferred).toEqual([h.tenantId]);

    const meAfter = await call(db, "/api/v1/me", { cookie: owner.cookie });
    expect([401, 404]).toContain(meAfter.status);
    const tenantForSecond = await call(db, h.tenantPath, {
      cookie: second.cookie,
    });
    expect(tenantForSecond.status).toBe(200);
    const members = await call(db, `${h.tenantPath}/members`, {
      cookie: second.cookie,
    });
    if (members.status === 200) {
      const rows = (await j(members)).members as Json[];
      const secondRow = rows.find((m) => m.account_id === second.accountId);
      expect(secondRow?.role).toBe("owner");
    }
    const tasks = await call(db, `${h.projectPath}/tasks`, {
      cookie: second.cookie,
    });
    expect(tasks.status).toBe(200);
    expect(((await j(tasks)).tasks as Json[]).length).toBe(1);
  });

  it("dissolves a sole-owned tenant and refuses an unresolved one", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const refused = await call(db, "/api/v1/me", {
      method: "DELETE",
      cookie: owner.cookie,
      body: { confirm: "DELETE" },
    });
    expect(refused.status).toBe(400);
    const del = await call(db, "/api/v1/me", {
      method: "DELETE",
      cookie: owner.cookie,
      body: { confirm: "DELETE", dissolve_tenant_ids: [h.tenantId] },
    });
    expect(del.status).toBe(200);
    expect((await j(del)).dissolved).toEqual([h.tenantId]);
    const second = await setupSecondUser(db, "third@example.com");
    const gone = await call(db, h.tenantPath, { cookie: second.cookie });
    expect(gone.status).toBe(404);
    const meAfter = await call(db, "/api/v1/me", { cookie: owner.cookie });
    expect([401, 404]).toContain(meAfter.status);
  });
});

describe("operator overview", () => {
  it("is restricted to operator accounts", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const plain = await call(db, "/api/v1/admin/overview", {
      cookie: owner.cookie,
    });
    expect(plain.status).toBe(403);
    const env = { ...makeEnv(db), OPERATOR_ACCOUNT_IDS: owner.accountId };
    const res = await app.request(
      `${ORIGIN}/api/v1/admin/overview`,
      { headers: { cookie: owner.cookie } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    const tenants = body.tenants as Json[];
    expect(tenants.some((t) => t.tenant_id === h.tenantId)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("oidc_sub");
    expect(JSON.stringify(body)).not.toContain("sub-");
  });
});
