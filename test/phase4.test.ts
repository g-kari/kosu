/**
 * Phase 4 tests: integration connections, manual sync (stubbed fetch),
 * inbound webhooks (HMAC), task links, imports, iCal feeds, mail
 * inbound, MCP over JSON-RPC, Slack notification fan-out and the
 * tenant export.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
  listConnections,
  loadProjectRowLoose,
  runConnectionSync,
  type IntegrationFetcher,
} from "../src/integrations";
import { FakeDb, makeEnv } from "./fake-db";
import {
  ORIGIN,
  buildHierarchy,
  call,
  setupOwner,
  setupSecondUser,
} from "./phase2-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface Setup {
  db: FakeDb;
  accountId: string;
  cookie: string;
  tenantId: string;
  workspaceId: string;
  teamId: string;
  projectId: string;
  projectPath: string;
  tenantPath: string;
}

async function setup(): Promise<Setup> {
  const db = new FakeDb();
  const owner = await setupOwner(db);
  const h = await buildHierarchy(db, owner.cookie);
  return { db, ...owner, ...h };
}

async function createConnection(
  s: Setup,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, any> }> {
  const res = await call(s.db, `${s.tenantPath}/integrations`, {
    method: "POST",
    cookie: s.cookie,
    body,
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function createTask(
  s: Setup,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const res = await call(s.db, `${s.projectPath}/tasks`, {
    method: "POST",
    cookie: s.cookie,
    body,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as any).task;
}

async function listTasks(s: Setup): Promise<any[]> {
  const res = await call(s.db, `${s.projectPath}/tasks`, { cookie: s.cookie });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).tasks;
}

function stubFetch(handler: (url: string) => unknown) {
  const calls: { url: string; body?: string }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    const payload = handler(url);
    return {
      status: 200,
      ok: true,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

describe("integration connections", () => {
  it("creates connections, hides secrets, and reports status", async () => {
    const s = await setup();
    const gh = await createConnection(s, {
      provider: "github",
      name: "widgets repo",
      project_id: s.projectId,
      config: { repo: "acme/widgets" },
      token: "ghp_secret_token",
    });
    expect(gh.status).toBe(201);
    expect(gh.json.integration.status).toBe("connected");
    expect(gh.json.integration.has_secret).toBe(true);
    expect(gh.json.integration.config.repo).toBe("acme/widgets");
    // The token never comes back; the webhook secret comes back once.
    expect(JSON.stringify(gh.json)).not.toContain("ghp_secret_token");
    expect(gh.json.webhook_secret).toMatch(/^whsec_/);
    expect(gh.json.webhook_path).toBe(
      `/webhooks/github/${gh.json.integration.id}`,
    );

    const ln = await createConnection(s, {
      provider: "linear",
      name: "linear (no token)",
      project_id: s.projectId,
      config: {},
    });
    expect(ln.status).toBe(201);
    expect(ln.json.integration.status).toBe("not_connected");
    expect(ln.json.integration.has_secret).toBe(false);

    const list = await call(s.db, `${s.tenantPath}/integrations`, {
      cookie: s.cookie,
    });
    const items = ((await list.json()) as any).integrations;
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).not.toContain("ghp_secret_token");

    // Patch: disable, then delete.
    const id = gh.json.integration.id;
    const patched = await call(s.db, `${s.tenantPath}/integrations/${id}`, {
      method: "PATCH",
      cookie: s.cookie,
      body: { enabled: false },
    });
    expect(((await patched.json()) as any).integration.status).toBe(
      "disabled",
    );
    const del = await call(s.db, `${s.tenantPath}/integrations/${id}`, {
      method: "DELETE",
      cookie: s.cookie,
    });
    expect(del.status).toBe(200);
    const after = await call(s.db, `${s.tenantPath}/integrations`, {
      cookie: s.cookie,
    });
    expect(((await after.json()) as any).integrations).toHaveLength(1);
  });

  it("rejects connection creation by a non-admin member", async () => {
    const s = await setup();
    const second = await setupSecondUser(s.db);
    s.db.seed("tenant_members", {
      tenant_id: s.tenantId,
      account_id: second.accountId,
      role: "member",
      created_at: "2026-11-14T00:00:00.000Z",
    });
    const res = await call(s.db, `${s.tenantPath}/integrations`, {
      method: "POST",
      cookie: second.cookie,
      body: { provider: "slack", name: "x", config: {} },
    });
    expect(res.status).toBe(403);
  });

  it("validates provider config (github repo is required)", async () => {
    const s = await setup();
    const bad = await createConnection(s, {
      provider: "github",
      name: "bad",
      config: {},
    });
    expect(bad.status).toBe(400);
  });
});

describe("manual sync", () => {
  it("records a truthful error run when no token is configured", async () => {
    const s = await setup();
    const ln = await createConnection(s, {
      provider: "linear",
      name: "linear",
      project_id: s.projectId,
      config: {},
    });
    const id = ln.json.integration.id;
    const res = await call(s.db, `${s.tenantPath}/integrations/${id}/sync`, {
      method: "POST",
      cookie: s.cookie,
      body: {},
    });
    expect(res.status).toBe(200);
    const run = ((await res.json()) as any).sync_run;
    expect(run.status).toBe("error");
    expect(run.message).toContain("Not connected");
  });

  it("imports GitHub issues once (dedupe on re-sync)", async () => {
    const s = await setup();
    stubFetch((url) => {
      if (url.includes("api.github.com")) {
        return [
          {
            number: 7,
            title: "Bug A",
            html_url: "https://github.com/acme/widgets/issues/7",
            state: "open",
            updated_at: "2026-11-14T00:00:00Z",
          },
          {
            number: 8,
            title: "PR disguised as issue",
            html_url: "https://github.com/acme/widgets/pull/8",
            state: "open",
            pull_request: { url: "https://api.github.com/x" },
          },
        ];
      }
      return {};
    });
    const gh = await createConnection(s, {
      provider: "github",
      name: "widgets",
      project_id: s.projectId,
      config: { repo: "acme/widgets" },
      token: "ghp_x",
    });
    const id = gh.json.integration.id;
    const sync1 = await call(s.db, `${s.tenantPath}/integrations/${id}/sync`, {
      method: "POST",
      cookie: s.cookie,
      body: {},
    });
    const run1 = ((await sync1.json()) as any).sync_run;
    expect(run1.status).toBe("ok");
    expect(run1.stats.created).toBe(1);
    const tasks = await listTasks(s);
    expect(tasks.map((t) => t.title)).toEqual(["Bug A"]);

    const sync2 = await call(s.db, `${s.tenantPath}/integrations/${id}/sync`, {
      method: "POST",
      cookie: s.cookie,
      body: {},
    });
    const run2 = ((await sync2.json()) as any).sync_run;
    expect(run2.stats.created).toBe(0);
    expect(await listTasks(s)).toHaveLength(1);
  });

  it("imports Linear issues with identifier titles", async () => {
    const s = await setup();
    stubFetch((url) => {
      if (url.includes("api.linear.app")) {
        return {
          data: {
            issues: {
              nodes: [
                {
                  id: "lin-1",
                  identifier: "ENG-1",
                  title: "Fix it",
                  url: "https://linear.app/acme/issue/ENG-1",
                  updatedAt: "2026-11-14T00:00:00.000Z",
                  state: { type: "started" },
                  team: { id: "team-1" },
                  project: null,
                },
              ],
            },
          },
        };
      }
      return {};
    });
    const ln = await createConnection(s, {
      provider: "linear",
      name: "linear",
      project_id: s.projectId,
      config: {},
      token: "lin_api_x",
    });
    const res = await call(
      s.db,
      `${s.tenantPath}/integrations/${ln.json.integration.id}/sync`,
      { method: "POST", cookie: s.cookie, body: {} },
    );
    const run = ((await res.json()) as any).sync_run;
    expect(run.status).toBe("ok");
    const tasks = await listTasks(s);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("ENG-1: Fix it");
    expect(tasks[0].status).toBe("doing");
  });

  it("imports TimeCrowd tasks and entries via the service layer", async () => {
    const s = await setup();
    const tc = await createConnection(s, {
      provider: "timecrowd",
      name: "tc",
      project_id: s.projectId,
      config: {},
      token: "tc_token",
    });
    const env = makeEnv(s.db);
    const connections = await listConnections(env as any, s.tenantId);
    const conn = connections.find((x) => x.id === tc.json.integration.id)!;
    const project = await loadProjectRowLoose(env as any, s.projectId);
    const fetcher: IntegrationFetcher = async (url) => {
      const payload = url.endsWith("/tasks")
        ? [{ id: 11, title: "TC Task" }]
        : [
            {
              id: 21,
              task_id: 11,
              started_at: "2026-11-10T09:00:00Z",
              stopped_at: "2026-11-10T10:00:00Z",
              duration: 3600,
            },
          ];
      return {
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
    const run = await runConnectionSync(
      env as any,
      conn,
      project,
      s.accountId,
      "manual",
      fetcher,
    );
    expect(run.status).toBe("ok");
    const tasks = await listTasks(s);
    expect(tasks.map((t) => t.title)).toContain("TC Task");
    const entries = s.db.rows("time_entries");
    expect(entries).toHaveLength(1);
    expect(entries[0]!["duration_seconds"]).toBe(3600);
    // Second run: everything is a duplicate.
    const run2 = await runConnectionSync(
      env as any,
      conn,
      project,
      s.accountId,
      "manual",
      fetcher,
    );
    expect(run2.status).toBe("ok");
    expect(s.db.rows("time_entries")).toHaveLength(1);
  });
});

describe("inbound webhooks", () => {
  it("verifies the GitHub signature, upserts issues, completes PR-linked tasks", async () => {
    const s = await setup();
    const gh = await createConnection(s, {
      provider: "github",
      name: "widgets",
      project_id: s.projectId,
      config: { repo: "acme/widgets" },
      token: "ghp_x",
    });
    const connectionId = gh.json.integration.id;
    const secret = gh.json.webhook_secret as string;

    const post = async (payload: unknown, sig?: string) => {
      const body = JSON.stringify(payload);
      const signature = sig ?? (await hmacHex(secret, body));
      return app.request(
        `${ORIGIN}/webhooks/github/${connectionId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${signature}`,
            "x-github-event": "issues",
          },
          body,
        },
        makeEnv(s.db),
      );
    };

    // Bad signature is rejected.
    const bad = await post({ action: "opened", issue: {} }, "deadbeef");
    expect(bad.status).toBe(401);

    // Issue opened -> task created.
    const opened = await post({
      action: "opened",
      repository: { full_name: "acme/widgets" },
      issue: {
        number: 42,
        title: "Webhook bug",
        html_url: "https://github.com/acme/widgets/issues/42",
        state: "open",
        updated_at: "2026-11-14T00:00:00Z",
      },
    });
    expect(opened.status).toBe(200);
    let tasks = await listTasks(s);
    expect(tasks.map((t) => t.title)).toEqual(["Webhook bug"]);

    // Link a task to a PR, then merge the PR via webhook.
    const task = await createTask(s, { title: "PR work" });
    const link = await call(s.db, `${s.projectPath}/tasks/${task.id}/links`, {
      method: "POST",
      cookie: s.cookie,
      body: {
        kind: "github_pr",
        url: "https://github.com/acme/widgets/pull/9",
      },
    });
    expect(link.status).toBe(201);
    const merged = await post({
      action: "closed",
      repository: { full_name: "acme/widgets" },
      pull_request: {
        number: 9,
        html_url: "https://github.com/acme/widgets/pull/9",
        merged: true,
      },
    });
    expect(merged.status).toBe(200);
    tasks = await listTasks(s);
    const prTask = tasks.find((t) => t.title === "PR work");
    expect(prTask.status).toBe("done");
  });

  it("verifies the Linear signature and upserts issues", async () => {
    const s = await setup();
    const ln = await createConnection(s, {
      provider: "linear",
      name: "linear",
      project_id: s.projectId,
      config: {},
      token: "lin_x",
    });
    const connectionId = ln.json.integration.id;
    const secret = ln.json.webhook_secret as string;
    const payload = {
      action: "create",
      type: "Issue",
      data: {
        id: "lin-9",
        identifier: "ENG-9",
        title: "From webhook",
        url: "https://linear.app/acme/issue/ENG-9",
        updatedAt: "2026-11-14T00:00:00.000Z",
        state: { type: "unstarted" },
      },
    };
    const body = JSON.stringify(payload);
    const signature = await hmacHex(secret, body);
    const res = await app.request(
      `${ORIGIN}/webhooks/linear/${connectionId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": signature,
        },
        body,
      },
      makeEnv(s.db),
    );
    expect(res.status).toBe(200);
    const tasks = await listTasks(s);
    expect(tasks.map((t) => t.title)).toEqual(["ENG-9: From webhook"]);
  });
});

describe("task links", () => {
  it("adds, lists and deletes links; external ids are unique per tenant", async () => {
    const s = await setup();
    const task = await createTask(s, { title: "Link me" });
    const slack = await call(
      s.db,
      `${s.projectPath}/tasks/${task.id}/links`,
      {
        method: "POST",
        cookie: s.cookie,
        body: {
          kind: "slack",
          url: "https://acme.slack.com/archives/C1/p1700000000000000",
          title: "Slack thread",
        },
      },
    );
    expect(slack.status).toBe(201);
    const other = await createTask(s, { title: "Other" });
    const dupe = await call(
      s.db,
      `${s.projectPath}/tasks/${other.id}/links`,
      {
        method: "POST",
        cookie: s.cookie,
        body: {
          kind: "slack",
          url: "https://acme.slack.com/archives/C1/p1700000000000000",
        },
      },
    );
    expect(dupe.status).toBe(400);
    const list = await call(
      s.db,
      `${s.projectPath}/tasks/${task.id}/links`,
      { cookie: s.cookie },
    );
    const links = ((await list.json()) as any).links;
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe("slack");
    const del = await call(
      s.db,
      `${s.projectPath}/tasks/${task.id}/links/${links[0].id}`,
      { method: "DELETE", cookie: s.cookie },
    );
    expect(del.status).toBe(200);
  });

  it("rejects unknown link kinds and non-http URLs", async () => {
    const s = await setup();
    const task = await createTask(s, { title: "T" });
    const bad = await call(s.db, `${s.projectPath}/tasks/${task.id}/links`, {
      method: "POST",
      cookie: s.cookie,
      body: { kind: "carrier_pigeon", url: "https://example.com" },
    });
    expect(bad.status).toBe(400);
    const badUrl = await call(
      s.db,
      `${s.projectPath}/tasks/${task.id}/links`,
      {
        method: "POST",
        cookie: s.cookie,
        body: { kind: "url", url: "javascript:alert(1)" },
      },
    );
    expect(badUrl.status).toBe(400);
  });
});

describe("imports", () => {
  it("imports a Toggl CSV once and skips duplicates on re-import", async () => {
    const s = await setup();
    const csv = [
      "User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags",
      "A,a@example.com,,Proj,Task A,,No,2026-11-10,09:00:00,2026-11-10,10:30:00,1:30:00,",
      "A,a@example.com,,Proj,Task A,,No,2026-11-10,11:00:00,2026-11-10,11:45:00,0:45:00,",
    ].join("\n");
    const post = () =>
      call(s.db, `${s.projectPath}/imports`, {
        method: "POST",
        cookie: s.cookie,
        body: { format: "toggl", content: csv },
      });
    const first = await post();
    expect(first.status).toBe(200);
    const stats1 = ((await first.json()) as any).stats;
    expect(stats1.created_entries).toBe(2);
    expect(stats1.created_tasks).toBe(1);
    const second = await post();
    const stats2 = ((await second.json()) as any).stats;
    expect(stats2.created_entries).toBe(0);
    expect(stats2.skipped_duplicates).toBe(2);
  });

  it("imports ActivityWatch JSON as per-app draft entries", async () => {
    const s = await setup();
    const doc = JSON.stringify({
      buckets: {
        "aw-watcher-window_host": {
          events: [
            {
              timestamp: "2026-11-10T09:00:00.000Z",
              duration: 600,
              data: { app: "Code", title: "main.ts" },
            },
            {
              timestamp: "2026-11-10T09:10:00.000Z",
              duration: 10,
              data: { app: "Code", title: "blink" },
            },
          ],
        },
      },
    });
    const res = await call(s.db, `${s.projectPath}/imports`, {
      method: "POST",
      cookie: s.cookie,
      body: { format: "activitywatch", content: doc },
    });
    expect(res.status).toBe(200);
    const stats = ((await res.json()) as any).stats;
    expect(stats.created_entries).toBe(1); // the 10s event is below the floor
    const tasks = await listTasks(s);
    expect(tasks.map((t) => t.title)).toEqual(["ActivityWatch: Code"]);
  });
});

describe("ical feeds and mail inbound", () => {
  it("issues a feed, serves due tasks as ICS, and stops after revoke", async () => {
    const s = await setup();
    await createTask(s, { title: "Dated task", due_date: "2026-11-20" });
    await createTask(s, { title: "Undated task" });
    const created = await call(s.db, `${s.tenantPath}/ical-feeds`, {
      method: "POST",
      cookie: s.cookie,
      body: { label: "main" },
    });
    expect(created.status).toBe(201);
    const token = ((await created.json()) as any).token as string;
    expect(token).toMatch(/^ical_/);

    const feed = await app.request(
      `${ORIGIN}/feeds/ical/${token}.ics`,
      {},
      makeEnv(s.db),
    );
    expect(feed.status).toBe(200);
    const text = await feed.text();
    expect(text).toContain("BEGIN:VEVENT");
    expect(text).toContain("Dated task");
    expect(text).not.toContain("Undated task");

    const bad = await app.request(
      `${ORIGIN}/feeds/ical/ical_nope.ics`,
      {},
      makeEnv(s.db),
    );
    expect(bad.status).toBe(404);

    const list = await call(s.db, `${s.tenantPath}/ical-feeds`, {
      cookie: s.cookie,
    });
    const feedId = ((await list.json()) as any).ical_feeds[0].id;
    const del = await call(s.db, `${s.tenantPath}/ical-feeds/${feedId}`, {
      method: "DELETE",
      cookie: s.cookie,
    });
    expect(del.status).toBe(200);
    const gone = await app.request(
      `${ORIGIN}/feeds/ical/${token}.ics`,
      {},
      makeEnv(s.db),
    );
    expect(gone.status).toBe(404);
  });

  it("creates tasks from inbound mail posts", async () => {
    const s = await setup();
    const created = await call(
      s.db,
      `${s.projectPath}/mail-inbound-tokens`,
      { method: "POST", cookie: s.cookie, body: { label: "inbox" } },
    );
    expect(created.status).toBe(201);
    const token = ((await created.json()) as any).token as string;

    const post = (t: string, body: unknown) =>
      app.request(
        `${ORIGIN}/inbound/mail/${t}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        makeEnv(s.db),
      );
    const ok = await post(token, {
      subject: "メールで作るタスク",
      from: "someone@example.com",
      text: "body",
    });
    expect(ok.status).toBe(201);
    const tasks = await listTasks(s);
    expect(tasks.map((t) => t.title)).toEqual(["メールで作るタスク"]);

    const bad = await post("mail_nope", { subject: "x" });
    expect(bad.status).toBe(404);
  });
});

describe("MCP endpoint", () => {
  async function issueKey(s: Setup, scopes: string[]): Promise<string> {
    const res = await call(s.db, `${s.tenantPath}/api-keys`, {
      method: "POST",
      cookie: s.cookie,
      body: { name: "mcp", scopes },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).api_key as string;
  }

  async function rpc(
    s: Setup,
    apiKey: string | null,
    payload: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await call(s.db, "/mcp", {
      method: "POST",
      apiKey: apiKey ?? undefined,
      body: payload,
    });
    return { status: res.status, json: await res.json() };
  }

  it("requires auth and serves initialize + tools/list", async () => {
    const s = await setup();
    const anon = await rpc(s, null, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(anon.status).toBe(401);
    const key = await issueKey(s, ["read", "write"]);
    const init = await rpc(s, key, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(init.json.result.serverInfo.name).toBe("kosu");
    const list = await rpc(s, key, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const names = list.json.result.tools.map((t: any) => t.name);
    expect(names).toContain("kosu_create_task");
    expect(names).toContain("kosu_start_timer");
    expect(names).toContain("kosu_sync_integration");
  });

  it("creates and lists tasks through tools/call", async () => {
    const s = await setup();
    const key = await issueKey(s, ["read", "write"]);
    const created = await rpc(s, key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "kosu_create_task",
        arguments: {
          tenant_id: s.tenantId,
          project_id: s.projectId,
          title: "MCP task",
        },
      },
    });
    const content = JSON.parse(created.json.result.content[0].text);
    expect(content.task.title).toBe("MCP task");
    const listed = await rpc(s, key, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "kosu_list_tasks",
        arguments: { tenant_id: s.tenantId, project_id: s.projectId },
      },
    });
    const tasks = JSON.parse(listed.json.result.content[0].text).tasks;
    expect(tasks.map((t: any) => t.title)).toEqual(["MCP task"]);
  });

  it("blocks writes for a read-only key", async () => {
    const s = await setup();
    const key = await issueKey(s, ["read"]);
    const res = await rpc(s, key, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "kosu_create_task",
        arguments: {
          tenant_id: s.tenantId,
          project_id: s.projectId,
          title: "Nope",
        },
      },
    });
    expect(res.json.result.isError).toBe(true);
    expect(await listTasks(s)).toHaveLength(0);
  });
});

describe("slack notifications and export", () => {
  it("posts task assignment events to the tenant Slack webhook", async () => {
    const s = await setup();
    const second = await setupSecondUser(s.db);
    s.db.seed("tenant_members", {
      tenant_id: s.tenantId,
      account_id: second.accountId,
      role: "member",
      created_at: "2026-11-14T00:00:00.000Z",
    });
    await createConnection(s, {
      provider: "slack",
      name: "slack",
      config: {},
      token: "https://hooks.slack.com/services/T000/B000/XXX",
    });
    const calls = stubFetch(() => ({}));
    await createTask(s, {
      title: "Assigned work",
      assignee_account_id: second.accountId,
    });
    const slackCalls = calls.filter((x) =>
      x.url.includes("hooks.slack.com"),
    );
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0]!.body).toContain("Assigned work");
  });

  it("exports tenant data without secret columns (owner only)", async () => {
    const s = await setup();
    await createTask(s, { title: "Export me" });
    await createConnection(s, {
      provider: "github",
      name: "widgets",
      project_id: s.projectId,
      config: { repo: "acme/widgets" },
      token: "ghp_export_secret",
    });
    const res = await call(s.db, `${s.tenantPath}/export`, {
      cookie: s.cookie,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.format).toBe("kosu-tenant-export");
    expect(data.tasks.map((t: any) => t.title)).toContain("Export me");
    const conn = data.integration_connections[0];
    expect(conn.has_secret).toBe(true);
    expect(conn.secret_enc).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("ghp_export_secret");

    const second = await setupSecondUser(s.db);
    s.db.seed("tenant_members", {
      tenant_id: s.tenantId,
      account_id: second.accountId,
      role: "member",
      created_at: "2026-11-14T00:00:00.000Z",
    });
    const forbidden = await call(s.db, `${s.tenantPath}/export`, {
      cookie: second.cookie,
    });
    expect(forbidden.status).toBe(403);
  });

  it("reports the Google Calendar base status", async () => {
    const s = await setup();
    const res = await call(s.db, `${s.tenantPath}/google-calendar/status`, {
      cookie: s.cookie,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe("not_connected");
  });
});
