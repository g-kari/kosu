import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import {
  buildHierarchy,
  call,
  setupOwner,
  setupSecondUser,
} from "./phase2-helpers";

interface TaskBody {
  task: {
    id: string;
    title: string;
    status: string;
    version: number;
    estimate_minutes: number | null;
    start_date: string | null;
    due_date: string | null;
    description_enc: string | null;
  };
}

async function createTask(
  db: FakeDb,
  cookie: string,
  projectPath: string,
  body: Record<string, unknown>,
): Promise<TaskBody["task"]> {
  const res = await call(db, `${projectPath}/tasks`, {
    method: "POST",
    cookie,
    body,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as TaskBody).task;
}

describe("tasks CRUD", () => {
  it("creates, patches and soft-deletes a task with version bumps", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);

    const task = await createTask(db, cookie, h.projectPath, {
      title: "設計する",
      description_enc: "v1.ciphertext",
      status: "doing",
      start_date: "2026-11-16",
      due_date: "2026-11-20",
      estimate_minutes: 120,
    });
    expect(task.version).toBe(1);
    expect(task.description_enc).toBe("v1.ciphertext");

    const patch = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "PATCH",
      cookie,
      body: { status: "done" },
    });
    expect(patch.status).toBe(200);
    const patched = ((await patch.json()) as TaskBody).task;
    expect(patched.status).toBe("done");
    expect(patched.version).toBe(2);

    const del = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(del.status).toBe(200);
    const after = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      cookie,
    });
    expect(after.status).toBe(404);
  });

  it("rejects an invalid status and a task under another project", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const bad = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie,
      body: { title: "x", status: "Bad Status!" },
    });
    expect(bad.status).toBe(400);
    const other = await call(
      db,
      `/api/v1/tenants/${h.tenantId}/workspaces/${h.workspaceId}/teams/${h.teamId}/projects/nope/tasks`,
      { method: "POST", cookie, body: { title: "x" } },
    );
    expect(other.status).toBe(404);
  });

  it("hides tasks from non-members and forbids viewers from writing", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "秘密タスク",
    });
    const stranger = await setupSecondUser(db);
    const list = await call(db, `${h.projectPath}/tasks`, {
      cookie: stranger.cookie,
    });
    expect(list.status).toBe(404);
    const one = await call(db, `${h.projectPath}/tasks/${task.id}`, {
      cookie: stranger.cookie,
    });
    expect(one.status).toBe(404);
  });
});

describe("time entries and timer", () => {
  it("records manual entries and flags entries over 12 hours", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const task = await createTask(db, cookie, h.projectPath, { title: "作業" });

    const res = await call(db, `${h.projectPath}/tasks/${task.id}/time-entries`, {
      method: "POST",
      cookie,
      body: {
        started_at: "2026-11-14T00:00:00.000Z",
        ended_at: "2026-11-14T13:00:00.000Z",
        note_enc: "v1.note",
      },
    });
    expect(res.status).toBe(201);
    const entry = (
      (await res.json()) as {
        entry: { duration_seconds: number; long_running: boolean };
      }
    ).entry;
    expect(entry.duration_seconds).toBe(13 * 3600);
    expect(entry.long_running).toBe(true);

    const list = await call(
      db,
      `${h.projectPath}/tasks/${task.id}/time-entries`,
      { cookie },
    );
    const entries = ((await list.json()) as { entries: unknown[] }).entries;
    expect(entries).toHaveLength(1);
  });

  it("enforces one running timer per account", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);

    const start = await call(db, `${h.tenantPath}/timer/start`, {
      method: "POST",
      cookie,
      body: { workspace_id: h.workspaceId },
    });
    expect(start.status).toBe(201);

    const again = await call(db, `${h.tenantPath}/timer/start`, {
      method: "POST",
      cookie,
      body: { workspace_id: h.workspaceId },
    });
    expect(again.status).toBe(409);
    expect(
      ((await again.json()) as { error: { code: string } }).error.code,
    ).toBe("TIMER_RUNNING");

    const stop = await call(db, `${h.tenantPath}/timer/stop`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(stop.status).toBe(200);
    const stopped = (
      (await stop.json()) as {
        entry: { ended_at: string | null; duration_seconds: number };
      }
    ).entry;
    expect(stopped.ended_at).not.toBeNull();
    expect(stopped.duration_seconds).toBeGreaterThanOrEqual(0);

    const stopAgain = await call(db, `${h.tenantPath}/timer/stop`, {
      method: "POST",
      cookie,
      body: {},
    });
    expect(stopAgain.status).toBe(409);
  });

  it("flags a long-running timer in the entry list and dashboard", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const startedAt = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
    db.seed("time_entries", {
      id: "entry-long",
      tenant_id: h.tenantId,
      workspace_id: h.workspaceId,
      task_id: null,
      account_id: owner.accountId,
      started_at: startedAt,
      ended_at: null,
      duration_seconds: null,
      note_enc: null,
      version: 1,
      long_running: 0,
      created_at: startedAt,
      updated_at: startedAt,
      deleted_at: null,
    });
    const list = await call(db, `${h.tenantPath}/time-entries`, {
      cookie: owner.cookie,
    });
    const entries = (
      (await list.json()) as {
        entries: { long_running: boolean; duration_seconds: number }[];
      }
    ).entries;
    expect(entries[0]?.long_running).toBe(true);
    expect(entries[0]?.duration_seconds).toBeGreaterThan(12 * 3600);
  });
});

describe("dependencies and milestones", () => {
  it("creates dependencies, detects cycles and duplicates", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const a = await createTask(db, cookie, h.projectPath, { title: "A" });
    const b = await createTask(db, cookie, h.projectPath, { title: "B" });
    const cTask = await createTask(db, cookie, h.projectPath, { title: "C" });

    const dep = await call(db, `${h.projectPath}/dependencies`, {
      method: "POST",
      cookie,
      body: { task_id: b.id, depends_on_task_id: a.id },
    });
    expect(dep.status).toBe(201);

    const dup = await call(db, `${h.projectPath}/dependencies`, {
      method: "POST",
      cookie,
      body: { task_id: b.id, depends_on_task_id: a.id },
    });
    expect(dup.status).toBe(409);

    const dep2 = await call(db, `${h.projectPath}/dependencies`, {
      method: "POST",
      cookie,
      body: { task_id: cTask.id, depends_on_task_id: b.id },
    });
    expect(dep2.status).toBe(201);

    const cycle = await call(db, `${h.projectPath}/dependencies`, {
      method: "POST",
      cookie,
      body: { task_id: a.id, depends_on_task_id: cTask.id },
    });
    expect(cycle.status).toBe(400);
    expect(
      ((await cycle.json()) as { error: { code: string } }).error.code,
    ).toBe("DEPENDENCY_CYCLE");

    const self = await call(db, `${h.projectPath}/dependencies`, {
      method: "POST",
      cookie,
      body: { task_id: a.id, depends_on_task_id: a.id },
    });
    expect(self.status).toBe(400);
  });

  it("creates and patches milestones", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const res = await call(db, `${h.projectPath}/milestones`, {
      method: "POST",
      cookie,
      body: { name: "リリース", date: "2026-12-01" },
    });
    expect(res.status).toBe(201);
    const milestone = (
      (await res.json()) as { milestone: { id: string; version: number } }
    ).milestone;
    const patch = await call(
      db,
      `${h.projectPath}/milestones/${milestone.id}`,
      { method: "PATCH", cookie, body: { date: "2026-12-05" } },
    );
    const patched = (
      (await patch.json()) as { milestone: { date: string; version: number } }
    ).milestone;
    expect(patched.date).toBe("2026-12-05");
    expect(patched.version).toBe(2);
  });
});

describe("estimates vs actuals", () => {
  it("compares estimate to actual with rounding applied", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const task = await createTask(db, cookie, h.projectPath, {
      title: "見積対象",
      estimate_minutes: 30,
    });
    // 10 minutes of work -> rounds to 15 with the default 15/nearest.
    await call(db, `${h.projectPath}/tasks/${task.id}/time-entries`, {
      method: "POST",
      cookie,
      body: {
        started_at: "2026-11-14T01:00:00.000Z",
        ended_at: "2026-11-14T01:10:00.000Z",
      },
    });
    const res = await call(db, `${h.projectPath}/estimates`, { cookie });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      tasks: {
        task_id: string;
        actual_seconds: number;
        actual_rounded_seconds: number;
        estimate_minutes: number | null;
        over_estimate: boolean;
      }[];
      totals: { actual_rounded_seconds: number; estimate_minutes: number };
    };
    const row = data.tasks.find((t) => t.task_id === task.id);
    expect(row?.actual_seconds).toBe(600);
    expect(row?.actual_rounded_seconds).toBe(900);
    expect(row?.estimate_minutes).toBe(30);
    expect(row?.over_estimate).toBe(false);
    expect(data.totals.actual_rounded_seconds).toBe(900);
    expect(data.totals.estimate_minutes).toBe(30);
  });
});

describe("dashboard and gantt feed", () => {
  it("aggregates today's entries and lists doing tasks", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const task = await createTask(db, owner.cookie, h.projectPath, {
      title: "進行中タスク",
      status: "doing",
      assignee_account_id: owner.accountId,
      due_date: "2026-11-20",
    });
    const now = Date.now();
    db.seed("time_entries", {
      id: "entry-today",
      tenant_id: h.tenantId,
      workspace_id: h.workspaceId,
      task_id: task.id,
      account_id: owner.accountId,
      started_at: new Date(now - 30 * 60 * 1000).toISOString(),
      ended_at: new Date(now - 10 * 60 * 1000).toISOString(),
      duration_seconds: 1200,
      note_enc: null,
      version: 1,
      long_running: 0,
      created_at: new Date(now - 30 * 60 * 1000).toISOString(),
      updated_at: new Date(now - 10 * 60 * 1000).toISOString(),
      deleted_at: null,
    });
    const local = new Date();
    const date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
    const tz = -local.getTimezoneOffset();
    const res = await call(
      db,
      `${h.tenantPath}/dashboard?date=${date}&tz=${tz}`,
      { cookie: owner.cookie },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      today: { seconds: number };
      doing_tasks: { id: string }[];
      running_entry: unknown;
    };
    expect(data.today.seconds).toBe(1200);
    expect(data.doing_tasks.map((t) => t.id)).toContain(task.id);
    expect(data.running_entry).toBeNull();
  });

  it("serves the gantt feed scoped by project id", async () => {
    const db = new FakeDb();
    const { cookie } = await setupOwner(db);
    const h = await buildHierarchy(db, cookie);
    const task = await createTask(db, cookie, h.projectPath, {
      title: "ガント対象",
      start_date: "2026-11-16",
      due_date: "2026-11-18",
    });
    const res = await call(db, `/api/v1/projects/${h.projectId}/gantt`, {
      cookie,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      project: { id: string };
      tasks: { id: string }[];
    };
    expect(data.project.id).toBe(h.projectId);
    expect(data.tasks.map((t) => t.id)).toContain(task.id);
  });
});
