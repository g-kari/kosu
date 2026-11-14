import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { call, setupOwner } from "./phase2-helpers";

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((ch) => ch + ch).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Phase 7: modern-web compliance (CSP with per-request nonces,
 * prefers-reduced-motion, landmarks) and the design rules shared with
 * Hyo (no cards, no pastel colors, no emoji, no poem-like copy,
 * animations, diagram-first).
 */
describe("phase 7 web compliance + design rules", () => {
  it("serves HTML with a CSP whose nonce matches every inline script/style", async () => {
    const db = new FakeDb();
    const page = await call(db, "/");
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy");
    expect(csp).toBeTruthy();
    const m = /script-src 'nonce-([^']+)'/.exec(csp as string);
    expect(m).toBeTruthy();
    const nonce = (m as RegExpExecArray)[1];
    expect(csp).toContain(`style-src-elem 'nonce-${nonce}'`);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    const html = await page.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<style>");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("does not put a CSP on JSON responses", async () => {
    const db = new FakeDb();
    const page = await call(db, "/health");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBeNull();
  });

  it("landing page follows the design rules", async () => {
    const db = new FakeDb();
    const page = await call(db, "/");
    const html = await page.text();
    // Footer landmark on every shell page.
    expect(html).toContain('<footer class="site-footer">');
    // Reduced-motion support ships in the shared stylesheet.
    expect(html).toContain("prefers-reduced-motion");
    // Diagram-first: the landing carries the flow diagram.
    expect(html).toContain("流れ：工数とタスクを記録し");
    // No poem-like copy (the old tagline), no pastel tints.
    expect(html).not.toContain("静かに管理する");
    expect(html).toContain("工数とタスクを記録・集計する");
    for (const pastel of ["#eef4ff", "#b9cdf5", "#f4f6fd", "#fdf0f0", "#f0f7f0"]) {
      expect(html).not.toContain(pastel);
    }
  });

  it("app pages use landmarks, scoped table headers and no emoji", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const page = await call(db, "/app", { cookie: owner.cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<header class="topbar">');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('id="projChart"');
    expect(html).toContain('<th scope="col">');
    expect(html).toContain("timer-dot");
    for (const emoji of ["🔒", "⏱", "⚠"]) {
      expect(html).not.toContain(emoji);
    }
    const tasks = await call(db, "/app/tasks", { cookie: owner.cookie });
    const tasksHtml = await tasks.text();
    for (const emoji of ["🔒", "⏱", "⚠"]) {
      expect(tasksHtml).not.toContain(emoji);
    }
  });

  it("graphical colors meet the 3:1 non-text contrast ratio (numeric audit)", async () => {
    // Same dynamic-specifier pattern as schema.test.ts: the tsconfig only
    // carries Workers types, so node builtins are loaded indirectly.
    const fs = (await import("node:" + "fs")) as {
      readFileSync: (p: string, enc: string) => string;
    };
    const pages = fs.readFileSync("src/routes/pages.ts", "utf8");
    const ui = fs.readFileSync("src/routes/ui.ts", "utf8");
    // Focus indicator: at least 3:1 on both the light and dark backgrounds.
    const focus = /:focus-visible \{ outline: 3px solid (#[0-9a-f]{6})/.exec(pages);
    expect(focus).toBeTruthy();
    const focusColor = (focus as RegExpExecArray)[1]!;
    expect(contrast(focusColor, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrast(focusColor, "#14141c")).toBeGreaterThanOrEqual(3);
    // Gantt "todo" bar and milestone diamond in both renderers.
    for (const src of [pages, ui]) {
      const bar = /"#2456c8" : "(#[0-9a-f]{6})"/.exec(src);
      expect(bar).toBeTruthy();
      expect(contrast((bar as RegExpExecArray)[1]!, "#ffffff")).toBeGreaterThanOrEqual(3);
      const ms = /fill: "(#[0-9a-f]{6})" \}\);/.exec(src);
      expect(ms).toBeTruthy();
      expect(contrast((ms as RegExpExecArray)[1]!, "#ffffff")).toBeGreaterThanOrEqual(3);
    }
  });
});
