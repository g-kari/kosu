import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { call, setupOwner } from "./phase2-helpers";

// Regression guard: every inline <script> on the phase 6 pages
// must at least parse as JavaScript.
describe("inline script syntax", () => {
  it("parses all page scripts", async () => {
    const db = new FakeDb();
    const owner = await setupOwner(db);
    const paths = [
      "/",
      "/app",
      "/app/tasks",
      "/app/time",
      "/app/gantt",
      "/app/reports",
      "/app/settings",
      "/app/preferences",
      "/app/onboarding",
      "/app/conflicts",
    ];
    for (const path of paths) {
      const res = await call(db, path, { cookie: owner.cookie });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (m) => m[1] as string,
      );
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const code of scripts) {
        expect(() => new Function(code), path).not.toThrow();
      }
    }
  });
});
