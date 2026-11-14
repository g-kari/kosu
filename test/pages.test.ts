import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { call, setupOwner } from "./phase2-helpers";

describe("pages", () => {
  it("redirects /app to login when logged out and renders when logged in", async () => {
    const db = new FakeDb();
    const anon = await call(db, "/app");
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/auth/login");

    const owner = await setupOwner(db);
    const page = await call(db, "/app", { cookie: owner.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("ダッシュボード");
    expect(html).toContain("同期ステータス");
  });

  it("renders the gantt page shell for a logged-in user", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const page = await call(db, "/app/projects/abc/gantt", {
      cookie: owner.cookie,
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ガント");
  });

  it("shows a login prompt on the invite page when logged out", async () => {
    const db = new FakeDb();
    const page = await call(db, "/invite/inv_token123");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("ログイン");
    expect(html).toContain("/auth/login");
  });

  it("renders the integrations settings page for a logged-in user", async () => {
    const db = new FakeDb();
    const anon = await call(db, "/app/settings/integrations");
    expect(anon.status).toBe(302);
    const owner = await setupOwner(db);
    const page = await call(db, "/app/settings/integrations", {
      cookie: owner.cookie,
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("外部連携・MCP 設定");
    expect(html).toContain("iCal フィード");
    expect(html).toContain("メールでタスク作成");
  });

  it("renders the accept UI on the invite page when logged in", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const page = await call(db, "/invite/inv_token123", {
      cookie: owner.cookie,
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("この招待を受ける");
  });
});
