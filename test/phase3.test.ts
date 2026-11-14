import { describe, expect, it } from "vitest";
import app from "../src/index";
import { FakeDb, makeEnv } from "./fake-db";
import {
  ORIGIN,
  buildHierarchy,
  call,
  setupOwner,
  setupSecondUser,
} from "./phase2-helpers";

type Json = Record<string, any>;

async function j(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

/** Invite + accept so `second` becomes a tenant member. */
async function addMember(
  db: FakeDb,
  ownerCookie: string,
  tenantPath: string,
  second: { cookie: string },
  email = "second@example.com",
) {
  const created = await call(db, `${tenantPath}/invites`, {
    method: "POST",
    cookie: ownerCookie,
    body: { level: "tenant", email, role: "member" },
  });
  expect(created.status).toBe(201);
  const body = await j(created);
  const token = (body.accept_url as string).split("/invite/")[1] as string;
  const accept = await call(db, "/api/v1/invites/accept", {
    method: "POST",
    cookie: second.cookie,
    body: { token },
  });
  expect(accept.status).toBe(200);
}

/** Invite + accept at project level (editor) for project write access. */
async function addProjectMember(
  db: FakeDb,
  ownerCookie: string,
  h: {
    tenantPath: string;
    workspaceId: string;
    teamId: string;
    projectId: string;
  },
  second: { cookie: string },
  email = "second@example.com",
) {
  const created = await call(db, `${h.tenantPath}/invites`, {
    method: "POST",
    cookie: ownerCookie,
    body: {
      level: "project",
      email,
      role: "editor",
      workspace_id: h.workspaceId,
      team_id: h.teamId,
      project_id: h.projectId,
    },
  });
  expect(created.status).toBe(201);
  const body = await j(created);
  const token = (body.accept_url as string).split("/invite/")[1] as string;
  const accept = await call(db, "/api/v1/invites/accept", {
    method: "POST",
    cookie: second.cookie,
    body: { token },
  });
  expect(accept.status).toBe(200);
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

describe("labels, saved filters and search", () => {
  it("attaches scoped labels, filters the task list and saves filters", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);

    const labelRes = await call(db, `${h.tenantPath}/labels`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope_level: "tenant", name: "重要", color: "#d33" },
    });
    expect(labelRes.status).toBe(400); // color must be #RRGGBB
    const labelOk = await call(db, `${h.tenantPath}/labels`, {
      method: "POST",
      cookie: owner.cookie,
      body: { scope_level: "tenant", name: "重要", color: "#dd3333" },
    });
    expect(labelOk.status).toBe(201);
    const label = (await j(labelOk)).label as Json;

    const t1 = await createTask(db, owner.cookie, h.projectPath, {
      title: "請求書を送る",
    });
    const t2 = await createTask(db, owner.cookie, h.projectPath, {
      title: "掃除する",
    });

    const attach = await call(
      db,
      `${h.projectPath}/tasks/${t1.id}/labels`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: { label_id: label.id },
      },
    );
    expect(attach.status).toBe(200);

    const visible = await call(db, `${h.projectPath}/labels`, {
      cookie: owner.cookie,
    });
    expect((await j(visible)).labels).toHaveLength(1);

    const filtered = await call(
      db,
      `${h.projectPath}/tasks?label_id=${label.id}`,
      { cookie: owner.cookie },
    );
    const filteredBody = await j(filtered);
    expect(filteredBody.tasks.map((t: Json) => t.id)).toEqual([t1.id]);
    void t2;

    // Saved filter: status=todo matches both; apply returns them.
    const saved = await call(db, `${h.tenantPath}/saved-filters`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "未着手",
        project_id: h.projectId,
        query: { status: ["todo"] },
      },
    });
    expect(saved.status).toBe(201);
    const filter = (await j(saved)).filter as Json;
    const applied = await call(
      db,
      `${h.tenantPath}/saved-filters/${filter.id}/apply`,
      { cookie: owner.cookie },
    );
    expect((await j(applied)).tasks).toHaveLength(2);

    // Server-side plaintext search finds task titles and label names.
    const search = await call(db, `${h.tenantPath}/search?q=請求`, {
      cookie: owner.cookie,
    });
    const searchBody = await j(search);
    expect(searchBody.tasks.map((t: Json) => t.id)).toEqual([t1.id]);
    const byLabel = await call(db, `${h.tenantPath}/search?q=重要`, {
      cookie: owner.cookie,
    });
    expect((await j(byLabel)).labels).toHaveLength(1);
  });
});

describe("workflow customization", () => {
  it("replaces project statuses, validates writes, falls back on clear", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);

    const put = await call(db, `${h.projectPath}/workflow/statuses`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        statuses: [
          { slug: "backlog", name: "バックログ", category: "open" },
          { slug: "wip", name: "作業中", category: "doing" },
          { slug: "shipped", name: "出荷済み", category: "done" },
        ],
      },
    });
    expect(put.status).toBe(200);
    const got = await call(db, `${h.projectPath}/workflow/statuses`, {
      cookie: owner.cookie,
    });
    const gotBody = await j(got);
    expect(gotBody.source).toBe("project");
    expect(gotBody.statuses.map((s: Json) => s.slug)).toEqual([
      "backlog",
      "wip",
      "shipped",
    ]);

    const okTask = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "A", status: "wip" },
    });
    expect(okTask.status).toBe(201);
    const badTask = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "B", status: "doing" },
    });
    expect(badTask.status).toBe(400);

    const cleared = await call(db, `${h.projectPath}/workflow/statuses`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(cleared.status).toBe(200);
    const after = await call(db, `${h.projectPath}/workflow/statuses`, {
      cookie: owner.cookie,
    });
    expect((await j(after)).source).toBe("default");
    const defaultTask = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "C", status: "doing" },
    });
    expect(defaultTask.status).toBe(201);
  });

  it("migrates tasks on rename through the renames map", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "移行対象",
      status: "todo",
    });
    const put = await call(db, `${h.tenantPath}/workflow/statuses`, {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        statuses: [
          { slug: "new", name: "新規", category: "open" },
          { slug: "doing", name: "作業中", category: "doing" },
          { slug: "done", name: "完了", category: "done" },
        ],
        renames: { todo: "new" },
      },
    });
    expect(put.status).toBe(200);
    const after = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      cookie: owner.cookie,
    });
    expect((await j(after)).task.status).toBe("new");
  });
});

describe("custom fields", () => {
  it("defines project fields and validates task values", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const defRes = await call(db, `${h.projectPath}/custom-fields`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "顧客区分",
        field_type: "select",
        options: ["法人", "個人"],
        required: false,
      },
    });
    expect(defRes.status).toBe(201);
    const field = (await j(defRes)).field as Json;

    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "値つき",
    });
    const set = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/custom-fields`,
      {
        method: "PUT",
        cookie: owner.cookie,
        body: { values: { [field.id]: "法人" } },
      },
    );
    expect(set.status).toBe(200);
    const values = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/custom-fields`,
      { cookie: owner.cookie },
    );
    const fields = (await j(values)).fields as Json[];
    expect(fields.find((f) => f.id === field.id)?.value).toBe("法人");

    const bad = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/custom-fields`,
      {
        method: "PUT",
        cookie: owner.cookie,
        body: { values: { [field.id]: "団体" } },
      },
    );
    expect(bad.status).toBe(400);
  });
});

describe("comments, mentions and watchers", () => {
  it("notifies mentioned users and auto-watches the author", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const second = await setupSecondUser(db);
    await addMember(db, owner.cookie, h.tenantPath, second);
    await addProjectMember(db, owner.cookie, h, second);

    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "相談タスク",
    });
    const comment = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/comments`,
      {
        method: "POST",
        cookie: second.cookie,
        body: {
          body_enc: "v1.dGVzdA",
          mentions: [owner.accountId],
        },
      },
    );
    expect(comment.status).toBe(201);

    const notes = await call(
      db,
      `/api/v1/me/notifications?tenant_id=${h.tenantId}`,
      { cookie: owner.cookie },
    );
    const notesBody = await j(notes);
    expect(
      notesBody.notifications.some((n: Json) => n.kind === "mention"),
    ).toBe(true);

    const watchers = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/watchers`,
      { cookie: owner.cookie },
    );
    expect((await j(watchers)).watchers).toContain(second.accountId);
  });
});

describe("attachments", () => {
  it("uploads, downloads and deletes bytes through R2 with permission checks", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "添付つき",
    });

    const env = makeEnv(db);
    const upload = await app.request(
      `${ORIGIN}${h.projectPath}/tasks/${task.id}/attachments`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "x-file-name": encodeURIComponent("メモ.txt"),
          "content-type": "text/plain",
        },
        body: new TextEncoder().encode("添付の中身"),
      },
      env,
    );
    expect(upload.status).toBe(201);
    const attachment = (await j(upload)).attachment as Json;
    expect(attachment.filename).toBe("メモ.txt");

    const download = await call(db, `${h.tenantPath}/attachments/${attachment.id}`, {
      cookie: owner.cookie,
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("添付の中身");

    // A stranger (no membership) cannot download.
    const stranger = await setupSecondUser(db, "stranger@example.com");
    const denied = await call(db, `${h.tenantPath}/attachments/${attachment.id}`, {
      cookie: stranger.cookie,
    });
    expect(denied.status).toBe(404);

    const del = await call(db, `${h.tenantPath}/attachments/${attachment.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    const gone = await call(db, `${h.tenantPath}/attachments/${attachment.id}`, {
      cookie: owner.cookie,
    });
    expect(gone.status).toBe(404);
  });
});

describe("history, restore and trash", () => {
  it("records history, restores a snapshot, and supports trash + purge", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "元の名前",
    });
    const patch = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { title: "新しい名前" },
    });
    expect(patch.status).toBe(200);

    const history = await call(db, `${h.projectPath}/tasks/${task.id}/history`, {
      cookie: owner.cookie,
    });
    const entries = (await j(history)).history as Json[];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const createEntry = entries.find((e) => e.action === "create") as Json;
    const restored = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/history/${createEntry.id}/restore`,
      { method: "POST", cookie: owner.cookie },
    );
    expect(restored.status).toBe(200);
    expect((await j(restored)).task.title).toBe("元の名前");

    // Trash: delete -> listed -> restore -> delete -> purge.
    const del = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    const trash = await call(db, `${h.tenantPath}/trash`, {
      cookie: owner.cookie,
    });
    expect((await j(trash)).tasks.map((t: Json) => t.id)).toContain(task.id);
    const back = await call(
      db,
      `${h.tenantPath}/trash/tasks/${task.id}/restore`,
      { method: "POST", cookie: owner.cookie },
    );
    expect(back.status).toBe(200);
    await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    const purge = await call(db, `${h.tenantPath}/trash/tasks/${task.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(purge.status).toBe(200);
    const trashAfter = await call(db, `${h.tenantPath}/trash`, {
      cookie: owner.cookie,
    });
    expect((await j(trashAfter)).tasks).toHaveLength(0);
  });
});

describe("recurrence, templates, duplication, bulk, archive, recent", () => {
  it("spawns the next occurrence when a recurring task completes", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "週次レポート",
      due_date: "2026-11-16",
    });
    const rule = await call(db, `${h.projectPath}/tasks/${task.id}/recurrence`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { freq: "weekly", interval: 1 },
    });
    expect(rule.status).toBe(200);

    const done = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: { status: "done" },
    });
    expect(done.status).toBe(200);
    const list = await call(db, `${h.projectPath}/tasks`, {
      cookie: owner.cookie,
    });
    const tasks = (await j(list)).tasks as Json[];
    const spawned = tasks.find(
      (t) => t.id !== task.id && t.title === "週次レポート",
    ) as Json;
    expect(spawned).toBeTruthy();
    expect(spawned.status).toBe("todo");
    expect(spawned.due_date).toBe("2026-11-23");
    const moved = await call(
      db,
      `${h.projectPath}/tasks/${spawned.id}/recurrence`,
      { cookie: owner.cookie },
    );
    expect((await j(moved)).recurrence).not.toBeNull();
  });

  it("instantiates templates, duplicates tasks, bulk-edits and archives", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);

    const tpl = await call(db, `${h.projectPath}/task-templates`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        name: "オンボーディング",
        payload: {
          title: "入社手続き",
          due_offset_days: 7,
          subtasks: [{ title: "アカウント発行", due_offset_days: 1 }],
        },
      },
    });
    expect(tpl.status).toBe(201);
    const template = (await j(tpl)).template as Json;
    const made = await call(
      db,
      `${h.projectPath}/task-templates/${template.id}/instantiate`,
      {
        method: "POST",
        cookie: owner.cookie,
        body: { base_date: "2026-11-16" },
      },
    );
    expect(made.status).toBe(201);
    const madeTasks = (await j(made)).tasks as Json[];
    expect(madeTasks).toHaveLength(2);
    const root = madeTasks.find((t) => t.title === "入社手続き") as Json;
    expect(root.due_date).toBe("2026-11-23");

    const dup = await call(db, `${h.projectPath}/tasks/${root.id}/duplicate`, {
      method: "POST",
      cookie: owner.cookie,
      body: {},
    });
    expect(dup.status).toBe(201);
    const dupBody = await j(dup);
    expect(dupBody.created.length).toBe(2);

    const other = await createTask(db, owner.cookie, h.projectPath, {
      title: "一括対象",
    });
    const bulk = await call(db, `${h.projectPath}/tasks/bulk`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        task_ids: [other.id, dupBody.task.id],
        patch: { status: "doing" },
      },
    });
    expect(bulk.status).toBe(200);
    const results = (await j(bulk)).results as Json[];
    expect(results.every((r) => r.ok)).toBe(true);
    const check = await call(db, `${h.projectPath}/tasks/${other.id}`, {
      cookie: owner.cookie,
    });
    expect((await j(check)).task.status).toBe("doing");

    // Recent views: the GET above recorded the task.
    const recent = await call(db, "/api/v1/me/recent", {
      cookie: owner.cookie,
    });
    expect(
      (await j(recent)).items.some(
        (i: Json) => i.entity_type === "task" && i.entity_id === other.id,
      ),
    ).toBe(true);

    // Archive hides the task by default.
    const arch = await call(db, `${h.projectPath}/tasks/${other.id}/archive`, {
      method: "POST",
      cookie: owner.cookie,
      body: { archived: true },
    });
    expect(arch.status).toBe(200);
    const list = await call(db, `${h.projectPath}/tasks`, {
      cookie: owner.cookie,
    });
    expect(
      (await j(list)).tasks.some((t: Json) => t.id === other.id),
    ).toBe(false);
    const listAll = await call(
      db,
      `${h.projectPath}/tasks?include_archived=1`,
      { cookie: owner.cookie },
    );
    expect(
      (await j(listAll)).tasks.some((t: Json) => t.id === other.id),
    ).toBe(true);
  });
});

describe("attachments permission checks (standing rule)", () => {
  it("denies downloads to other tenants and to anonymous callers", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "権限チェック用",
    });
    const env = makeEnv(db);
    const upload = await app.request(
      `${ORIGIN}${h.projectPath}/tasks/${task.id}/attachments`,
      {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: ORIGIN,
          "x-file-name": encodeURIComponent("secret.txt"),
          "content-type": "text/plain",
        },
        body: new TextEncoder().encode("秘密の内容"),
      },
      env,
    );
    expect(upload.status).toBe(201);
    const attachment = (await j(upload)).attachment as Json;

    // Another tenant's owner: a legitimate user, but the wrong tenant.
    const other = await setupSecondUser(db, "other-tenant@example.com");
    await buildHierarchy(db, other.cookie);
    const cross = await call(db, `${h.tenantPath}/attachments/${attachment.id}`, {
      cookie: other.cookie,
    });
    expect(cross.status).toBe(404);

    // Anonymous: no session, no API key.
    const anon = await call(db, `${h.tenantPath}/attachments/${attachment.id}`);
    expect(anon.status).toBe(401);

    // Listing under the project is guarded the same way.
    const list = await call(db, `${h.projectPath}/tasks/${task.id}/attachments`, {
      cookie: other.cookie,
    });
    expect(list.status).toBe(404);
  });
});
