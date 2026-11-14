/**
 * Minimal server-rendered pages (phase 2). Data is loaded client-side
 * from the JSON API so the pages double as living API documentation.
 * No external assets; rendering is plain HTML/CSS/SVG.
 *
 *   GET /app                              dashboard
 *   GET /app/projects/:projectId/gantt    Gantt chart
 *   GET /invite/:token                    invite landing / accept
 */
import { Hono } from "hono";
import { readSessionAccountId } from "../session";
import type { Env, Variables } from "../types";
import type { Ctx } from "./http";

export const pageRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const STYLE = `
:root { color-scheme: light; }
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; color: #1a1a2e; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
.cards { display: flex; gap: 1rem; flex-wrap: wrap; }
.card { border: 1px solid #ccd; border-radius: 8px; padding: 1rem 1.25rem; min-width: 180px; }
.card .big { font-size: 1.8rem; font-weight: 700; }
.muted { color: #667; font-size: .85rem; }
table { border-collapse: collapse; width: 100%; }
td, th { border-bottom: 1px solid #e3e3ee; padding: .4rem .5rem; text-align: left; }
button { background: #2456c8; color: #fff; border: 0; border-radius: 6px; padding: .55rem 1.1rem; cursor: pointer; }
button.secondary { background: #eef; color: #2456c8; }
.warn { color: #b3541e; font-weight: 600; }
.err { color: #b00020; }
a { color: #2456c8; }
`;

function shell(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Kosu</title><style>${STYLE}</style></head>
<body>${body}<script>${script}</script></body></html>`;
}

async function loggedIn(c: Ctx): Promise<boolean> {
  const accountId = await readSessionAccountId(
    c.env,
    c.req.header("cookie") ?? null,
    c.req.url,
  );
  return accountId !== null;
}

pageRoutes.get("/app", async (c) => {
  if (!(await loggedIn(c))) return c.redirect("/auth/login", 302);
  const body = `
<h1>Kosu ダッシュボード</h1>
<p class="muted" id="who"></p>
<div class="cards">
  <div class="card"><div class="muted">今日の工数</div><div class="big" id="today">–</div><div class="muted" id="todayRaw"></div></div>
  <div class="card"><div class="muted">今週の工数（月曜始まり）</div><div class="big" id="week">–</div><div class="muted" id="weekRaw"></div></div>
  <div class="card"><div class="muted">同期ステータス</div><div class="big" id="syncSeq">–</div><div class="muted" id="syncInfo"></div></div>
</div>
<h2>実行中のタイマー</h2>
<div id="running"><p class="muted">なし</p></div>
<h2>進行中のタスク</h2>
<table><thead><tr><th>タスク</th><th>期限</th><th></th></tr></thead><tbody id="doing"></tbody></table>
<p id="msg" class="err"></p>`;
  const script = `
const $ = (id) => document.getElementById(id);
const fmt = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h + "時間" + String(m).padStart(2,"0") + "分"; };
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { const t = await r.text(); throw new Error(r.status + " " + t); }
  return r.json();
}
(async () => {
  try {
    const me = await api("/api/v1/me");
    const tenantId = me.account.default_tenant_id || (me.tenants[0] && me.tenants[0].id);
    $("who").textContent = (me.account.display_name || me.account.email || "") + " さん";
    const now = new Date();
    const date = now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0") + "-" + String(now.getDate()).padStart(2,"0");
    const tz = -now.getTimezoneOffset();
    const d = await api("/api/v1/tenants/" + tenantId + "/dashboard?date=" + date + "&tz=" + tz);
    $("today").textContent = fmt(d.today.rounded_seconds);
    $("todayRaw").textContent = "実測 " + fmt(d.today.seconds) + "（丸め適用後を表示）";
    $("week").textContent = fmt(d.week.rounded_seconds);
    $("weekRaw").textContent = "実測 " + fmt(d.week.seconds);
    if (d.running_entry) {
      const e = d.running_entry;
      $("running").innerHTML = "";
      const p = document.createElement("p");
      p.textContent = "開始 " + new Date(e.started_at).toLocaleTimeString() + " / 経過 " + fmt(e.duration_seconds || 0);
      if (e.long_running) { const s = document.createElement("span"); s.className = "warn"; s.textContent = " ⚠ 12時間を超えています。止め忘れていませんか？"; p.appendChild(s); }
      $("running").appendChild(p);
      const b = document.createElement("button");
      b.textContent = "タイマーを止める";
      b.onclick = async () => { await api("/api/v1/tenants/" + tenantId + "/timer/stop", { method: "POST" }); location.reload(); };
      $("running").appendChild(b);
    }
    const tbody = $("doing");
    for (const t of d.doing_tasks) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td"); td1.textContent = t.title;
      const td2 = document.createElement("td"); td2.textContent = t.due_date || "";
      const td3 = document.createElement("td");
      if (t.project_id) { const a = document.createElement("a"); a.href = "/app/projects/" + t.project_id + "/gantt"; a.textContent = "ガント"; td3.appendChild(a); }
      tr.append(td1, td2, td3); tbody.appendChild(tr);
    }
    if (d.doing_tasks.length === 0) { const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 3; td.className = "muted"; td.textContent = "進行中のタスクはありません"; tr.appendChild(td); tbody.appendChild(tr); }
    // Sync status: register this browser as a device once, then poll status.
    let deviceId = localStorage.getItem("kosu_device_id");
    if (!deviceId) {
      const reg = await api("/api/v1/sync/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Web ブラウザ", platform: navigator.platform || "web" }) });
      deviceId = reg.device.id;
      localStorage.setItem("kosu_device_id", deviceId);
    }
    const st = await api("/api/v1/tenants/" + tenantId + "/sync/status?device_id=" + encodeURIComponent(deviceId));
    $("syncSeq").textContent = "seq " + st.last_seq;
    $("syncInfo").textContent = "競合 " + st.open_conflicts + " 件 / 端末 " + st.devices.length + " 台";
    if (st.open_conflicts > 0) $("syncInfo").className = "warn";
  } catch (err) {
    $("msg").textContent = "読み込みに失敗しました: " + err.message;
  }
})();
`;
  return c.html(shell("ダッシュボード", body, script));
});

pageRoutes.get("/app/projects/:projectId/gantt", async (c) => {
  if (!(await loggedIn(c))) return c.redirect("/auth/login", 302);
  const projectId = c.req.param("projectId") as string;
  const body = `
<h1 id="title">ガント</h1>
<p class="muted"><a href="/app">← ダッシュボード</a></p>
<div id="chart" style="overflow-x:auto"></div>
<p id="msg" class="err"></p>`;
  const script = `
const projectId = ${jsonForScript(projectId)};
const $ = (id) => document.getElementById(id);
const DAY = 86400000, W = 16, ROW = 30;
const parse = (s) => { const [y,m,d] = s.split("-").map(Number); return Date.UTC(y, m-1, d); };
const fmtDay = (t) => { const d = new Date(t); return (d.getUTCMonth()+1) + "/" + d.getUTCDate(); };
(async () => {
  try {
    const r = await fetch("/api/v1/projects/" + projectId + "/gantt");
    if (!r.ok) throw new Error(r.status + " " + (await r.text()));
    const data = await r.json();
    $("title").textContent = "ガント: " + data.project.name;
    const tasks = data.tasks.filter(t => t.start_date || t.due_date);
    let min = Infinity, max = -Infinity;
    const touch = (s) => { if (s) { const t = parse(s); min = Math.min(min, t); max = Math.max(max, t); } };
    tasks.forEach(t => { touch(t.start_date); touch(t.due_date); });
    data.milestones.forEach(m => touch(m.date));
    touch(data.project.starts_on); touch(data.project.due_on);
    const today = new Date(); const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    if (!isFinite(min)) { min = todayUtc - 7*DAY; max = todayUtc + 30*DAY; }
    min = Math.min(min, todayUtc) - 3*DAY; max = Math.max(max, todayUtc) + 3*DAY;
    const days = Math.round((max - min)/DAY) + 1;
    const width = days * W + 220, height = (tasks.length + 2) * ROW + 30;
    const x = (t) => 220 + Math.round((t - min)/DAY) * W;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", width); svg.setAttribute("height", height);
    const el = (name, attrs, text) => { const e = document.createElementNS(ns, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text) e.textContent = text; svg.appendChild(e); return e; };
    for (let i = 0; i < days; i += 7) { el("text", { x: x(min + i*DAY), y: 14, "font-size": 10, fill: "#667" }, fmtDay(min + i*DAY)); }
    el("line", { x1: x(todayUtc), y1: 18, x2: x(todayUtc), y2: height, stroke: "#d33", "stroke-width": 1 });
    const rowOf = new Map();
    tasks.forEach((t, i) => {
      const y = 24 + i * ROW;
      rowOf.set(t.id, y);
      el("text", { x: 4, y: y + 16, "font-size": 12 }, t.title.length > 24 ? t.title.slice(0, 24) + "…" : t.title);
      const s = t.start_date ? parse(t.start_date) : parse(t.due_date);
      const e = t.due_date ? parse(t.due_date) + DAY : s + DAY;
      const color = t.status === "done" ? "#8a8" : t.status === "doing" ? "#2456c8" : "#99a";
      el("rect", { x: x(s), y: y + 5, width: Math.max(W, x(e) - x(s)), height: 14, rx: 3, fill: color });
      if (t.estimate_minutes) el("text", { x: x(e) + 4, y: y + 16, "font-size": 10, fill: "#667" }, "見積 " + t.estimate_minutes + "分");
    });
    data.dependencies.forEach(dep => {
      const from = tasks.find(t => t.id === dep.depends_on_task_id);
      const to = tasks.find(t => t.id === dep.task_id);
      if (!from || !to) return;
      const x1 = x((from.due_date ? parse(from.due_date) + DAY : parse(from.start_date) + DAY));
      const y1 = rowOf.get(from.id) + 12;
      const x2 = x(parse(to.start_date || to.due_date));
      const y2 = rowOf.get(to.id) + 12;
      el("path", { d: "M" + x1 + " " + y1 + " L" + (x1 + 8) + " " + y1 + " L" + (x1 + 8) + " " + y2 + " L" + x2 + " " + y2, stroke: "#666", fill: "none", "marker-end": "url(#arr)" });
    });
    const defs = document.createElementNS(ns, "defs");
    defs.innerHTML = '<marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="#666"/></marker>';
    svg.insertBefore(defs, svg.firstChild);
    data.milestones.forEach(m => {
      const mx = x(parse(m.date));
      el("path", { d: "M" + mx + " 20 l6 6 l-6 6 l-6 -6 z", fill: "#e8a33d" });
      el("text", { x: mx + 9, y: 30, "font-size": 11, fill: "#8a6414" }, m.name);
    });
    $("chart").appendChild(svg);
    if (tasks.length === 0) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "開始予定・期限のあるタスクがまだありません。"; $("chart").appendChild(p); }
  } catch (err) {
    $("msg").textContent = "読み込みに失敗しました: " + err.message;
  }
})();
`;
  return c.html(shell("ガント", body, script));
});

pageRoutes.get("/invite/:token", async (c) => {
  const token = c.req.param("token") as string;
  const isLoggedIn = await loggedIn(c);
  const body = isLoggedIn
    ? `
<h1>招待</h1>
<div id="detail"><p class="muted">読み込み中…</p></div>
<button id="accept" style="display:none">この招待を受ける</button>
<p id="msg"></p>`
    : `
<h1>招待</h1>
<p>この招待を受けるには、まずログインしてください。</p>
<p><a href="/auth/login">ログインする</a>（ログイン後、このページをもう一度開いてください）</p>`;
  const script = isLoggedIn
    ? `
const token = ${jsonForScript(token)};
const $ = (id) => document.getElementById(id);
async function api(path, opts) { const r = await fetch(path, opts); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.status); return r.json(); }
(async () => {
  try {
    const d = await api("/api/v1/invites/preview?token=" + encodeURIComponent(token));
    const inv = d.invite;
    $("detail").innerHTML = "";
    const p = document.createElement("p");
    p.textContent = inv.level + " への招待（ロール: " + inv.role + "） / 状態: " + inv.status + " / 期限: " + new Date(inv.expires_at).toLocaleString();
    $("detail").appendChild(p);
    if (inv.status === "pending") {
      $("accept").style.display = "";
      $("accept").onclick = async () => {
        try {
          await api("/api/v1/invites/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
          $("msg").textContent = "招待を受けました。";
          $("accept").style.display = "none";
        } catch (e) { $("msg").textContent = "失敗しました: " + e.message; $("msg").className = "err"; }
      };
    }
  } catch (e) { $("detail").textContent = "招待が見つかりません: " + e.message; }
})();
`
    : "";
  return c.html(shell("招待", body, script));
});
