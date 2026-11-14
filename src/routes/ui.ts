/**
 * Phase 6 Web UI: browser-first pages on top of the JSON API.
 *
 *   GET /              landing page (HTML). Clients that ask for
 *                      application/json only still get the JSON
 *                      service identity (the pre-phase-6 behaviour);
 *                      the same JSON also lives at /api/health.
 *   GET /app           dashboard
 *   GET /app/tasks     task list + detail (create/edit/delete,
 *                      subtasks, dependencies, labels, comments)
 *   GET /app/time      timer, manual entries, day/week views
 *   GET /app/gantt     gantt chart inside the app shell
 *   GET /app/reports   time report viewer + CSV/JSON/print export
 *   GET /app/settings  settings hub (profile, API keys, usage, links)
 *
 * Every page is a server-rendered shell whose data flows through the
 * existing /api/v1 JSON API — no API behaviour changes. Rendering is
 * plain HTML/CSS/inline JS with no external assets, reusing the shell
 * (theme, locale, command palette, service worker) from pages.ts.
 *
 * Encrypted fields (task descriptions, entry notes, comments) are
 * handled with an in-page implementation of the client vault wire
 * format (client/vault.js, `v1.<base64url(iv||ct)>` + PBKDF2-HMAC-
 * SHA256): the recovery code unwraps the account key locally and the
 * key is kept only in sessionStorage. The client/ library itself is
 * not served by the Worker (see PROGRESS phase 2), so the wire
 * format is re-implemented here and covered by the same interop
 * tests as the library.
 */
import { Hono } from "hono";
import { t, type Locale } from "../i18n";
import type { UserPrefs } from "../prefs";
import type { Env, Variables } from "../types";
import type { Ctx } from "./http";
import { prefsFor, sessionAccountId, shell } from "./pages";

export const uiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export const APP_VERSION = "0.8.1";

/** The service identity JSON (moved from `GET /`, kept for compat). */
export const SERVICE_IDENTITY = {
  name: "Kosu",
  service: "kosu",
  status: "ok",
  version: APP_VERSION,
};

/* ------------------------------------------------------------------ */
/* Shared client library (context, chrome, vault)                       */
/* ------------------------------------------------------------------ */

const UI_SCRIPT = `
window.KosuUI = (() => {
  const $ = (id) => document.getElementById(id);
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error((j && j.error && j.error.message) || ("HTTP " + r.status));
    }
    if (r.status === 204) return {};
    return r.json();
  }
  const jsonOpts = (method, body) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const pad = (n) => String(n).padStart(2, "0");
  function fmtHMS(s) {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 3600) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
  }
  function fmtHM(s) {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 3600) + "時間" + pad(Math.floor((s % 3600) / 60)) + "分";
  }
  function localDate(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function todayStr() { return localDate(new Date()); }
  function addDays(dateStr, n) {
    const parts = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + n));
    return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate());
  }
  function fillSelect(sel, items, value, labelFn) {
    sel.innerHTML = "";
    for (const item of items) {
      const o = document.createElement("option");
      o.value = value(item);
      o.textContent = labelFn(item);
      sel.appendChild(o);
    }
    return sel;
  }

  /* ---------------- context (tenant / workspace / project) -------- */
  let me = null;
  let ctx = null;
  let projectsCache = [];
  let membersCache = null;
  function saveCtx() {
    try { localStorage.setItem("kosu_ctx", JSON.stringify(ctx)); } catch (e) {}
  }
  function loadCtx() {
    try { return JSON.parse(localStorage.getItem("kosu_ctx") || "null"); } catch (e) { return null; }
  }
  async function listProjects(tenantId) {
    const out = [];
    const base = "/api/v1/tenants/" + tenantId;
    const wss = (await api(base + "/workspaces")).workspaces;
    for (const w of wss) {
      const teams = (await api(base + "/workspaces/" + w.id + "/teams")).teams;
      for (const tm of teams) {
        const ps = (await api(base + "/workspaces/" + w.id + "/teams/" + tm.id + "/projects")).projects;
        for (const p of ps) {
          out.push({
            tenantId, workspaceId: w.id, workspaceName: w.name,
            teamId: tm.id, teamName: tm.name,
            id: p.id, name: p.name, color: p.color,
            path: base + "/workspaces/" + w.id + "/teams/" + tm.id + "/projects/" + p.id,
          });
        }
      }
    }
    return out;
  }
  async function initContext() {
    me = await api("/api/v1/me");
    const saved = loadCtx();
    const tenantIds = me.tenants.map((x) => x.id);
    let tenantId = saved && tenantIds.indexOf(saved.tenantId) >= 0
      ? saved.tenantId
      : me.account.default_tenant_id;
    if (!tenantId) throw new Error("所属しているテナントがありません");
    projectsCache = await listProjects(tenantId);
    let project = null;
    if (saved) project = projectsCache.find((p) => p.id === saved.projectId) || null;
    if (!project) project = projectsCache[0] || null;
    ctx = project
      ? { tenantId, workspaceId: project.workspaceId, teamId: project.teamId, projectId: project.id }
      : { tenantId, workspaceId: null, teamId: null, projectId: null };
    saveCtx();
    return ctx;
  }
  function tenantPath(c) { c = c || ctx; return "/api/v1/tenants/" + c.tenantId; }
  function projectPath(c) {
    c = c || ctx;
    return tenantPath(c) + "/workspaces/" + c.workspaceId + "/teams/" + c.teamId + "/projects/" + c.projectId;
  }
  function currentProject() {
    return projectsCache.find((p) => p.id === (ctx && ctx.projectId)) || null;
  }
  async function members() {
    if (!membersCache) membersCache = (await api(tenantPath() + "/members")).members;
    return membersCache;
  }
  function memberName(id) {
    if (!id) return "（未割当）";
    const m = (membersCache || []).find((x) => x.account_id === id);
    return m ? (m.display_name || m.email || id) : id;
  }

  /* ---------------- chrome (context selectors, timer chip) -------- */
  let runningEntry = null;
  function renderTimerChip() {
    const chip = $("timerChip");
    if (!chip) return;
    if (!runningEntry) { chip.style.display = "none"; chip.innerHTML = ""; return; }
    chip.style.display = "";
    chip.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = "timer-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.id = "timerElapsed";
    label.textContent = fmtHMS((Date.now() - Date.parse(runningEntry.started_at)) / 1000);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "停止";
    b.onclick = async () => {
      try {
        await api(tenantPath() + "/timer/stop", jsonOpts("POST"));
        runningEntry = null;
        renderTimerChip();
        location.reload();
      } catch (e) { alert(e.message); }
    };
    chip.append(dot, label, b);
  }
  async function refreshTimerChip() {
    const chip = $("timerChip");
    if (!chip || !ctx) return;
    try {
      const now = new Date();
      const d = await api(tenantPath() + "/dashboard?date=" + localDate(now) + "&tz=" + (-now.getTimezoneOffset()));
      runningEntry = d.running_entry;
      renderTimerChip();
    } catch (e) { /* the chip is best-effort */ }
  }
  function initChrome() {
    const who = $("who");
    if (who && me) who.textContent = me.account.display_name || me.account.email || "";
    const selT = $("ctxTenant");
    if (selT && me) {
      fillSelect(selT, me.tenants, (x) => x.id, (x) => x.name);
      selT.value = ctx.tenantId;
      selT.onchange = () => {
        ctx = { tenantId: selT.value, workspaceId: null, teamId: null, projectId: null };
        saveCtx();
        location.reload();
      };
    }
    const selW = $("ctxWorkspace");
    if (selW) {
      const seen = [];
      for (const p of projectsCache) {
        if (!seen.find((x) => x.id === p.workspaceId)) seen.push({ id: p.workspaceId, name: p.workspaceName });
      }
      fillSelect(selW, seen, (x) => x.id, (x) => x.name);
      if (ctx.workspaceId) selW.value = ctx.workspaceId;
      selW.onchange = () => {
        const first = projectsCache.find((p) => p.workspaceId === selW.value);
        if (first) {
          ctx.workspaceId = first.workspaceId;
          ctx.teamId = first.teamId;
          ctx.projectId = first.id;
          saveCtx();
          location.reload();
        }
      };
    }
    const selP = $("ctxProject");
    if (selP) {
      const inWs = projectsCache.filter((p) => p.workspaceId === ctx.workspaceId);
      fillSelect(selP, inWs, (x) => x.id, (x) => x.name);
      if (ctx.projectId) selP.value = ctx.projectId;
      selP.onchange = () => {
        const p = projectsCache.find((x) => x.id === selP.value);
        if (p) {
          ctx.teamId = p.teamId;
          ctx.projectId = p.id;
          saveCtx();
          location.reload();
        }
      };
    }
    refreshTimerChip();
    setInterval(refreshTimerChip, 60000);
    setInterval(() => {
      if (runningEntry) {
        const el = $("timerElapsed");
        if (el) el.textContent = fmtHMS((Date.now() - Date.parse(runningEntry.started_at)) / 1000);
      }
    }, 1000);
  }

  /* ---------------- vault (client/vault.js wire format) ----------- */
  const B64 = {
    enc(bytes) {
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
    },
    dec(input) {
      const padded = String(input).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    },
  };
  const vault = { adk: null, exists: null };
  function normalizeCode(code) { return String(code).replace(/[\\s-]+/g, "").toUpperCase(); }
  async function deriveKek(code, saltBytes, iterations) {
    const material = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(normalizeCode(code)), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function packWith(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
    const packed = new Uint8Array(iv.length + cipher.length);
    packed.set(iv, 0);
    packed.set(cipher, iv.length);
    return "v1." + B64.enc(packed);
  }
  async function unpackWith(key, stored) {
    if (typeof stored !== "string" || !stored.startsWith("v1.")) throw new Error("unknown encrypted value format");
    const bytes = B64.dec(stored.slice(3));
    if (bytes.length <= 12) throw new Error("encrypted value too short");
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    return new Uint8Array(clear);
  }
  async function vaultStatus() {
    const v = (await api("/api/v1/me/encryption-key")).vault;
    vault.exists = v.exists;
    return v;
  }
  async function unlock(code) {
    const v = await vaultStatus();
    if (!v.exists) throw new Error("暗号化キーが未設定です");
    await api("/api/v1/me/encryption-key/recover", jsonOpts("POST", { recovery_code: code }));
    const kek = await deriveKek(code, B64.dec(v.kdf.salt), v.kdf.iterations);
    const adk = await unpackWith(kek, v.wrapped_key);
    if (adk.length !== 32) throw new Error("鍵の展開に失敗しました");
    vault.adk = adk;
    try { sessionStorage.setItem("kosu_adk", B64.enc(adk)); } catch (e) {}
    return true;
  }
  function restoreVault() {
    try {
      const s = sessionStorage.getItem("kosu_adk");
      if (s) vault.adk = B64.dec(s);
    } catch (e) {}
  }
  function lock() {
    vault.adk = null;
    try { sessionStorage.removeItem("kosu_adk"); } catch (e) {}
  }
  async function adkKey() {
    return crypto.subtle.importKey("raw", vault.adk, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async function encryptText(text) {
    if (!vault.adk) throw new Error("暗号化キーがロックされています");
    return packWith(await adkKey(), new TextEncoder().encode(String(text)));
  }
  async function decryptText(stored) {
    if (!vault.adk) throw new Error("暗号化キーがロックされています");
    const bytes = await unpackWith(await adkKey(), stored);
    return new TextDecoder().decode(bytes);
  }
  async function decryptOrNull(stored) {
    if (!stored) return null;
    if (!stored.startsWith("v1.")) return stored;
    if (!vault.adk) return null;
    try { return await decryptText(stored); } catch (e) { return null; }
  }
  async function createVault() {
    const adk = crypto.getRandomValues(new Uint8Array(32));
    const raw = crypto.getRandomValues(new Uint8Array(20));
    let bits = "";
    for (const b of raw) bits += b.toString(2).padStart(8, "0");
    const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let code = "";
    for (let i = 0; i < bits.length; i += 5) code += B32[parseInt(bits.slice(i, i + 5), 2)];
    code = code.replace(/(.{4})(?=.)/g, "$1-");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iterations = 210000;
    const kek = await deriveKek(code, salt, iterations);
    const wrapped = await packWith(kek, adk);
    await api("/api/v1/me/encryption-key", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wrapped_key: wrapped,
        kdf_salt: B64.enc(salt),
        kdf_iterations: iterations,
        recovery_code: code,
      }),
    });
    vault.adk = adk;
    vault.exists = true;
    try { sessionStorage.setItem("kosu_adk", B64.enc(adk)); } catch (e) {}
    return code;
  }

  /* ---------------- boot ------------------------------------------ */
  async function boot() {
    restoreVault();
    await initContext();
    initChrome();
  }
  function onReady(fn) {
    (async () => {
      try {
        await boot();
        await fn();
      } catch (e) {
        const m = $("msg");
        if (m) m.textContent = "読み込みに失敗しました: " + e.message;
        else console.error(e);
      }
    })();
  }
  return {
    $, api, jsonOpts, fillSelect,
    fmtHMS, fmtHM, localDate, todayStr, addDays,
    tenantPath, projectPath, currentProject,
    projects: () => projectsCache,
    me: () => me,
    ctx: () => ctx,
    members, memberName,
    vault, vaultStatus, unlock, lock, createVault,
    encryptText, decryptText, decryptOrNull,
    refreshTimerChip,
    onReady,
  };
})();
`;

/* ------------------------------------------------------------------ */
/* App shell (sidebar + topbar)                                         */
/* ------------------------------------------------------------------ */

type NavKey = "dashboard" | "tasks" | "time" | "gantt" | "reports" | "settings";

function appPage(
  prefs: UserPrefs,
  active: NavKey,
  title: string,
  heading: string,
  inner: string,
  pageScript: string,
): string {
  const locale: Locale = prefs.locale;
  const items: Array<[NavKey, string, string]> = [
    ["dashboard", "/app", t(locale, "nav.dashboard")],
    ["tasks", "/app/tasks", t(locale, "nav.tasks")],
    ["time", "/app/time", t(locale, "nav.time")],
    ["gantt", "/app/gantt", t(locale, "nav.gantt")],
    ["reports", "/app/reports", t(locale, "nav.reports")],
    ["settings", "/app/settings", t(locale, "nav.settings_top")],
  ];
  const nav = items
    .map(
      ([key, href, label]) =>
        `<a href="${href}"${key === active ? ' class="active" aria-current="page"' : ""}>${label}</a>`,
    )
    .join("\n");
  const body = `
<div class="layout">
<aside class="sidebar">
<div class="brand">Kosu</div>
<nav aria-label="メインメニュー">
${nav}
</nav>
<div class="side-sec">
<p class="muted">${t(locale, "nav.settings_top")}</p>
<nav aria-label="設定メニュー">
<a href="/app/settings/integrations">${t(locale, "nav.settings")}</a>
<a href="/app/preferences">${t(locale, "nav.preferences")}</a>
<a href="/app/onboarding">${t(locale, "nav.onboarding")}</a>
<a href="/app/conflicts">同期の競合</a>
</nav>
</div>
</aside>
<div class="content">
<header class="topbar">
<label>テナント <select id="ctxTenant" aria-label="テナント"></select></label>
<label>ワークスペース <select id="ctxWorkspace" aria-label="ワークスペース"></select></label>
<label>プロジェクト <select id="ctxProject" aria-label="プロジェクト"></select></label>
<span class="spacer"></span>
<span id="timerChip" class="timer-chip" style="display:none"></span>
<span class="muted" id="who"></span>
<button type="button" class="secondary" id="logoutBtn">${t(locale, "nav.logout")}</button>
</header>
<h1>${heading}</h1>
${inner}
<p id="msg" class="err" role="alert"></p>
</div>
</div>`;
  const script =
    UI_SCRIPT +
    `
document.getElementById("logoutBtn").onclick = async () => {
  try { await fetch("/auth/logout", { method: "POST" }); } catch (e) {}
  location.href = "/";
};
` +
    pageScript;
  return shell(title, body, script, { prefs, appChrome: true, wide: true });
}

/** Shared vault control panel (unlock / create / lock) as page HTML. */
const VAULT_PANEL_HTML = `
<div class="card" id="vaultPanel" style="margin:1rem 0">
<div><strong>暗号化キー</strong> <span class="muted" id="vaultState">確認中…</span></div>
<p class="muted">タスクの説明・コメント・工数メモはあなたの鍵で暗号化されます。復旧コードでこのブラウザのロックを解除すると、表示と編集ができるようになります（鍵はこのタブの間だけ保持されます）。</p>
<p id="vaultUnlockRow" style="display:none">
<input type="password" id="vaultCode" size="42" autocomplete="off" placeholder="復旧コード（XXXX-XXXX-…）">
<button type="button" id="vaultUnlock">ロック解除</button></p>
<p id="vaultCreateRow" style="display:none">
<button type="button" id="vaultCreate">暗号化キーを作成する</button>
<span class="muted">作成すると復旧コードを1回だけ表示します。必ず控えてください。</span></p>
<p id="vaultLockRow" style="display:none">
<button type="button" class="secondary" id="vaultLock">ロックする</button></p>
<p id="vaultCodeOut" class="warn" style="display:none"></p>
</div>`;

const VAULT_PANEL_SCRIPT = `
async function initVaultPanel(ui) {
  const $ = ui.$;
  async function render() {
    const v = await ui.vaultStatus();
    const state = $("vaultState");
    if (!v.exists) {
      state.textContent = "未設定";
      $("vaultUnlockRow").style.display = "none";
      $("vaultCreateRow").style.display = "";
      $("vaultLockRow").style.display = "none";
      return;
    }
    $("vaultCreateRow").style.display = "none";
    if (ui.vault.adk) {
      state.textContent = "ロック解除済み";
      $("vaultUnlockRow").style.display = "none";
      $("vaultLockRow").style.display = "";
    } else {
      state.textContent = "ロック中";
      $("vaultUnlockRow").style.display = "";
      $("vaultLockRow").style.display = "none";
    }
  }
  $("vaultUnlock").onclick = async () => {
    try {
      await ui.unlock($("vaultCode").value);
      $("vaultCode").value = "";
      await render();
      if (typeof window.kosuOnVaultChange === "function") await window.kosuOnVaultChange();
    } catch (e) { $("msg").textContent = "ロック解除に失敗しました: " + e.message; }
  };
  $("vaultCreate").onclick = async () => {
    try {
      const code = await ui.createVault();
      const out = $("vaultCodeOut");
      out.style.display = "";
      out.textContent = "復旧コード: " + code + "（この画面を離れる前に必ず控えてください）";
      await render();
      if (typeof window.kosuOnVaultChange === "function") await window.kosuOnVaultChange();
    } catch (e) { $("msg").textContent = "キーの作成に失敗しました: " + e.message; }
  };
  $("vaultLock").onclick = async () => {
    ui.lock();
    await render();
    if (typeof window.kosuOnVaultChange === "function") await window.kosuOnVaultChange();
  };
  await render();
}
`;

async function requirePrefs(c: Ctx): Promise<UserPrefs | null> {
  if ((await sessionAccountId(c)) === null) return null;
  return prefsFor(c);
}

/* ------------------------------------------------------------------ */
/* Landing page                                                         */
/* ------------------------------------------------------------------ */

uiRoutes.get("/", async (c) => {
  const accept = c.req.header("accept") ?? "";
  // Pre-phase-6, `/` answered the JSON service identity. Keep that for
  // clients that ask for JSON only (health probes, scripts); browsers
  // (text/html in Accept) get the landing page. /api/health serves the
  // same JSON unconditionally.
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return c.json(SERVICE_IDENTITY);
  }
  const prefs = await prefsFor(c);
  const loggedIn = (await sessionAccountId(c)) !== null;
  const locale: Locale = prefs?.locale ?? "ja";
  const en = locale === "en";
  const cta = loggedIn
    ? `<p><a href="/app"><button type="button">${t(locale, "landing.open_app")}</button></a></p>`
    : `<p><a href="/auth/login"><button type="button">${t(locale, "nav.login")}</button></a>
<span class="muted">${en ? "Sign in with your 0g0-id account." : "0g0-id のアカウントでログインします。"}</span></p>`;
  const body = `
<h1>Kosu</h1>
<p style="font-size:1.15rem">${t(locale, "app.tagline")}</p>
<p class="muted">${en
    ? "Kosu is a local-first time & task tracker: tasks and projects, a timer and manual time entries, Gantt charts and reports — with an MCP endpoint and plugins for your coding tools."
    : "Kosu はローカルファーストの工数・タスク管理サービスです。タスクとプロジェクト、タイマーと手入力の工数、ガントチャートとレポートに加えて、MCP エンドポイントと開発ツール向けプラグインを備えています。"}</p>
${cta}
<svg viewBox="0 0 640 96" width="100%" style="max-width:640px" role="img" aria-label="${en ? "Flow: record time and tasks, encrypt and sync them local-first, then review Gantt charts and reports" : "流れ：工数とタスクを記録し、ローカルファーストで暗号化して同期し、ガントとレポートで確認する"}">
<rect x="1" y="24" width="188" height="48" fill="none" stroke="#2456c8" stroke-width="2"/>
<text x="95" y="46" text-anchor="middle" font-size="15" fill="currentColor">${en ? "Record" : "記録する"}</text>
<text x="95" y="64" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">${en ? "timer / manual entries" : "タイマー・手入力"}</text>
<line x1="189" y1="48" x2="213" y2="48" stroke="#2456c8" stroke-width="2"/>
<polygon points="225,48 211,41 211,55" fill="#2456c8"/>
<rect x="226" y="24" width="188" height="48" fill="none" stroke="#2456c8" stroke-width="2"/>
<text x="320" y="46" text-anchor="middle" font-size="15" fill="currentColor">${en ? "Encrypt & sync" : "暗号化して同期"}</text>
<text x="320" y="64" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">${en ? "local-first" : "ローカルファースト"}</text>
<line x1="414" y1="48" x2="438" y2="48" stroke="#2456c8" stroke-width="2"/>
<polygon points="450,48 436,41 436,55" fill="#2456c8"/>
<rect x="451" y="24" width="188" height="48" fill="none" stroke="#2456c8" stroke-width="2"/>
<text x="545" y="46" text-anchor="middle" font-size="15" fill="currentColor">${en ? "Review" : "集計する"}</text>
<text x="545" y="64" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.65">${en ? "Gantt / reports" : "ガント・レポート"}</text>
</svg>
<h2>${t(locale, "landing.features_title")}</h2>
<ul>
<li>${en ? "Tasks with subtasks, dependencies, labels, comments and custom statuses" : "タスク管理（サブタスク・依存・ラベル・コメント・ステータスカスタマイズ）"}</li>
<li>${en ? "Timer + manual time entries, estimates vs actuals, budgets and approvals" : "タイマーと手入力の工数記録、見積もりと実績、単価・予算、提出と承認"}</li>
<li>${en ? "Local-first sync: bodies are encrypted on your device, the server stores ciphertext" : "ローカルファースト同期：本文はあなたの端末で暗号化され、サーバーは暗号文だけを保持"}</li>
<li>${en ? "MCP endpoint and bundled plugins (Claude Code / Codex / dsh)" : "MCP エンドポイントとプラグイン同梱（Claude Code / Codex / dsh）"}</li>
<li>${en ? "Integrations: Linear, GitHub Issues, Slack, TimeCrowd, iCal feeds" : "外部連携：Linear、GitHub Issues、Slack、TimeCrowd、iCal フィード"}</li>
</ul>
<h2>${en ? "For tools and scripts" : "ツール・スクリプト向け"}</h2>
<p class="muted">${en
    ? "Machine-readable status is at /health and /api/health. The MCP endpoint is POST /mcp (API key authentication)."
    : "状態確認の JSON は /health と /api/health にあります。MCP エンドポイントは POST /mcp（API キー認証）です。"}</p>
<p><a href="/terms">${t(locale, "nav.terms")}</a> ／ <a href="/privacy">${t(locale, "nav.privacy")}</a></p>`;
  return c.html(shell("Kosu — 工数・タスク管理", body, "", { prefs }));
});

/* ------------------------------------------------------------------ */
/* Dashboard                                                            */
/* ------------------------------------------------------------------ */

const DASHBOARD_SCRIPT = `
const ui = window.KosuUI;
const $ = ui.$;
ui.onReady(async () => {
  const now = new Date();
  const date = ui.todayStr();
  const tz = -now.getTimezoneOffset();
  const d = await ui.api(ui.tenantPath() + "/dashboard?date=" + date + "&tz=" + tz);
  $("today").textContent = ui.fmtHM(d.today.rounded_seconds);
  $("todayRaw").textContent = "実測 " + ui.fmtHM(d.today.seconds) + "（丸め適用後を表示）";
  $("week").textContent = ui.fmtHM(d.week.rounded_seconds);
  $("weekRaw").textContent = "実測 " + ui.fmtHM(d.week.seconds);
  // Sync status (same device-registration flow as the phase 2 page).
  let deviceId = localStorage.getItem("kosu_device_id");
  if (!deviceId) {
    const reg = await ui.api("/api/v1/sync/devices", ui.jsonOpts("POST", { name: "Web ブラウザ", platform: navigator.platform || "web" }));
    deviceId = reg.device.id;
    localStorage.setItem("kosu_device_id", deviceId);
  }
  const st = await ui.api(ui.tenantPath() + "/sync/status?device_id=" + encodeURIComponent(deviceId));
  $("syncSeq").textContent = "seq " + st.last_seq;
  $("syncInfo").textContent = "競合 " + st.open_conflicts + " 件 / 端末 " + st.devices.length + " 台";
  if (st.open_conflicts > 0) {
    const a = document.createElement("a");
    a.href = "/app/conflicts";
    a.textContent = "競合を確認する";
    a.style.display = "block";
    $("syncInfo").appendChild(a);
  }
  // Doing tasks assigned to me (from the dashboard API).
  const doingBody = $("doing");
  if (d.doing_tasks.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3; td.className = "muted"; td.textContent = "進行中のタスクはありません";
    tr.appendChild(td); doingBody.appendChild(tr);
  }
  for (const task of d.doing_tasks) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td"); td1.textContent = task.title;
    const td2 = document.createElement("td"); td2.textContent = task.due_date || "";
    if (task.due_date && task.due_date < date) td2.className = "due-over";
    const td3 = document.createElement("td");
    const a = document.createElement("a");
    a.href = "/app/tasks"; a.textContent = "開く";
    td3.appendChild(a);
    tr.append(td1, td2, td3);
    doingBody.appendChild(tr);
  }
  // Cross-project sweep: per-project summary + due-soon list.
  const projects = ui.projects().slice(0, 20);
  const weekFrom = d.week_start;
  const report = await ui.api(ui.tenantPath() + "/report?from=" + weekFrom + "&to=" + ui.addDays(weekFrom, 6) + "&group_by=project").catch(() => null);
  const weekByProject = {};
  if (report) for (const g of report.report.groups) weekByProject[g.key] = g.rounded_seconds;
  const sumBody = $("projSummary");
  const dueList = [];
  for (const p of projects) {
    const data = await ui.api(p.path + "/tasks").catch(() => ({ tasks: [] }));
    const tasks = data.tasks;
    const done = tasks.filter((x) => x.status === "done").length;
    const doing = tasks.filter((x) => x.status === "doing").length;
    const tr = document.createElement("tr");
    const cells = [p.name, String(tasks.length), String(done), String(doing), ui.fmtHM(weekByProject[p.id] || 0)];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      if (i === 0) {
        const a = document.createElement("a");
        a.href = "/app/gantt"; a.textContent = text;
        a.onclick = () => {
          const c = ui.ctx();
          localStorage.setItem("kosu_ctx", JSON.stringify({ tenantId: c.tenantId, workspaceId: p.workspaceId, teamId: p.teamId, projectId: p.id }));
        };
        td.appendChild(a);
      } else td.textContent = text;
      tr.appendChild(td);
    });
    sumBody.appendChild(tr);
    for (const task of tasks) {
      if (task.due_date && task.status !== "done" && task.due_date <= ui.addDays(date, 7)) {
        dueList.push({ task, projectName: p.name });
      }
    }
  }
  if (projects.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5; td.className = "muted"; td.textContent = "プロジェクトがまだありません";
    tr.appendChild(td); sumBody.appendChild(tr);
  }
  // Week time by project as an SVG bar chart (diagram-first dashboard).
  const chartData = projects
    .map((p) => ({ name: p.name, seconds: weekByProject[p.id] || 0 }))
    .filter((x) => x.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const chartEl = $("projChart");
  if (chartEl && chartData.length > 0) {
    const maxSec = Math.max.apply(null, chartData.map((x) => x.seconds));
    const rowH = 22, nameW = 150, barMax = 380, valW = 90;
    const width = nameW + barMax + valW;
    const height = chartData.length * rowH + 4;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", "100%");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "プロジェクト別 今週の工数（棒グラフ）");
    svg.classList.add("bars");
    chartData.forEach((x, i) => {
      const y = i * rowH + 2;
      const bw = Math.max(2, Math.round(barMax * x.seconds / maxSec));
      const name = document.createElementNS(NS, "text");
      name.setAttribute("x", "0");
      name.setAttribute("y", String(y + 14));
      name.setAttribute("font-size", "12");
      name.setAttribute("fill", "currentColor");
      name.textContent = x.name;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", String(nameW));
      rect.setAttribute("y", String(y + 3));
      rect.setAttribute("width", String(bw));
      rect.setAttribute("height", "14");
      rect.setAttribute("fill", "#2456c8");
      rect.classList.add("bar");
      const val = document.createElementNS(NS, "text");
      val.setAttribute("x", String(nameW + bw + 8));
      val.setAttribute("y", String(y + 14));
      val.setAttribute("font-size", "12");
      val.setAttribute("fill", "currentColor");
      val.textContent = ui.fmtHM(x.seconds);
      svg.append(name, rect, val);
    });
    chartEl.appendChild(svg);
  }
  dueList.sort((a, b) => a.task.due_date.localeCompare(b.task.due_date));
  $("dueCount").textContent = String(dueList.length);
  const dueBody = $("dueSoon");
  if (dueList.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4; td.className = "muted"; td.textContent = "期限が近いタスクはありません";
    tr.appendChild(td); dueBody.appendChild(tr);
  }
  for (const item of dueList.slice(0, 10)) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td"); td1.textContent = item.task.title;
    const td2 = document.createElement("td"); td2.textContent = item.projectName;
    const td3 = document.createElement("td");
    td3.textContent = item.task.due_date;
    td3.className = item.task.due_date < date ? "due-over" : "due-soon";
    const td4 = document.createElement("td"); td4.textContent = item.task.status;
    tr.append(td1, td2, td3, td4);
    dueBody.appendChild(tr);
  }
});
`;

uiRoutes.get("/app", async (c) => {
  const prefs = await requirePrefs(c);
  if (!prefs) return c.redirect("/auth/login", 302);
  const locale = prefs.locale;
  const weekDayKey = `weekday.${prefs.week_start}` as Parameters<typeof t>[1];
  const weekLabel =
    locale === "en"
      ? "This week's time"
      : `今週の工数（${t(locale, weekDayKey)}始まり）`;
  const inner = `
<div class="cards">
  <div class="card"><div class="muted">${locale === "en" ? "Today's time" : "今日の工数"}</div><div class="big" id="today">–</div><div class="muted" id="todayRaw"></div></div>
  <div class="card"><div class="muted">${weekLabel}</div><div class="big" id="week">–</div><div class="muted" id="weekRaw"></div></div>
  <div class="card"><div class="muted">${t(locale, "dashboard.due_soon")}</div><div class="big" id="dueCount">–</div><div class="muted">超過分を含みます</div></div>
  <div class="card"><div class="muted">同期ステータス</div><div class="big" id="syncSeq">–</div><div class="muted" id="syncInfo"></div></div>
</div>
<h2>${t(locale, "dashboard.due_soon")}</h2>
<table><thead><tr><th scope="col">タスク</th><th scope="col">プロジェクト</th><th scope="col">期限</th><th scope="col">ステータス</th></tr></thead><tbody id="dueSoon"></tbody></table>
<h2>${t(locale, "dashboard.by_project")}</h2>
<div id="projChart"></div>
<table><thead><tr><th scope="col">プロジェクト</th><th scope="col">タスク数</th><th scope="col">完了</th><th scope="col">進行中</th><th scope="col">今週の工数</th></tr></thead><tbody id="projSummary"></tbody></table>
<h2>進行中のタスク</h2>
<table><thead><tr><th scope="col">タスク</th><th scope="col">期限</th><th scope="col"></th></tr></thead><tbody id="doing"></tbody></table>`;
  return c.html(
    appPage(prefs, "dashboard", t(locale, "dashboard.title"), `Kosu ${t(locale, "dashboard.title")}`, inner, DASHBOARD_SCRIPT),
  );
});

/* ------------------------------------------------------------------ */
/* Tasks                                                                */
/* ------------------------------------------------------------------ */

const TASKS_HTML = `
<div class="toolbar" role="search">
  <label>検索 <input type="text" id="fQ" size="22"></label>
  <label>担当 <select id="fAssignee"></select></label>
  <label>ラベル <select id="fLabel"></select></label>
  <label>期限（から） <input type="date" id="fDueFrom"></label>
  <label>期限（まで） <input type="date" id="fDueTo"></label>
  <label><span>アーカイブも表示</span><input type="checkbox" id="fArchived"></label>
  <button type="button" id="fApply">絞り込む</button>
</div>
<div class="toolbar" aria-label="ステータスと優先度">
  <span class="muted">ステータス</span><span id="fStatuses"></span>
  <span class="muted">優先度</span><span id="fPriorities"></span>
</div>
<form id="createForm" class="card" style="margin-bottom:1rem">
<strong>新しいタスク</strong>
<div class="form-grid" style="margin-top:.6rem">
  <label class="full">タイトル <input type="text" id="cTitle" required maxlength="300"></label>
  <label>ステータス <select id="cStatus"></select></label>
  <label>優先度 <select id="cPriority"></select></label>
  <label>担当 <select id="cAssignee"></select></label>
  <label>見積もり（分） <input type="number" id="cEstimate" min="0" step="5"></label>
  <label>開始予定 <input type="date" id="cStart"></label>
  <label>期限 <input type="date" id="cDue"></label>
</div>
<p><button type="submit">作成する</button> <span class="muted">作成先は上のプロジェクトです</span></p>
</form>
<div class="split">
<div>
<p class="muted" id="taskCount"></p>
<table><thead><tr><th scope="col">タスク</th><th scope="col">ステータス</th><th scope="col">優先度</th><th scope="col">担当</th><th scope="col">期限</th><th scope="col">ラベル</th></tr></thead><tbody id="taskRows"></tbody></table>
</div>
<div class="detail" id="detail" hidden>
<h2 id="dTitle"></h2>
<form id="editForm">
<div class="form-grid">
  <label class="full">タイトル <input type="text" id="eTitle" required maxlength="300"></label>
  <label>ステータス <select id="eStatus"></select></label>
  <label>優先度 <select id="ePriority"></select></label>
  <label>担当 <select id="eAssignee"></select></label>
  <label>親タスク <select id="eParent"></select></label>
  <label>開始予定 <input type="date" id="eStart"></label>
  <label>期限 <input type="date" id="eDue"></label>
  <label>見積もり（分） <input type="number" id="eEstimate" min="0" step="5"></label>
  <label>見積もり（ポイント） <input type="number" id="ePoints" min="0" step="0.5"></label>
  <label>見積もり（サイズ） <select id="eSize"><option value="">（なし）</option><option>XS</option><option>S</option><option>M</option><option>L</option><option>XL</option></select></label>
</div>
<p><button type="submit">保存する</button>
<button type="button" class="secondary" id="dTimer">タイマー開始</button>
<button type="button" class="secondary" id="dDelete" style="color:#b00020">削除する</button></p>
</form>
<h3>説明</h3>
<p class="muted" id="descNote"></p>
<textarea id="eDesc" rows="5"></textarea>
<p><button type="button" class="secondary" id="dDescSave">説明を保存</button></p>
<h3>ラベル</h3>
<div id="dLabels"></div>
<h3>サブタスク</h3>
<ul id="dSubtasks"></ul>
<p><input type="text" id="subTitle" size="30" placeholder="サブタスクのタイトル"> <button type="button" class="secondary" id="subAdd">追加</button></p>
<h3>依存</h3>
<p class="muted">このタスクの前提（先に終わらせるもの）</p>
<ul id="dDependsOn"></ul>
<p><select id="depSelect"></select> <button type="button" class="secondary" id="depAdd">前提に追加</button></p>
<p class="muted">このタスクを前提にしているもの</p>
<ul id="dDependedBy"></ul>
<h3>工数</h3>
<p id="dTimeSummary" class="muted"></p>
<h3>コメント</h3>
<div id="dComments"></div>
<p><textarea id="commentBody" rows="3" placeholder="コメント（暗号化して保存されます）"></textarea></p>
<p><button type="button" id="commentPost">コメントする</button> <span class="muted" id="commentNote"></span></p>
</div>
</div>
<div id="vaultSlot"></div>`;

const TASKS_SCRIPT = `
const ui = window.KosuUI;
const $ = ui.$;
let statusDefs = [];
let priorityDefs = [];
let labelDefs = [];
let taskCache = [];
let selectedId = null;
let selectedTask = null;

function defName(defs, slug) {
  const d = defs.find((x) => x.slug === slug);
  return d ? d.name : slug;
}
function checkedValues(containerId) {
  return Array.from(document.querySelectorAll("#" + containerId + " input[type=checkbox]:checked")).map((el) => el.value);
}
function buildChecks(containerId, defs) {
  const box = $(containerId);
  box.innerHTML = "";
  for (const d of defs) {
    const label = document.createElement("label");
    label.style.marginRight = ".6rem";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = d.slug;
    input.checked = true;
    label.append(input, document.createTextNode(" " + d.name));
    box.appendChild(label);
  }
}
function memberOptions(sel, includeAny, anyLabel) {
  sel.innerHTML = "";
  if (includeAny) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = anyLabel || "すべて";
    sel.appendChild(o);
  }
  const none = document.createElement("option");
  none.value = ""; none.textContent = includeAny ? "" : "（未割当）";
  if (!includeAny) sel.appendChild(none);
  return ui.members().then((ms) => {
    for (const m of ms) {
      const o = document.createElement("option");
      o.value = m.account_id;
      o.textContent = m.display_name || m.email || m.account_id;
      sel.appendChild(o);
    }
  });
}
async function loadTasks() {
  const params = new URLSearchParams();
  const q = $("fQ").value.trim();
  if (q) params.set("q", q);
  const st = checkedValues("fStatuses");
  if (st.length && st.length < statusDefs.length) params.set("status", st.join(","));
  const pr = checkedValues("fPriorities");
  if (pr.length && pr.length < priorityDefs.length) params.set("priority", pr.join(","));
  if ($("fAssignee").value) params.set("assignee_account_id", $("fAssignee").value);
  if ($("fLabel").value) params.set("label_id", $("fLabel").value);
  if ($("fDueFrom").value) params.set("due_from", $("fDueFrom").value);
  if ($("fDueTo").value) params.set("due_to", $("fDueTo").value);
  if ($("fArchived").checked) params.set("include_archived", "1");
  const data = await ui.api(ui.projectPath() + "/tasks?" + params.toString());
  taskCache = data.tasks;
  renderList();
}
function orderedTasks() {
  const byId = new Map(taskCache.map((t) => [t.id, t]));
  const children = new Map();
  const roots = [];
  for (const t of taskCache) {
    if (t.parent_task_id && byId.has(t.parent_task_id)) {
      const arr = children.get(t.parent_task_id) || [];
      arr.push(t);
      children.set(t.parent_task_id, arr);
    } else roots.push(t);
  }
  const out = [];
  const walk = (t, depth) => {
    out.push({ task: t, depth });
    for (const ch of children.get(t.id) || []) walk(ch, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}
function renderList() {
  const tbody = $("taskRows");
  tbody.innerHTML = "";
  const today = ui.todayStr();
  for (const item of orderedTasks()) {
    const t = item.task;
    const tr = document.createElement("tr");
    tr.className = "clickable";
    if (t.id === selectedId) tr.style.background = "#eef1f8";
    tr.onclick = () => selectTask(t.id);
    const td1 = document.createElement("td");
    td1.textContent = (item.depth ? "　".repeat(item.depth) + "↳ " : "") + t.title;
    if (t.archived_at) td1.className = "muted";
    const td2 = document.createElement("td");
    const sel = document.createElement("select");
    ui.fillSelect(sel, statusDefs, (d) => d.slug, (d) => d.name);
    sel.value = t.status;
    sel.onclick = (ev) => ev.stopPropagation();
    sel.onchange = async (ev) => {
      ev.stopPropagation();
      try {
        const r = await ui.api(ui.projectPath() + "/tasks/" + t.id, ui.jsonOpts("PATCH", { status: sel.value }));
        Object.assign(t, r.task);
        if (selectedId === t.id) fillDetail(r.task);
      } catch (e) { $("msg").textContent = e.message; sel.value = t.status; }
    };
    td2.appendChild(sel);
    const td3 = document.createElement("td");
    td3.textContent = defName(priorityDefs, t.priority);
    const td4 = document.createElement("td");
    td4.textContent = ui.memberName(t.assignee_account_id);
    const td5 = document.createElement("td");
    td5.textContent = t.due_date || "";
    if (t.due_date && t.status !== "done") td5.className = t.due_date < today ? "due-over" : (t.due_date <= ui.addDays(today, 3) ? "due-soon" : "");
    const td6 = document.createElement("td");
    td6.id = "labels-" + t.id;
    tr.append(td1, td2, td3, td4, td5, td6);
    tbody.appendChild(tr);
  }
  $("taskCount").textContent = taskCache.length + " 件";
  // Label chips load lazily per visible task.
  for (const t of taskCache) {
    ui.api(ui.projectPath() + "/tasks/" + t.id + "/labels").then((d) => {
      const cell = document.getElementById("labels-" + t.id);
      if (!cell) return;
      for (const l of d.labels) {
        const s = document.createElement("span");
        s.className = "tag";
        if (l.color) s.style.borderLeftColor = l.color;
        s.textContent = l.name;
        cell.appendChild(s);
      }
    }).catch(() => {});
  }
}
async function selectTask(id) {
  selectedId = id;
  selectedTask = taskCache.find((t) => t.id === id) || null;
  if (!selectedTask) return;
  renderList();
  $("detail").hidden = false;
  fillDetail(selectedTask);
  await loadDetailExtras(selectedTask);
}
function fillDetail(t) {
  selectedTask = t;
  $("dTitle").textContent = t.title;
  $("eTitle").value = t.title;
  ui.fillSelect($("eStatus"), statusDefs, (d) => d.slug, (d) => d.name);
  $("eStatus").value = t.status;
  ui.fillSelect($("ePriority"), priorityDefs, (d) => d.slug, (d) => d.name);
  $("ePriority").value = t.priority;
  memberOptions($("eAssignee"), false).then(() => { $("eAssignee").value = t.assignee_account_id || ""; });
  const parentSel = $("eParent");
  parentSel.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "（なし）";
  parentSel.appendChild(none);
  for (const other of taskCache) {
    if (other.id === t.id) continue;
    const o = document.createElement("option");
    o.value = other.id; o.textContent = other.title;
    parentSel.appendChild(o);
  }
  parentSel.value = t.parent_task_id || "";
  $("eStart").value = t.start_date || "";
  $("eDue").value = t.due_date || "";
  $("eEstimate").value = t.estimate_minutes == null ? "" : t.estimate_minutes;
  $("ePoints").value = t.estimate_points == null ? "" : t.estimate_points;
  $("eSize").value = t.estimate_size || "";
}
async function loadDetailExtras(t) {
  const desc = await ui.decryptOrNull(t.description_enc);
  if (t.description_enc && desc === null) {
    $("eDesc").value = "";
    $("eDesc").disabled = true;
    $("descNote").textContent = "説明は暗号化されています。下の暗号化キーでロックを解除すると表示・編集できます。";
    $("dDescSave").disabled = true;
  } else {
    $("eDesc").value = desc || "";
    $("eDesc").disabled = false;
    $("descNote").textContent = t.description_enc ? "" : "説明はまだありません。保存すると暗号化されて保存されます。";
    $("dDescSave").disabled = false;
  }
  // Labels
  const attached = await ui.api(ui.projectPath() + "/tasks/" + t.id + "/labels").catch(() => ({ labels: [] }));
  const attachedIds = new Set(attached.labels.map((l) => l.id));
  const box = $("dLabels");
  box.innerHTML = "";
  if (labelDefs.length === 0) box.textContent = "ラベルはまだありません";
  for (const l of labelDefs) {
    const label = document.createElement("label");
    label.style.marginRight = ".7rem";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = attachedIds.has(l.id);
    input.onchange = async () => {
      try {
        if (input.checked) await ui.api(ui.projectPath() + "/tasks/" + t.id + "/labels", ui.jsonOpts("POST", { label_id: l.id }));
        else await ui.api(ui.projectPath() + "/tasks/" + t.id + "/labels/" + l.id, { method: "DELETE" });
        renderList();
      } catch (e) { $("msg").textContent = e.message; input.checked = !input.checked; }
    };
    label.append(input, document.createTextNode(" " + l.name));
    box.appendChild(label);
  }
  // Subtasks
  const subs = taskCache.filter((x) => x.parent_task_id === t.id);
  const subUl = $("dSubtasks");
  subUl.innerHTML = "";
  if (subs.length === 0) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "サブタスクはありません"; subUl.appendChild(li); }
  for (const s of subs) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = s.title + "（" + defName(statusDefs, s.status) + "）";
    a.onclick = (ev) => { ev.preventDefault(); selectTask(s.id); };
    li.appendChild(a);
    subUl.appendChild(li);
  }
  // Dependencies
  const deps = await ui.api(ui.projectPath() + "/dependencies").catch(() => ({ dependencies: [] }));
  const byId = new Map(taskCache.map((x) => [x.id, x]));
  const onUl = $("dDependsOn");
  onUl.innerHTML = "";
  const mine = deps.dependencies.filter((d) => d.task_id === t.id);
  if (mine.length === 0) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "前提はありません"; onUl.appendChild(li); }
  for (const d of mine) {
    const li = document.createElement("li");
    li.textContent = (byId.get(d.depends_on_task_id) || {}).title || d.depends_on_task_id;
    const b = document.createElement("button");
    b.type = "button"; b.className = "secondary"; b.textContent = "外す";
    b.style.marginLeft = ".5rem";
    b.onclick = async () => {
      try { await ui.api(ui.projectPath() + "/dependencies/" + d.id, { method: "DELETE" }); await loadDetailExtras(selectedTask); }
      catch (e) { $("msg").textContent = e.message; }
    };
    li.appendChild(b);
    onUl.appendChild(li);
  }
  const byUl = $("dDependedBy");
  byUl.innerHTML = "";
  const dependents = deps.dependencies.filter((d) => d.depends_on_task_id === t.id);
  if (dependents.length === 0) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "このタスクを前提にしているものはありません"; byUl.appendChild(li); }
  for (const d of dependents) {
    const li = document.createElement("li");
    li.textContent = (byId.get(d.task_id) || {}).title || d.task_id;
    byUl.appendChild(li);
  }
  const depSel = $("depSelect");
  depSel.innerHTML = "";
  for (const other of taskCache) {
    if (other.id === t.id) continue;
    const o = document.createElement("option");
    o.value = other.id; o.textContent = other.title;
    depSel.appendChild(o);
  }
  // Time summary
  const entries = await ui.api(ui.projectPath() + "/tasks/" + t.id + "/time-entries").catch(() => ({ entries: [] }));
  const total = entries.entries.reduce((sum, e) => sum + (e.running ? 0 : e.duration_seconds), 0);
  const running = entries.entries.find((e) => e.running);
  $("dTimeSummary").textContent = "記録済み " + ui.fmtHM(total) + " / " + entries.entries.length + " 件" + (running ? "（タイマー実行中）" : "") + " — 詳細は工数画面で";
  $("dTimer").textContent = running ? "タイマー停止" : "タイマー開始";
  // Comments
  await renderComments(t);
}
async function renderComments(t) {
  const data = await ui.api(ui.projectPath() + "/tasks/" + t.id + "/comments").catch(() => ({ comments: [] }));
  const box = $("dComments");
  box.innerHTML = "";
  if (data.comments.length === 0) {
    const p = document.createElement("p");
    p.className = "muted"; p.textContent = "コメントはまだありません";
    box.appendChild(p);
  }
  for (const cm of data.comments) {
    const div = document.createElement("div");
    div.className = "comment";
    const head = document.createElement("div");
    head.className = "muted";
    head.textContent = ui.memberName(cm.account_id) + " ・ " + new Date(cm.created_at).toLocaleString();
    const body = document.createElement("div");
    const text = await ui.decryptOrNull(cm.body_enc);
    body.textContent = text === null ? "暗号化されています（ロック解除で表示）" : text;
    body.style.whiteSpace = "pre-wrap";
    div.append(head, body);
    box.appendChild(div);
  }
  const locked = !ui.vault.adk;
  $("commentPost").disabled = locked;
  $("commentBody").disabled = locked;
  $("commentNote").textContent = locked ? "コメントには暗号化キーのロック解除が必要です" : "";
}
window.kosuOnVaultChange = async () => { if (selectedTask) await loadDetailExtras(selectedTask); };

ui.onReady(async () => {
  if (!ui.ctx().projectId) {
    $("msg").textContent = "プロジェクトがありません。先にプロジェクトを作成してください。";
    return;
  }
  await ui.members();
  const stData = await ui.api(ui.projectPath() + "/workflow/statuses");
  statusDefs = stData.statuses || [];
  const prData = await ui.api(ui.projectPath() + "/workflow/priorities");
  priorityDefs = prData.priorities || [];
  const lbData = await ui.api(ui.projectPath() + "/labels");
  labelDefs = lbData.labels || [];
  buildChecks("fStatuses", statusDefs);
  buildChecks("fPriorities", priorityDefs);
  ui.fillSelect($("cStatus"), statusDefs, (d) => d.slug, (d) => d.name);
  ui.fillSelect($("cPriority"), priorityDefs, (d) => d.slug, (d) => d.name);
  await memberOptions($("fAssignee"), true, "すべての担当");
  await memberOptions($("cAssignee"), false);
  const labelSel = $("fLabel");
  labelSel.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = ""; allOpt.textContent = "すべてのラベル";
  labelSel.appendChild(allOpt);
  for (const l of labelDefs) {
    const o = document.createElement("option");
    o.value = l.id; o.textContent = l.name;
    labelSel.appendChild(o);
  }
  $("fApply").onclick = () => loadTasks().catch((e) => { $("msg").textContent = e.message; });
  $("fQ").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); loadTasks().catch((e) => { $("msg").textContent = e.message; }); } });
  $("createForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const body = {
        title: $("cTitle").value,
        status: $("cStatus").value,
        priority: $("cPriority").value,
        assignee_account_id: $("cAssignee").value || null,
        start_date: $("cStart").value || null,
        due_date: $("cDue").value || null,
        estimate_minutes: $("cEstimate").value === "" ? null : Number($("cEstimate").value),
      };
      const r = await ui.api(ui.projectPath() + "/tasks", ui.jsonOpts("POST", body));
      $("cTitle").value = "";
      await loadTasks();
      await selectTask(r.task.id);
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("editForm").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!selectedTask) return;
    try {
      const body = {
        title: $("eTitle").value,
        status: $("eStatus").value,
        priority: $("ePriority").value,
        assignee_account_id: $("eAssignee").value || null,
        parent_task_id: $("eParent").value || null,
        start_date: $("eStart").value || null,
        due_date: $("eDue").value || null,
        estimate_minutes: $("eEstimate").value === "" ? null : Number($("eEstimate").value),
        estimate_points: $("ePoints").value === "" ? null : Number($("ePoints").value),
        estimate_size: $("eSize").value || null,
      };
      const r = await ui.api(ui.projectPath() + "/tasks/" + selectedTask.id, ui.jsonOpts("PATCH", body));
      const idx = taskCache.findIndex((x) => x.id === r.task.id);
      if (idx >= 0) taskCache[idx] = r.task;
      fillDetail(r.task);
      renderList();
      $("msg").textContent = "";
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("dDescSave").onclick = async () => {
    if (!selectedTask) return;
    try {
      const text = $("eDesc").value;
      const enc = text ? await ui.encryptText(text) : null;
      const r = await ui.api(ui.projectPath() + "/tasks/" + selectedTask.id, ui.jsonOpts("PATCH", { description_enc: enc }));
      selectedTask = r.task;
      const idx = taskCache.findIndex((x) => x.id === r.task.id);
      if (idx >= 0) taskCache[idx] = r.task;
      $("descNote").textContent = "保存しました";
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("dDelete").onclick = async () => {
    if (!selectedTask) return;
    if (!confirm("タスク「" + selectedTask.title + "」を削除しますか？")) return;
    try {
      await ui.api(ui.projectPath() + "/tasks/" + selectedTask.id, { method: "DELETE" });
      selectedId = null;
      selectedTask = null;
      $("detail").hidden = true;
      await loadTasks();
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("dTimer").onclick = async () => {
    if (!selectedTask) return;
    try {
      if ($("dTimer").textContent === "タイマー停止") {
        await ui.api(ui.tenantPath() + "/timer/stop", ui.jsonOpts("POST"));
      } else {
        await ui.api(ui.tenantPath() + "/timer/start", ui.jsonOpts("POST", { task_id: selectedTask.id }));
      }
      await ui.refreshTimerChip();
      await loadDetailExtras(selectedTask);
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("subAdd").onclick = async () => {
    if (!selectedTask) return;
    const title = $("subTitle").value.trim();
    if (!title) return;
    try {
      await ui.api(ui.projectPath() + "/tasks", ui.jsonOpts("POST", { title, parent_task_id: selectedTask.id }));
      $("subTitle").value = "";
      await loadTasks();
      await loadDetailExtras(selectedTask);
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("depAdd").onclick = async () => {
    if (!selectedTask || !$("depSelect").value) return;
    try {
      await ui.api(ui.projectPath() + "/dependencies", ui.jsonOpts("POST", { task_id: selectedTask.id, depends_on_task_id: $("depSelect").value }));
      await loadDetailExtras(selectedTask);
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("commentPost").onclick = async () => {
    if (!selectedTask) return;
    const text = $("commentBody").value.trim();
    if (!text) return;
    try {
      const enc = await ui.encryptText(text);
      await ui.api(ui.projectPath() + "/tasks/" + selectedTask.id + "/comments", ui.jsonOpts("POST", { body_enc: enc }));
      $("commentBody").value = "";
      await renderComments(selectedTask);
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("vaultSlot").innerHTML = VAULT_HTML;
  await initVaultPanel(ui);
  await loadTasks();
});
`;

uiRoutes.get("/app/tasks", async (c) => {
  const prefs = await requirePrefs(c);
  if (!prefs) return c.redirect("/auth/login", 302);
  const locale = prefs.locale;
  const script =
    VAULT_PANEL_SCRIPT +
    "\n" +
    TASKS_SCRIPT.replaceAll(
      "VAULT_HTML",
      JSON.stringify(VAULT_PANEL_HTML),
    );
  return c.html(
    appPage(prefs, "tasks", t(locale, "tasks.title"), t(locale, "tasks.title"), TASKS_HTML, script),
  );
});

/* ------------------------------------------------------------------ */
/* Time entries                                                         */
/* ------------------------------------------------------------------ */

const TIME_HTML = `
<div class="cards">
  <div class="card"><div class="muted">今日の工数</div><div class="big" id="todayTotal">–</div></div>
  <div class="card"><div class="muted">表示中の週の合計</div><div class="big" id="weekTotal">–</div></div>
</div>
<div class="split">
<div>
<div class="toolbar">
  <button type="button" class="secondary" id="prevWeek">‹ 前の週</button>
  <button type="button" class="secondary" id="thisWeek">今週</button>
  <button type="button" class="secondary" id="nextWeek">次の週 ›</button>
  <strong id="weekLabel"></strong>
</div>
<div id="days"></div>
</div>
<div>
<form id="timerForm" class="card" style="margin-bottom:1rem">
<strong>タイマー</strong>
<div class="form-grid" style="margin-top:.6rem">
  <label class="full">プロジェクト <select id="tProject"></select></label>
  <label class="full">タスク <select id="tTask"></select></label>
</div>
<p><button type="submit">タイマーを開始</button></p>
<p class="muted">実行中のタイマーは画面上部のチップからいつでも停止できます。</p>
</form>
<form id="manualForm" class="card">
<strong id="manualTitle">手入力で追加</strong>
<div class="form-grid" style="margin-top:.6rem">
  <label class="full">タスク <select id="mTask"></select></label>
  <label>日付 <input type="date" id="mDate" required></label>
  <label>開始 <input type="time" id="mStart" required></label>
  <label>終了 <input type="time" id="mEnd" required></label>
</div>
<p><button type="submit" id="manualSubmit">追加する</button>
<button type="button" class="secondary" id="manualCancel" style="display:none">編集をやめる</button></p>
<p class="muted">手入力はタスクに紐づけて記録します。</p>
</form>
</div>
</div>`;

const TIME_SCRIPT = `
const ui = window.KosuUI;
const $ = ui.$;
let weekStart = null;
let editingId = null;
let taskTitleById = new Map();
let taskProjectPathById = new Map();

function computeWeekStart(fromDateStr) {
  const parts = fromDateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const isoDow = ((dt.getUTCDay() + 6) % 7) + 1;
  const offset = (isoDow - KOSU_WEEK_START_DOW + 7) % 7;
  return ui.addDays(fromDateStr, -offset);
}
async function loadTaskIndex() {
  taskTitleById = new Map();
  taskProjectPathById = new Map();
  for (const p of ui.projects().slice(0, 20)) {
    const data = await ui.api(p.path + "/tasks").catch(() => ({ tasks: [] }));
    for (const t of data.tasks) {
      taskTitleById.set(t.id, t.title);
      taskProjectPathById.set(t.id, p.path);
    }
  }
}
async function fillTaskSelect(sel, project, includeNone) {
  sel.innerHTML = "";
  if (includeNone) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "（タスクなし）";
    sel.appendChild(o);
  }
  if (!project) return;
  const data = await ui.api(project.path + "/tasks").catch(() => ({ tasks: [] }));
  for (const t of data.tasks) {
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.title;
    sel.appendChild(o);
  }
}
async function loadWeek() {
  const fromIso = weekStart + "T00:00:00.000Z";
  const toIso = ui.addDays(weekStart, 8) + "T00:00:00.000Z";
  const data = await ui.api(ui.tenantPath() + "/time-entries?from=" + encodeURIComponent(fromIso) + "&to=" + encodeURIComponent(toIso));
  const weekEnd = ui.addDays(weekStart, 6);
  const byDay = new Map();
  let weekSeconds = 0;
  let todaySeconds = 0;
  const today = ui.todayStr();
  for (const e of data.entries) {
    const day = ui.localDate(new Date(e.started_at));
    if (day < weekStart || day > weekEnd) continue;
    const arr = byDay.get(day) || [];
    arr.push(e);
    byDay.set(day, arr);
    weekSeconds += e.duration_seconds;
    if (day === today) todaySeconds += e.duration_seconds;
  }
  $("weekLabel").textContent = weekStart + " 〜 " + weekEnd;
  $("weekTotal").textContent = ui.fmtHM(weekSeconds);
  $("todayTotal").textContent = ui.fmtHM(todaySeconds);
  const box = $("days");
  box.innerHTML = "";
  const days = Array.from(byDay.keys()).sort().reverse();
  if (days.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "この週の記録はありません";
    box.appendChild(p);
  }
  for (const day of days) {
    const entries = byDay.get(day).slice().sort((a, b) => a.started_at.localeCompare(b.started_at));
    const head = document.createElement("div");
    head.className = "dayhead";
    const h = document.createElement("strong");
    h.textContent = day;
    const sum = document.createElement("span");
    sum.className = "muted";
    sum.textContent = "合計 " + ui.fmtHM(entries.reduce((s, e) => s + e.duration_seconds, 0));
    head.append(h, sum);
    box.appendChild(head);
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (const e of entries) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = e.task_id ? (taskTitleById.get(e.task_id) || "（タスク）") : "（タスクなし）";
      const td2 = document.createElement("td");
      const start = new Date(e.started_at);
      td2.textContent = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " 〜 " +
        (e.ended_at ? new Date(e.ended_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "実行中");
      const td3 = document.createElement("td");
      td3.textContent = ui.fmtHMS(e.duration_seconds);
      if (e.long_running) {
        const s = document.createElement("span");
        s.className = "warn"; s.textContent = " 長時間";
        td3.appendChild(s);
      }
      const td4 = document.createElement("td");
      if (e.running) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = "停止";
        b.onclick = async () => {
          try { await ui.api(ui.tenantPath() + "/timer/stop", ui.jsonOpts("POST")); await ui.refreshTimerChip(); await loadWeek(); }
          catch (err) { $("msg").textContent = err.message; }
        };
        td4.appendChild(b);
      } else {
        const be = document.createElement("button");
        be.type = "button"; be.className = "secondary"; be.textContent = "編集";
        be.onclick = () => startEdit(e);
        const bd = document.createElement("button");
        bd.type = "button"; bd.className = "secondary"; bd.textContent = "削除";
        bd.style.marginLeft = ".4rem";
        bd.onclick = async () => {
          if (!confirm("この工数記録を削除しますか？")) return;
          try { await ui.api(ui.tenantPath() + "/time-entries/" + e.id, { method: "DELETE" }); await loadWeek(); }
          catch (err) { $("msg").textContent = err.message; }
        };
        td4.append(be, bd);
      }
      tr.append(td1, td2, td3, td4);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
  }
}
function startEdit(e) {
  editingId = e.id;
  $("manualTitle").textContent = "工数を編集";
  $("manualSubmit").textContent = "保存する";
  $("manualCancel").style.display = "";
  const start = new Date(e.started_at);
  const end = e.ended_at ? new Date(e.ended_at) : new Date(e.started_at);
  $("mDate").value = ui.localDate(start);
  $("mStart").value = String(start.getHours()).padStart(2, "0") + ":" + String(start.getMinutes()).padStart(2, "0");
  $("mEnd").value = String(end.getHours()).padStart(2, "0") + ":" + String(end.getMinutes()).padStart(2, "0");
  fillManualTasks().then(() => { if (e.task_id) $("mTask").value = e.task_id; });
  $("manualForm").scrollIntoView({ behavior: "smooth", block: "start" });
}
function resetManual() {
  editingId = null;
  $("manualTitle").textContent = "手入力で追加";
  $("manualSubmit").textContent = "追加する";
  $("manualCancel").style.display = "none";
  $("manualForm").reset();
  $("mDate").value = ui.todayStr();
}
async function fillManualTasks() {
  const sel = $("mTask");
  sel.innerHTML = "";
  for (const p of ui.projects().slice(0, 20)) {
    const data = await ui.api(p.path + "/tasks").catch(() => ({ tasks: [] }));
    for (const t of data.tasks) {
      const o = document.createElement("option");
      o.value = t.id; o.textContent = p.name + " / " + t.title;
      sel.appendChild(o);
    }
  }
}
ui.onReady(async () => {
  weekStart = computeWeekStart(ui.todayStr());
  await loadTaskIndex();
  const projSel = $("tProject");
  ui.fillSelect(projSel, ui.projects(), (p) => p.id, (p) => p.name);
  const cur = ui.currentProject();
  if (cur) projSel.value = cur.id;
  const refreshTimerTasks = async () => {
    const p = ui.projects().find((x) => x.id === projSel.value);
    await fillTaskSelect($("tTask"), p, true);
  };
  projSel.onchange = refreshTimerTasks;
  await refreshTimerTasks();
  $("timerForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const p = ui.projects().find((x) => x.id === projSel.value);
    if (!p) { $("msg").textContent = "プロジェクトがありません"; return; }
    try {
      const taskId = $("tTask").value;
      if (taskId) await ui.api(ui.tenantPath() + "/timer/start", ui.jsonOpts("POST", { task_id: taskId }));
      else await ui.api(ui.tenantPath() + "/timer/start", ui.jsonOpts("POST", { workspace_id: p.workspaceId }));
      await ui.refreshTimerChip();
      await loadWeek();
    } catch (e) { $("msg").textContent = e.message; }
  };
  await fillManualTasks();
  $("mDate").value = ui.todayStr();
  $("manualCancel").onclick = () => resetManual();
  $("manualForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const taskId = $("mTask").value;
    const started = new Date($("mDate").value + "T" + $("mStart").value + ":00");
    const ended = new Date($("mDate").value + "T" + $("mEnd").value + ":00");
    if (!(ended > started)) { $("msg").textContent = "終了は開始より後にしてください"; return; }
    try {
      if (editingId) {
        await ui.api(ui.tenantPath() + "/time-entries/" + editingId, ui.jsonOpts("PATCH", {
          started_at: started.toISOString(),
          ended_at: ended.toISOString(),
          task_id: taskId || null,
        }));
      } else {
        const path = taskProjectPathById.get(taskId);
        if (!path) { $("msg").textContent = "タスクを選んでください"; return; }
        await ui.api(path + "/tasks/" + taskId + "/time-entries", ui.jsonOpts("POST", {
          started_at: started.toISOString(),
          ended_at: ended.toISOString(),
        }));
      }
      resetManual();
      await loadTaskIndex();
      await loadWeek();
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("prevWeek").onclick = async () => { weekStart = ui.addDays(weekStart, -7); await loadWeek(); };
  $("nextWeek").onclick = async () => { weekStart = ui.addDays(weekStart, 7); await loadWeek(); };
  $("thisWeek").onclick = async () => { weekStart = computeWeekStart(ui.todayStr()); await loadWeek(); };
  await loadWeek();
});
`;

uiRoutes.get("/app/time", async (c) => {
  const prefs = await requirePrefs(c);
  if (!prefs) return c.redirect("/auth/login", 302);
  const locale = prefs.locale;
  const script = `const KOSU_WEEK_START_DOW = ${prefs.week_start};\n` + TIME_SCRIPT;
  return c.html(
    appPage(prefs, "time", t(locale, "time.title"), t(locale, "time.title"), TIME_HTML, script),
  );
});

/* ------------------------------------------------------------------ */
/* Gantt (in the app shell)                                             */
/* ------------------------------------------------------------------ */

const GANTT_HTML = `
<p class="muted">プロジェクトは画面上部の切替で変更できます。期間はタスクとマイルストーンの日付から自動で決まります。<a id="standaloneLink" href="#">単体ページで開く</a></p>
<div id="chart" style="overflow-x:auto"></div>
<h2>マイルストーン</h2>
<table><thead><tr><th scope="col">名前</th><th scope="col">日付</th></tr></thead><tbody id="milestoneRows"></tbody></table>`;

const GANTT_SCRIPT = `
const ui = window.KosuUI;
const $ = ui.$;
const DAY = 86400000, W = 16, ROW = 30;
const parseDay = (s) => { const p = s.split("-").map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
const fmtDay = (t) => { const d = new Date(t); return (d.getUTCMonth() + 1) + "/" + d.getUTCDate(); };
ui.onReady(async () => {
  const project = ui.currentProject();
  if (!project) { $("msg").textContent = "プロジェクトがありません"; return; }
  $("standaloneLink").href = "/app/projects/" + project.id + "/gantt";
  const data = await ui.api("/api/v1/projects/" + project.id + "/gantt");
  const tasks = data.tasks.filter((t) => t.start_date || t.due_date);
  let min = Infinity, max = -Infinity;
  const touch = (s) => { if (s) { const t = parseDay(s); min = Math.min(min, t); max = Math.max(max, t); } };
  tasks.forEach((t) => { touch(t.start_date); touch(t.due_date); });
  data.milestones.forEach((m) => touch(m.date));
  touch(data.project.starts_on); touch(data.project.due_on);
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  if (!isFinite(min)) { min = todayUtc - 7 * DAY; max = todayUtc + 30 * DAY; }
  min = Math.min(min, todayUtc) - 3 * DAY;
  max = Math.max(max, todayUtc) + 3 * DAY;
  const days = Math.round((max - min) / DAY) + 1;
  const width = days * W + 220, height = (tasks.length + 2) * ROW + 30;
  const x = (t) => 220 + Math.round((t - min) / DAY) * W;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "ガントチャート");
  const el = (name, attrs, text) => {
    const e = document.createElementNS(ns, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  for (let i = 0; i < days; i += 7) el("text", { x: x(min + i * DAY), y: 14, "font-size": 10, fill: "#667" }, fmtDay(min + i * DAY));
  el("line", { x1: x(todayUtc), y1: 18, x2: x(todayUtc), y2: height, stroke: "#d33", "stroke-width": 1 });
  const rowOf = new Map();
  tasks.forEach((t, i) => {
    const y = 24 + i * ROW;
    rowOf.set(t.id, y);
    el("text", { x: 4, y: y + 16, "font-size": 12 }, t.title.length > 24 ? t.title.slice(0, 24) + "…" : t.title);
    const s = t.start_date ? parseDay(t.start_date) : parseDay(t.due_date);
    const e = t.due_date ? parseDay(t.due_date) + DAY : s + DAY;
    const color = t.status === "done" ? "#3d9970" : t.status === "doing" ? "#2456c8" : "#7a7a8c";
    el("rect", { x: x(s), y: y + 5, width: Math.max(W, x(e) - x(s)), height: 14, rx: 3, fill: color });
    if (t.estimate_minutes) el("text", { x: x(e) + 4, y: y + 16, "font-size": 10, fill: "#667" }, "見積 " + t.estimate_minutes + "分");
  });
  const defs = document.createElementNS(ns, "defs");
  defs.innerHTML = '<marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="#666"/></marker>';
  svg.insertBefore(defs, svg.firstChild);
  data.dependencies.forEach((dep) => {
    const from = tasks.find((t) => t.id === dep.depends_on_task_id);
    const to = tasks.find((t) => t.id === dep.task_id);
    if (!from || !to) return;
    const x1 = x(from.due_date ? parseDay(from.due_date) + DAY : parseDay(from.start_date) + DAY);
    const y1 = rowOf.get(from.id) + 12;
    const x2 = x(parseDay(to.start_date || to.due_date));
    const y2 = rowOf.get(to.id) + 12;
    el("path", { d: "M" + x1 + " " + y1 + " L" + (x1 + 8) + " " + y1 + " L" + (x1 + 8) + " " + y2 + " L" + x2 + " " + y2, stroke: "#666", fill: "none", "marker-end": "url(#arr)" });
  });
  data.milestones.forEach((m) => {
    const mx = x(parseDay(m.date));
    el("path", { d: "M" + mx + " 20 l6 6 l-6 6 l-6 -6 z", fill: "#b97a1e" });
    el("text", { x: mx + 9, y: 30, "font-size": 11, fill: "#8a6414" }, m.name);
  });
  $("chart").appendChild(svg);
  if (tasks.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "開始予定・期限のあるタスクがまだありません。";
    $("chart").appendChild(p);
  }
  const mb = $("milestoneRows");
  if (data.milestones.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 2; td.className = "muted"; td.textContent = "マイルストーンはありません";
    tr.appendChild(td); mb.appendChild(tr);
  }
  for (const m of data.milestones) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td"); td1.textContent = m.name;
    const td2 = document.createElement("td"); td2.textContent = m.date;
    tr.append(td1, td2);
    mb.appendChild(tr);
  }
});
`;

uiRoutes.get("/app/gantt", async (c) => {
  const prefs = await requirePrefs(c);
  if (!prefs) return c.redirect("/auth/login", 302);
  const locale = prefs.locale;
  return c.html(
    appPage(prefs, "gantt", t(locale, "nav.gantt"), t(locale, "nav.gantt"), GANTT_HTML, GANTT_SCRIPT),
  );
});

/* ------------------------------------------------------------------ */
/* Reports                                                              */
/* ------------------------------------------------------------------ */

const REPORTS_HTML = `
<form id="reportForm">
<div class="toolbar">
  <label>期間（から） <input type="date" id="rFrom" required></label>
  <label>期間（まで） <input type="date" id="rTo" required></label>
  <label>集計単位
    <select id="rGroup">
      <option value="project">プロジェクト別</option>
      <option value="member">メンバー別</option>
      <option value="task">タスク別</option>
      <option value="day">日別</option>
    </select></label>
  <label>プロジェクト <select id="rProject"></select></label>
  <label><span>自分のみ</span><input type="checkbox" id="rMine"></label>
  <button type="submit">表示する</button>
</div>
<div class="toolbar">
  <button type="button" class="secondary" data-preset="week">今週</button>
  <button type="button" class="secondary" data-preset="lastweek">先週</button>
  <button type="button" class="secondary" data-preset="month">今月</button>
  <button type="button" class="secondary" data-preset="lastmonth">先月</button>
  <span class="spacer" style="flex:1"></span>
  <a id="rCsv" href="#">CSV をダウンロード</a>
  <a id="rJson" href="#" target="_blank" rel="noopener">JSON を開く</a>
  <a id="rPrint" href="#" target="_blank" rel="noopener">印刷・PDF 向け表示</a>
</div>
</form>
<table><thead><tr><th scope="col">項目</th><th scope="col">件数</th><th scope="col">実績</th><th scope="col">丸め後</th><th scope="col">コスト</th></tr></thead>
<tbody id="reportRows"></tbody>
<tfoot><tr><th scope="col">合計</th><th id="totEntries"></th><th id="totSeconds"></th><th id="totRounded"></th><th id="totCost"></th></tr></tfoot></table>
<p class="muted">コストは単価設定があるメンバーの分だけ集計されます。期間は開始日基準です。</p>`;

const REPORTS_SCRIPT = `
const ui = window.KosuUI;
const $ = ui.$;
function reportParams() {
  const params = new URLSearchParams();
  params.set("from", $("rFrom").value);
  params.set("to", $("rTo").value);
  params.set("group_by", $("rGroup").value);
  if ($("rProject").value) params.set("project_id", $("rProject").value);
  if ($("rMine").checked && ui.me()) params.set("account_id", ui.me().account.id);
  return params;
}
function syncLinks() {
  const base = ui.tenantPath() + "/report?";
  const p = reportParams();
  $("rCsv").href = base + p.toString() + "&format=csv";
  $("rJson").href = base + p.toString();
  const pp = reportParams();
  $("rPrint").href = ui.tenantPath() + "/report/print?" + pp.toString();
}
async function loadReport() {
  await ui.members();
  syncLinks();
  const data = await ui.api(ui.tenantPath() + "/report?" + reportParams().toString());
  const report = data.report;
  const groupBy = $("rGroup").value;
  const projectName = (id) => {
    const p = ui.projects().find((x) => x.id === id);
    return p ? p.name : (id === "none" ? "プロジェクトなし" : id);
  };
  const tbody = $("reportRows");
  tbody.innerHTML = "";
  if (report.groups.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5; td.className = "muted"; td.textContent = "この期間の記録はありません";
    tr.appendChild(td); tbody.appendChild(tr);
  }
  for (const g of report.groups) {
    const tr = document.createElement("tr");
    let label = g.label;
    if (groupBy === "project") label = projectName(g.key);
    if (groupBy === "member") label = ui.memberName(g.key);
    const cells = [
      label,
      String(g.entries),
      (g.seconds / 3600).toFixed(2) + " h",
      (g.rounded_seconds / 3600).toFixed(2) + " h",
      g.cost_cents ? (report.currency + " " + (g.cost_cents / 100).toLocaleString()) : "—",
    ];
    if (g.over_budget) cells[0] += "（予算超過）";
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  $("totEntries").textContent = String(report.totals.entries);
  $("totSeconds").textContent = (report.totals.seconds / 3600).toFixed(2) + " h";
  $("totRounded").textContent = (report.totals.rounded_seconds / 3600).toFixed(2) + " h";
  $("totCost").textContent = report.totals.cost_cents ? (report.currency + " " + (report.totals.cost_cents / 100).toLocaleString()) : "—";
}
function applyPreset(name) {
  const today = ui.todayStr();
  const parts = today.split("-").map(Number);
  if (name === "month" || name === "lastmonth") {
    let y = parts[0], m = parts[1];
    if (name === "lastmonth") { m -= 1; if (m === 0) { m = 12; y -= 1; } }
    const first = y + "-" + String(m).padStart(2, "0") + "-01";
    const next = m === 12 ? (y + 1) + "-01-01" : y + "-" + String(m + 1).padStart(2, "0") + "-01";
    $("rFrom").value = first;
    $("rTo").value = ui.addDays(next, -1);
  } else {
    const dow = ((new Date().getUTCDay() + 6) % 7) + 1;
    let start = today;
    const probe = new Date();
    const probeDow = ((probe.getDay() + 6) % 7) + 1;
    void dow;
    start = ui.addDays(today, -(probeDow - 1));
    if (name === "lastweek") start = ui.addDays(start, -7);
    $("rFrom").value = start;
    $("rTo").value = ui.addDays(start, 6);
  }
}
ui.onReady(async () => {
  applyPreset("month");
  const sel = $("rProject");
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = ""; all.textContent = "すべて";
  sel.appendChild(all);
  for (const p of ui.projects()) {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  }
  document.querySelectorAll("[data-preset]").forEach((b) => {
    b.onclick = () => { applyPreset(b.getAttribute("data-preset")); loadReport().catch((e) => { $("msg").textContent = e.message; }); };
  });
  $("reportForm").onsubmit = (ev) => {
    ev.preventDefault();
    loadReport().catch((e) => { $("msg").textContent = e.message; });
  };
  for (const id of ["rFrom", "rTo", "rGroup", "rProject", "rMine"]) {
    $(id).addEventListener("change", syncLinks);
  }
  await loadReport();
});
`;

uiRoutes.get("/app/reports", async (c) => {
  const prefs = await requirePrefs(c);
  if (!prefs) return c.redirect("/auth/login", 302);
  const locale = prefs.locale;
  return c.html(
    appPage(prefs, "reports", t(locale, "reports.title"), t(locale, "reports.title"), REPORTS_HTML, REPORTS_SCRIPT),
  );
});

/* ------------------------------------------------------------------ */
/* Settings hub                                                         */
/* ------------------------------------------------------------------ */

const SETTINGS_HTML = `
<h2>プロフィール</h2>
<div class="kv" id="profile"></div>
<h2>暗号化キー</h2>
<div id="vaultSlot"></div>
<h2>API キー</h2>
<p class="muted">MCP やスクリプトからの接続に使います。平文のキーは発行時に1回だけ表示します。</p>
<table><thead><tr><th scope="col">名前</th><th scope="col">接頭辞</th><th scope="col">スコープ</th><th scope="col">作成</th><th scope="col">最終利用</th><th scope="col">状態</th><th scope="col"></th></tr></thead><tbody id="keyRows"></tbody></table>
<form id="keyForm">
<div class="toolbar">
  <label>名前 <input type="text" id="kName" required size="24"></label>
  <label>スコープ
    <select id="kScopes">
      <option value="read,write">読み書き</option>
      <option value="read">読み取りのみ</option>
    </select></label>
  <label>許可 IP / CIDR（任意・カンマ区切り） <input type="text" id="kIps" size="28"></label>
  <button type="submit">発行する</button>
</div>
</form>
<div class="card" id="keyPlain" style="display:none"></div>
<h2>利用量</h2>
<div class="kv" id="usage"></div>
<h2>その他の設定・ページ</h2>
<ul>
<li><a href="/app/settings/integrations">外部連携・MCP 設定（Linear / GitHub / Slack / TimeCrowd、iCal、メール受付、書き出し）</a></li>
<li><a href="/app/preferences">表示設定（テーマ・言語・週の開始曜日）</a></li>
<li><a href="/app/onboarding">初期設定（ガイドとサンプルデータ）</a></li>
<li><a href="/app/conflicts">同期の競合を確認する</a></li>
<li><a href="/terms">利用規約</a> ／ <a href="/privacy">プライバシーポリシー</a></li>
</ul>`;

const SETTINGS_SCRIPT = `
const ui = window.KosuUI;
const $ = ui.$;
async function loadKeys() {
  const data = await ui.api(ui.tenantPath() + "/api-keys");
  const tbody = $("keyRows");
  tbody.innerHTML = "";
  if (data.keys.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7; td.className = "muted"; td.textContent = "API キーはまだありません";
    tr.appendChild(td); tbody.appendChild(tr);
  }
  for (const k of data.keys) {
    const tr = document.createElement("tr");
    const cells = [
      k.name,
      k.prefix + "…",
      (k.scopes || []).join(", "),
      new Date(k.created_at).toLocaleDateString(),
      k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "—",
      k.revoked_at ? "失効済み" : "有効",
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    const ops = document.createElement("td");
    if (!k.revoked_at) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "secondary"; b.textContent = "失効";
      b.onclick = async () => {
        if (!confirm("API キー「" + k.name + "」を失効しますか？")) return;
        try { await ui.api(ui.tenantPath() + "/api-keys/" + k.id, { method: "DELETE" }); await loadKeys(); }
        catch (e) { $("msg").textContent = e.message; }
      };
      ops.appendChild(b);
    }
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}
ui.onReady(async () => {
  const me = ui.me();
  const prof = $("profile");
  const rows = [
    ["名前", me.account.display_name || "（未設定）"],
    ["メール", me.account.email || "（未設定）"],
    ["アカウント ID", me.account.id],
    ["既定テナント", (me.tenants.find((x) => x.id === me.account.default_tenant_id) || {}).name || "—"],
    ["所属テナント", me.tenants.map((x) => x.name + "（" + x.role + "）").join("、")],
  ];
  for (const [k, v] of rows) {
    const dk = document.createElement("div"); dk.className = "muted"; dk.textContent = k;
    const dv = document.createElement("div"); dv.textContent = v;
    prof.append(dk, dv);
  }
  $("vaultSlot").innerHTML = VAULT_HTML;
  await initVaultPanel(ui);
  await loadKeys();
  $("keyForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const body = { name: $("kName").value, scopes: $("kScopes").value.split(",") };
      const ips = $("kIps").value.trim();
      if (ips) body.ip_allowlist = ips.split(",").map((s) => s.trim()).filter(Boolean);
      const r = await ui.api(ui.tenantPath() + "/api-keys", ui.jsonOpts("POST", body));
      const box = $("keyPlain");
      box.style.display = "";
      box.innerHTML = "";
      const strong = document.createElement("strong");
      strong.textContent = "発行しました。この平文は再表示できません：";
      const code = document.createElement("code");
      code.textContent = r.api_key;
      box.append(strong, document.createElement("br"), code);
      $("kName").value = "";
      await loadKeys();
    } catch (e) { $("msg").textContent = e.message; }
  };
  const u = await ui.api(ui.tenantPath() + "/usage").catch(() => null);
  const usageBox = $("usage");
  if (u) {
    const fmtLimit = (v) => v === null || v === undefined ? "無制限" : String(v);
    const urows = [
      ["メンバー数", String(u.usage.members) + " / " + fmtLimit(u.limits.max_members)],
      ["タスク数", String(u.usage.tasks) + " / " + fmtLimit(u.limits.max_tasks)],
      ["添付容量", (u.usage.attachment_bytes / 1024).toFixed(1) + " KiB / " + (u.limits.max_attachment_bytes == null ? "無制限" : (u.limits.max_attachment_bytes / 1024).toFixed(1) + " KiB")],
    ];
    for (const [k, v] of urows) {
      const dk = document.createElement("div"); dk.className = "muted"; dk.textContent = k;
      const dv = document.createElement("div"); dv.textContent = v;
      usageBox.append(dk, dv);
    }
  } else {
    usageBox.textContent = "利用量は取得できませんでした";
  }
});
`;

uiRoutes.get("/app/settings", async (c) => {
  const prefs = await requirePrefs(c);
  if (!prefs) return c.redirect("/auth/login", 302);
  const locale = prefs.locale;
  const script =
    VAULT_PANEL_SCRIPT +
    "\n" +
    SETTINGS_SCRIPT.replaceAll("VAULT_HTML", JSON.stringify(VAULT_PANEL_HTML));
  return c.html(
    appPage(prefs, "settings", t(locale, "settings.title"), t(locale, "settings.title"), SETTINGS_HTML, script),
  );
});
