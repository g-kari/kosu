import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { call, setupOwner } from "./phase2-helpers";

/**
 * Phase 8: client performance. The shared stylesheet and the shared
 * app scripts ship as content-hashed external assets with immutable
 * caching, so repeat page views stop re-downloading and re-parsing
 * the same ~26 KB of CSS/JS inside every HTML response.
 */
describe("phase 8 client performance", () => {
  it("serves the hashed assets with immutable caching", async () => {
    const db = new FakeDb();
    const page = await call(db, "/");
    const html = await page.text();
    const href = /<link rel="stylesheet" href="([^"]+)">/.exec(html);
    expect(href).toBeTruthy();
    const cssUrl = (href as RegExpExecArray)[1]!;
    expect(cssUrl).toMatch(/^\/assets\/style-[0-9a-f]{8}\.css$/);
    const css = await call(db, cssUrl);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("immutable");
    expect(css.headers.get("cache-control")).toContain("max-age=31536000");
    const cssText = await css.text();
    expect(cssText.length).toBeGreaterThan(5000);
    const missing = await call(db, "/assets/style-00000000.css");
    expect(missing.status).toBe(404);
  });

  it("app pages reference the shared scripts instead of inlining them", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const page = await call(db, "/app", { cookie: owner.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/<script src="\/assets\/ui-[0-9a-f]{8}\.js"><\/script>/);
    expect(html).toMatch(/<script src="\/assets\/palette-[0-9a-f]{8}\.js"><\/script>/);
    // The shared core is not inlined anymore (window.KosuUI is defined
    // only by the external ui asset; page scripts merely reference it).
    expect(html).not.toContain("window.KosuUI =");
    // Dashboard HTML was 37,458 bytes before phase 8.
    expect(Buffer.byteLength(html)).toBeLessThan(20000);
    // Repeat-view weight: the ui asset itself is served immutably.
    const src = /<script src="(\/assets\/ui-[^"]+)"><\/script>/.exec(html);
    const js = await call(db, (src as RegExpExecArray)[1]!);
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toContain("window.KosuUI");
  });

  it("tasks page loads the vault script as an asset too", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const page = await call(db, "/app/tasks", { cookie: owner.cookie });
    const html = await page.text();
    expect(html).toMatch(/<script src="\/assets\/vault-[0-9a-f]{8}\.js"><\/script>/);
    // Tasks HTML was 54,880 bytes before phase 8.
    expect(Buffer.byteLength(html)).toBeLessThan(35000);
  });
});
