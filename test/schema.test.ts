import { describe, expect, it } from "vitest";
import sql0001 from "../migrations/0001_init.sql?raw";
import sql0002 from "../migrations/0002_hierarchy.sql?raw";
import sql0003 from "../migrations/0003_phase2.sql?raw";

// Applies the real migration files to an in-memory SQLite (Node's built-in
// node:sqlite) to prove 0001 + 0002 compose into the phase-1 schema.
// Skipped where node:sqlite is unavailable (older Node in some CI images).
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

async function openSqlite(): Promise<SqliteDb | null> {
  try {
    const specifier = "node:" + "sqlite";
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      DatabaseSync: new (path: string) => SqliteDb;
    };
    return new mod.DatabaseSync(":memory:");
  } catch {
    return null;
  }
}

describe("migrations", () => {
  it("0001 + 0002 produce the hierarchy schema", async () => {
    const db = await openSqlite();
    if (!db) return; // node:sqlite unavailable: nothing to verify against.
    db.exec(sql0001);
    db.exec(sql0002);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const tables = new Set(rows.map((r) => r.name));
    for (const expected of [
      "accounts",
      "tenants",
      "tenant_members",
      "workspaces",
      "workspace_members",
      "teams",
      "team_members",
      "projects",
      "project_members",
      "tasks",
      "time_entries",
      "links",
      "linear_sync",
      "github_sync",
      "audit_log",
      "api_keys",
      "oidc_states",
      "session_epochs",
    ]) {
      expect(tables.has(expected), `missing table ${expected}`).toBe(true);
    }
    // The 0001 workspace-membership table is replaced by per-level tables.
    expect(tables.has("members")).toBe(false);
    // FK integrity holds after the table replacement.
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toHaveLength(0);
    db.close();
  });

  it("0003 adds the phase-2 sync, calendar and invite schema", async () => {
    const db = await openSqlite();
    if (!db) return;
    db.exec(sql0001);
    db.exec(sql0002);
    db.exec(sql0003);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const tables = new Set(rows.map((r) => r.name));
    for (const expected of [
      "task_dependencies",
      "milestones",
      "sync_counters",
      "sync_changes",
      "sync_conflicts",
      "sync_devices",
      "account_keys",
      "tenant_settings",
      "workspace_settings",
      "tenant_calendar_days",
      "invites",
    ]) {
      expect(tables.has(expected), `missing table ${expected}`).toBe(true);
    }
    const columns = (table: string) =>
      new Set(
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      );
    for (const col of ["estimate_minutes", "version", "deleted_at"]) {
      expect(columns("tasks").has(col), `tasks.${col}`).toBe(true);
    }
    for (const col of ["version", "deleted_at", "long_running"]) {
      expect(columns("time_entries").has(col), `time_entries.${col}`).toBe(true);
    }
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    expect(violations).toHaveLength(0);
    db.close();
  });
});
