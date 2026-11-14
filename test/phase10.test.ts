import { describe, expect, it } from "vitest";
import app from "../src/index";
import { STYLE } from "../src/routes/pages";
import { UI_SCRIPT } from "../src/routes/ui";
import { FakeDb, makeEnv } from "./fake-db";
import { ORIGIN, setupOwner } from "./phase2-helpers";

describe("phase 10: UI/UX improvements", () => {
  it("raises touch targets on small screens and widens table link hit areas", () => {
    expect(STYLE).toContain("min-height: 44px");
    expect(STYLE).toContain("min-height: 40px");
    expect(STYLE).toContain("td a { display: inline-block");
  });

  it("shared UI script has a busy indicator and toast feedback", () => {
    expect(UI_SCRIPT).toContain("busybar");
    expect(UI_SCRIPT).toContain("function toast");
    expect(UI_SCRIPT).toContain("setBusy");
  });

  it("tasks page rows are keyboard operable and the empty state offers creation", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const env = makeEnv(db);
    const page = await app.request(
      `${ORIGIN}/app/tasks`,
      { headers: { cookie: owner.cookie } },
      env,
    );
    const html = await page.text();
    expect(html).toContain("タスクがまだありません");
    expect(html).toContain("最初のタスクを作成");
    expect(html).toContain("tr.tabIndex = 0");
    expect(html).toContain('aria-label="コマンドパレット検索"');
    expect(html).toContain("タスクを作成しました");
    expect(html).toContain("タイマーを開始しました");
    const time = await app.request(
      `${ORIGIN}/app/time`,
      { headers: { cookie: owner.cookie } },
      env,
    );
    expect(await time.text()).toContain("工数を追加しました");
  });
});
