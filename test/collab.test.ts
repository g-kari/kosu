import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/tokens";
import { FakeDb } from "./fake-db";
import {
  buildHierarchy,
  call,
  setupOwner,
  setupSecondUser,
} from "./phase2-helpers";

describe("invites", () => {
  it("issues a link once and accepting adds the membership", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);

    const created = await call(db, `${h.tenantPath}/invites`, {
      method: "POST",
      cookie: owner.cookie,
      body: { level: "tenant", email: "second@example.com", role: "member" },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      invite: { id: string; status: string };
      accept_url: string;
    };
    expect(body.invite.status).toBe("pending");
    const token = body.accept_url.split("/invite/")[1] as string;
    expect(token).toBeTruthy();

    const second = await setupSecondUser(db);
    // Before accepting, the tenant is invisible to the second user.
    const before = await call(db, h.tenantPath, { cookie: second.cookie });
    expect(before.status).toBe(404);

    const preview = await call(
      db,
      `/api/v1/invites/preview?token=${encodeURIComponent(token)}`,
      { cookie: second.cookie },
    );
    expect(preview.status).toBe(200);

    const accept = await call(db, "/api/v1/invites/accept", {
      method: "POST",
      cookie: second.cookie,
      body: { token },
    });
    expect(accept.status).toBe(200);

    const after = await call(db, h.tenantPath, { cookie: second.cookie });
    expect(after.status).toBe(200);

    const again = await call(db, "/api/v1/invites/accept", {
      method: "POST",
      cookie: second.cookie,
      body: { token },
    });
    expect(again.status).toBe(409);
  });

  it("rejects expired and revoked invites, and non-admin creation", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const second = await setupSecondUser(db);

    // Non-admin (non-member) cannot create invites.
    const forbiddenCreate = await call(db, `${h.tenantPath}/invites`, {
      method: "POST",
      cookie: second.cookie,
      body: { level: "tenant", email: "x@example.com", role: "member" },
    });
    expect(forbiddenCreate.status).toBe(404);

    // Expired invite seeded directly (token hash only, as in production).
    const expiredToken = "inv_expired_test_token";
    db.seed("invites", {
      id: "invite-expired",
      tenant_id: h.tenantId,
      level: "tenant",
      workspace_id: null,
      team_id: null,
      project_id: null,
      email: "second@example.com",
      role: "member",
      token_hash: await sha256Hex(expiredToken),
      created_by_account_id: owner.accountId,
      expires_at: "2020-01-01T00:00:00.000Z",
      accepted_by_account_id: null,
      accepted_at: null,
      revoked_at: null,
      created_at: "2019-12-25T00:00:00.000Z",
    });
    const expired = await call(db, "/api/v1/invites/accept", {
      method: "POST",
      cookie: second.cookie,
      body: { token: expiredToken },
    });
    expect(expired.status).toBe(409);
    expect(
      ((await expired.json()) as { error: { code: string } }).error.code,
    ).toBe("INVITE_EXPIRED");

    // Revoke flow.
    const created = await call(db, `${h.tenantPath}/invites`, {
      method: "POST",
      cookie: owner.cookie,
      body: { level: "project", workspace_id: h.workspaceId, team_id: h.teamId, project_id: h.projectId, email: "second@example.com", role: "viewer" },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      invite: { id: string };
      accept_url: string;
    };
    const revoke = await call(
      db,
      `${h.tenantPath}/invites/${createdBody.invite.id}`,
      { method: "DELETE", cookie: owner.cookie },
    );
    expect(revoke.status).toBe(200);
    const token = createdBody.accept_url.split("/invite/")[1];
    const acceptRevoked = await call(db, "/api/v1/invites/accept", {
      method: "POST",
      cookie: second.cookie,
      body: { token },
    });
    expect(acceptRevoked.status).toBe(409);
  });

  it("validates roles per level", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const bad = await call(db, `${h.tenantPath}/invites`, {
      method: "POST",
      cookie: owner.cookie,
      body: { level: "tenant", email: "x@example.com", role: "owner" },
    });
    expect(bad.status).toBe(400);
  });
});

describe("settings and calendar", () => {
  it("round-trips tenant settings and restricts writes to admins", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const put = await call(db, `${h.tenantPath}/settings`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { rounding_minutes: 30, rounding_mode: "up", weekly_workdays: [1, 2, 3, 4] },
    });
    expect(put.status).toBe(200);
    const settings = (
      (await put.json()) as {
        settings: { rounding_minutes: number; rounding_mode: string; weekly_workdays: number[] };
      }
    ).settings;
    expect(settings.rounding_minutes).toBe(30);
    expect(settings.rounding_mode).toBe("up");
    expect(settings.weekly_workdays).toEqual([1, 2, 3, 4]);

    const get = await call(db, `${h.tenantPath}/settings`, {
      cookie: owner.cookie,
    });
    expect(get.status).toBe(200);
  });

  it("computes calendar ranges with weekly pattern and overrides", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    // 2026-11-14 is a Saturday, 2026-11-16 is a Monday.
    const range = await call(
      db,
      `${h.tenantPath}/calendar?from=2026-11-14&to=2026-11-16`,
      { cookie: owner.cookie },
    );
    expect(range.status).toBe(200);
    const days = (
      (await range.json()) as {
        days: { date: string; workday: boolean; kind: string }[];
      }
    ).days;
    expect(days.find((d) => d.date === "2026-11-14")?.workday).toBe(false);
    expect(days.find((d) => d.date === "2026-11-16")?.workday).toBe(true);

    const holiday = await call(db, `${h.tenantPath}/calendar/2026-11-16`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { kind: "holiday", note: "振替休日" },
    });
    expect(holiday.status).toBe(200);
    const range2 = await call(
      db,
      `${h.tenantPath}/calendar?from=2026-11-16&to=2026-11-16`,
      { cookie: owner.cookie },
    );
    const days2 = (
      (await range2.json()) as { days: { workday: boolean; kind: string }[] }
    ).days;
    expect(days2[0]?.workday).toBe(false);
    expect(days2[0]?.kind).toBe("holiday");

    const clear = await call(db, `${h.tenantPath}/calendar/2026-11-16`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(clear.status).toBe(200);
  });

  it("workspace rounding override wins over the tenant in estimates", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    // Tenant: no rounding. Workspace: 60 minutes, up.
    await call(db, `${h.tenantPath}/settings`, {
      method: "PUT",
      cookie: owner.cookie,
      body: { rounding_minutes: 0, rounding_mode: "nearest" },
    });
    const rounding = await call(
      db,
      `${h.tenantPath}/workspaces/${h.workspaceId}/rounding`,
      {
        method: "PUT",
        cookie: owner.cookie,
        body: { rounding_minutes: 60, rounding_mode: "up" },
      },
    );
    expect(rounding.status).toBe(200);
    expect(
      ((await rounding.json()) as { rounding: { minutes: number } }).rounding
        .minutes,
    ).toBe(60);

    const taskRes = await call(db, `${h.projectPath}/tasks`, {
      method: "POST",
      cookie: owner.cookie,
      body: { title: "対象", estimate_minutes: 30 },
    });
    const task = ((await taskRes.json()) as { task: { id: string } }).task;
    await call(db, `${h.projectPath}/tasks/${task.id}/time-entries`, {
      method: "POST",
      cookie: owner.cookie,
      body: {
        started_at: "2026-11-14T01:00:00.000Z",
        ended_at: "2026-11-14T01:10:00.000Z",
      },
    });
    const estimates = await call(db, `${h.projectPath}/estimates`, {
      cookie: owner.cookie,
    });
    const data = (await estimates.json()) as {
      rounding: { minutes: number; mode: string };
      tasks: { actual_seconds: number; actual_rounded_seconds: number }[];
    };
    expect(data.rounding.minutes).toBe(60);
    expect(data.tasks[0]?.actual_seconds).toBe(600);
    // 10 minutes rounded up to the workspace's 60-minute unit.
    expect(data.tasks[0]?.actual_rounded_seconds).toBe(3600);
  });
});
