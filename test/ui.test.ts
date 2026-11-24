import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import {
  buildHierarchy,
  call,
  setupOwner,
  setupSecondUser,
} from "./phase2-helpers";

describe("phase 6 Web UI", () => {
  it("serves the landing page with a login CTA when logged out", async () => {
    const db = new FakeDb();
    const page = await call(db, "/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Kosu");
    expect(html).toContain("/auth/login");
    expect(html).toContain("/terms");
    expect(html).toContain("/privacy");
  });

  it("serves the landing page with an open-app CTA when logged in", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const page = await call(db, "/", { cookie: owner.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("アプリを開く");
    expect(html).toContain('href="/app"');
  });

  it("redirects the app pages to login when logged out", async () => {
    const db = new FakeDb();
    for (const path of [
      "/app",
      "/app/tasks",
      "/app/time",
      "/app/gantt",
      "/app/reports",
      "/app/settings",
    ]) {
      const page = await call(db, path);
      expect(page.status, path).toBe(302);
      expect(page.headers.get("location"), path).toContain("/auth/login");
    }
  });

  it("renders the app pages with the sidebar shell when logged in", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const expected: Array<[string, string]> = [
      ["/app", "ダッシュボード"],
      ["/app/tasks", "タスク"],
      ["/app/time", "工数"],
      ["/app/gantt", "ガント"],
      ["/app/reports", "レポート"],
      ["/app/settings", "設定"],
    ];
    for (const [path, heading] of expected) {
      const page = await call(db, path, { cookie: owner.cookie });
      expect(page.status, path).toBe(200);
      const html = await page.text();
      expect(html, path).toContain(heading);
      expect(html, path).toContain("ctxTenant");
      expect(html, path).toContain("timerChip");
      expect(html, path).toContain("/app/tasks");
      expect(html, path).toContain("/app/reports");
    }
  });

  it("renders the task detail panel with the attachments UI (KAZAMI-346)", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const page = await call(db, "/app/tasks", { cookie: owner.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    // Section markup in the task detail panel
    expect(html).toContain("添付ファイル");
    expect(html).toContain('id="dAttachments"');
    expect(html).toContain('id="attFile"');
    expect(html).toContain('id="attUpload"');
    // The page script lists, uploads, downloads and deletes through the
    // permission-checked API only (no public or signed URLs).
    expect(html).toContain("/attachments");
    expect(html).toContain("x-file-name");
    expect(html).not.toContain("r2.dev");
    expect(html).not.toContain("X-Amz-Signature");
  });

  it("renders the dashboard with due-soon and project summary sections", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const page = await call(db, "/app", { cookie: owner.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("期限が近いタスク");
    expect(html).toContain("プロジェクト別サマリ");
    expect(html).toContain("同期ステータス");
  });
});

describe("GET /api/v1/me", () => {
  it("requires authentication", async () => {
    const db = new FakeDb();
    const res = await call(db, "/api/v1/me");
    expect(res.status).toBe(401);
  });

  it("returns an empty tenant list for an account without memberships", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const res = await call(db, "/api/v1/me", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      account: { id: string; default_tenant_id: string | null };
      tenants: unknown[];
    };
    expect(body.account.id).toBe(owner.accountId);
    expect(body.account.default_tenant_id).toBeNull();
    expect(body.tenants).toEqual([]);
  });

  it("lists the caller's tenants and picks the default", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const res = await call(db, "/api/v1/me", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      account: { default_tenant_id: string | null };
      tenants: Array<{ id: string; name: string; role: string }>;
    };
    expect(body.tenants.map((x) => x.id)).toContain(h.tenantId);
    expect(body.account.default_tenant_id).toBe(h.tenantId);
    const mine = body.tenants.find((x) => x.id === h.tenantId);
    expect(mine?.role).toBe("owner");
  });
});

describe("GET /api/v1/tenants/:tenantId/members", () => {
  it("lists tenant members with display names for members", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const res = await call(db, `${h.tenantPath}/members`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{
        account_id: string;
        display_name: string | null;
        role: string;
      }>;
    };
    const mine = body.members.find((m) => m.account_id === owner.accountId);
    expect(mine).toBeTruthy();
    expect(mine?.display_name).toBe("テストユーザー");
    expect(mine?.role).toBe("owner");
  });

  it("hides the member list from non-members and anonymous callers", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const h = await buildHierarchy(db, owner.cookie);
    const second = await setupSecondUser(db);
    const asSecond = await call(db, `${h.tenantPath}/members`, {
      cookie: second.cookie,
    });
    expect(asSecond.status).toBe(404);
    const anon = await call(db, `${h.tenantPath}/members`);
    expect(anon.status).toBe(401);
  });
});
