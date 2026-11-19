import { describe, expect, it } from "vitest";
import { STYLE, STYLE_URL } from "../src/routes/pages";
import { FakeDb } from "./fake-db";
import { call } from "./phase2-helpers";

describe("phase 11: design system", () => {
  it("serves the style guide with the real components", async () => {
    const db = new FakeDb();
    const res = await call(db, "/design-system");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("デザインシステム");
    expect(html).toContain("--brand");
    expect(html).toContain("#2456c8");
    expect(html).toContain('class="secondary"');
    expect(html).toContain('class="chip"');
    expect(html).toContain("toast static");
  });

  it("publishes the design tokens in the shared stylesheet", async () => {
    const db = new FakeDb();
    const res = await call(db, STYLE_URL);
    expect(res.status).toBe(200);
    const css = await res.text();
    expect(css).toContain("--brand: #2456c8");
    expect(css).toContain("--focus: #c96a00");
    expect(css).toContain("--gantt-milestone: #b97a1e");
    expect(css).toContain("--brand: #8fb0ff");
    expect(css).toContain("background: var(--brand)");
    expect(STYLE).toContain("--radius-control: 6px");
  });
});
