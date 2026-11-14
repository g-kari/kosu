import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { call, setupOwner } from "./phase2-helpers";

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
});
