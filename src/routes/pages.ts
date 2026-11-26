/**
 * Server-rendered pages. Data is loaded client-side from the JSON API
 * so the pages double as living API documentation. No external assets;
 * rendering is plain HTML/CSS/SVG. This module owns the shared shell
 * (styles, command palette, theme/locale handling) and the phase 2-5
 * pages; the phase 6 Web UI (landing, dashboard, tasks, time, gantt,
 * reports, settings) lives in src/routes/ui.ts.
 *
 *   GET /app/projects/:projectId/gantt    Gantt chart (standalone)
 *   GET /app/conflicts                    sync conflict resolution
 *   GET /app/settings/integrations        integration settings
 *   GET /app/preferences                  display preferences
 *   GET /app/onboarding                   getting-started wizard
 *   GET /invite/:token                    invite landing / accept
 */
import { Hono } from "hono";
import { readSessionAccountId } from "../session";
import { getUserPrefs, type UserPrefs } from "../prefs";
import { t, type MessageKey } from "../i18n";
import type { Env, Variables } from "../types";
import type { Ctx } from "./http";

export const pageRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const darkRules = (root: string): string => `
${root} { color-scheme: dark; }
${root} body { background: #14141c; color: #e9e9f2; }
${root} .card { border-top-color: #8fb0ff; }
${root} td, ${root} th { border-bottom-color: #33334a; }
${root} .muted { color: #a2a2ba; }
${root} a { color: #8fb0ff; }
${root} button.secondary { background: #26263a; color: #8fb0ff; border-color: #8fb0ff; }
${root} input, ${root} select, ${root} textarea { background: #1d1d2a; color: #e9e9f2; border: 1px solid #3a3a4f; }
${root} #palette { background: #1d1d2a; color: #e9e9f2; border-color: #3a3a4f; }
${root} .topbar, ${root} .detail { border-color: #3a3a4f; }
${root} .sidebar nav a:hover { background: #26263a; }
${root} .sidebar nav a.active { background: #2456c8; color: #fff; }
${root} .tag { border-color: #3a3a4f; }
${root} .chip { background: #26263a; color: #8fb0ff; border-color: #8fb0ff; }
${root} .timer-chip { background: #1d2a4a; border-color: #35507e; }
${root} .comment { border-bottom-color: #33334a; }
${root} .dayhead { border-bottom-color: #3a3a4f; }
${root} .toast { background: #26263a; color: #e9e9f2; border-color: #8fb0ff; }
`;


/** Design tokens for the dark theme (docs/DESIGN_SYSTEM.md). */
const darkTokens = (root: string) => `
${root} { --brand: #8fb0ff; --ink: #e9e9f2; --muted: #a2a2ba; --line: #33334a; --line-strong: #3a3a4f; --bg: #14141c; --panel: #26263a; --danger: #ff8a94; --warn: #e8a33d; --ok: #5fc598; }
`;

export const STYLE = `
:root { color-scheme: light; }
/* Kosu design tokens — the single source of truth is docs/DESIGN_SYSTEM.md.
   Components reference these variables; raw hex values live only here and
   in darkTokens()/darkRules() above. */
:root {
  --brand: #2456c8; --brand-contrast: #ffffff;
  --ink: #1a1a2e; --muted: #666677; --line: #e3e3ee; --line-strong: #ccd;
  --bg: #ffffff; --panel: #f0f0f4;
  --danger: #b00020; --warn: #b3541e; --ok: #3d9970; --focus: #c96a00;
  --gantt-todo: #7a7a8c; --gantt-doing: #2456c8; --gantt-done: #3d9970; --gantt-milestone: #b97a1e;
  --radius-chip: 4px; --radius-control: 6px;
  --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem; --space-6: 1.5rem; --space-8: 2rem;
}
@media (prefers-color-scheme: dark) {
${darkRules(':root:not([data-theme="light"])')}
${darkTokens(':root:not([data-theme="light"])')}
}
${darkRules(':root[data-theme="dark"]')}
${darkTokens(':root[data-theme="dark"]')}
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; color: var(--ink); }
body.wide { max-width: 1320px; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
.cards { display: flex; gap: 1.5rem 2rem; flex-wrap: wrap; }
.card { border: 0; border-top: 3px solid var(--brand); border-radius: 0; padding: .6rem 0 0; min-width: 180px; }
.card .big { font-size: 1.8rem; font-weight: 700; }
.muted { color: #667; font-size: .85rem; }
table { border-collapse: collapse; width: 100%; }
td, th { border-bottom: 1px solid #e3e3ee; padding: .4rem .5rem; text-align: left; }
button { background: var(--brand); color: #fff; border: 0; border-radius: 6px; padding: .55rem 1.1rem; cursor: pointer; }
button.secondary { background: #fff; color: var(--brand); border: 1px solid var(--brand); }
.warn { color: var(--warn); font-weight: 600; }
.err { color: var(--danger); }
a { color: var(--brand); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.skip { position: absolute; left: -9999px; top: 0; background: var(--brand); color: #fff; padding: .6rem 1rem; z-index: 50; }
.skip:focus { left: 0; }
#palette { border: 2px solid var(--brand); border-radius: 0; padding: 1rem; width: min(560px, 92vw); }
#palette input { width: 100%; padding: .5rem; font-size: 1rem; box-sizing: border-box; }
#palette ul { list-style: none; margin: .5rem 0 0; padding: 0; max-height: 320px; overflow: auto; }
#palette li { padding: .45rem .5rem; border-radius: 6px; cursor: pointer; }
#palette li[aria-selected="true"] { background: var(--brand); color: #fff; }
/* Phase 6 app layout (sidebar shell used by src/routes/ui.ts) */
.layout { display: flex; gap: 1.5rem; align-items: flex-start; }
.sidebar { width: 190px; flex: none; position: sticky; top: 1rem; }
.sidebar .brand { font-size: 1.25rem; font-weight: 700; margin-bottom: .75rem; display: flex; align-items: center; gap: .55rem; }
.sidebar .brand img { display: block; }
.sidebar nav a { display: block; padding: .45rem .6rem; border-radius: 6px; text-decoration: none; color: inherit; }
.sidebar nav a:hover { background: #ececf1; }
.sidebar nav a.active { background: var(--brand); color: #fff; }
.sidebar .side-sec { margin-top: 1.25rem; }
.content { flex: 1; min-width: 0; }
.content h1:first-child { margin-top: 0; }
.topbar { display: flex; flex-wrap: wrap; gap: .6rem 1rem; align-items: center; border: 0; border-bottom: 2px solid #ccd; border-radius: 0; padding: .6rem 0; margin-bottom: 1.25rem; }
.topbar select { max-width: 190px; }
.topbar .spacer { flex: 1; }
.timer-chip { display: inline-flex; gap: .5rem; align-items: center; background: #fff; border: 2px solid var(--brand); border-radius: 4px; padding: .3rem .4rem .3rem .8rem; font-variant-numeric: tabular-nums; }
.timer-chip button { padding: .25rem .7rem; border-radius: 4px; }
.toolbar { display: flex; flex-wrap: wrap; gap: .6rem; align-items: flex-end; margin: 1rem 0; }
.toolbar label { display: flex; flex-direction: column; gap: .25rem; font-size: .82rem; }
.tag { display: inline-block; border: 1px solid #ccd; border-left: 6px solid #99a; border-radius: 4px; padding: .05rem .45rem; font-size: .78rem; margin-right: .3rem; }
.chip { display: inline-block; border: 1px solid var(--brand); border-radius: 4px; padding: .05rem .55rem; font-size: .78rem; background: #fff; color: var(--brand); }
.due-over { color: var(--danger); font-weight: 600; }
.due-soon { color: var(--warn); font-weight: 600; }
.split { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 1.5rem; align-items: start; }
.detail { border: 0; border-top: 3px solid var(--brand); border-radius: 0; padding: .6rem 0 0; }
.detail h2 { margin-top: 0; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem 1rem; }
.form-grid label { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; }
.form-grid .full { grid-column: 1 / -1; }
textarea { width: 100%; box-sizing: border-box; }
input[type="date"], input[type="time"], input[type="text"], input[type="number"], input[type="password"], select { padding: .35rem .45rem; }
.comment { border-bottom: 1px solid #e3e3ee; padding: .5rem 0; }
.dayhead { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #ccd; padding-bottom: .25rem; margin-top: 1.5rem; }
.kv { display: grid; grid-template-columns: 150px 1fr; gap: .3rem .8rem; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: #f0f0f4; }
td a { display: inline-block; padding: .3rem .15rem; margin: -.3rem -.15rem; }
#busybar { position: fixed; top: 0; left: 0; height: 3px; width: 35%; background: var(--brand); z-index: 90; display: none; animation: kosu-busy 1.1s ease-in-out infinite; }
.toast.static { position: static; display: block; }
.toast { position: fixed; right: 12px; bottom: 12px; z-index: 70; background: #fff; color: var(--ink); border: 1px solid var(--brand); border-left: 4px solid var(--brand); padding: .6rem .9rem; font-size: .9rem; display: none; max-width: 82vw; }
@keyframes kosu-busy { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
@media (max-width: 860px) {
  .layout { flex-direction: column; }
  .sidebar { width: 100%; position: static; }
  .sidebar nav { display: flex; flex-wrap: wrap; gap: .25rem; }
  .sidebar nav a { display: inline-block; }
  .split { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: 1fr; }
  button { min-height: 44px; }
  input, select, textarea { min-height: 40px; }
  .sidebar nav a { padding: .7rem .8rem; }
  .timer-chip button { min-height: 36px; }
  .topbar select { max-width: 150px; }
}
.site-footer { margin-top: 3rem; border-top: 1px solid #ccd; padding-top: 1rem; font-size: .85rem; color: #667; display: flex; gap: .4rem 1.25rem; flex-wrap: wrap; align-items: baseline; }
.timer-dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--danger); flex: none; animation: kosu-pulse 1.6s ease-in-out infinite; }
.bars .bar { transform-origin: left center; transform-box: fill-box; animation: kosu-grow .5s ease-out; }
main { animation: kosu-fade .25s ease-out; }
#palette { animation: kosu-fade .18s ease-out; }
button, .sidebar nav a { transition: background-color .15s ease, color .15s ease; }
@keyframes kosu-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes kosu-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes kosu-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .2; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
`;

/** Short content hash for cache-busting asset URLs (FNV-1a, hex). */
export function assetHash(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Versioned asset URL: /assets/<name>-<hash>.<ext> (immutable caching). */
export function assetUrl(name: string, ext: string, content: string): string {
  return `/assets/${name}-${assetHash(content)}.${ext}`;
}

/** The shared stylesheet, served as a cacheable external asset (phase 8). */
export const STYLE_URL = assetUrl("style", "css", STYLE);

export interface ShellOptions {
  prefs?: UserPrefs | null;
  /** Include the command palette + service worker (app pages). */
  appChrome?: boolean;
  /** Widen the content column (phase 6 app layout). */
  wide?: boolean;
  /** External scripts (hashed asset URLs) emitted before the inline script. */
  scripts?: string[];
}

export function shell(
  title: string,
  body: string,
  script: string,
  opts: ShellOptions = {},
): string {
  const prefs = opts.prefs ?? null;
  const locale = prefs?.locale ?? "ja";
  const themeAttr =
    prefs && prefs.theme !== "system" ? ` data-theme="${prefs.theme}"` : "";
  const palette = opts.appChrome
    ? `<dialog id="palette" aria-label="コマンドパレット">
<input id="paletteInput" type="text" role="combobox" aria-expanded="true" aria-controls="paletteList" aria-autocomplete="list" aria-label="コマンドパレット検索" placeholder="${t(locale, "palette.placeholder")}">
<ul id="paletteList" role="listbox"></ul>
</dialog>`
    : "";
  const chrome = opts.appChrome ? `<script src="${PALETTE_URL}"></script>` : "";
  const sw = opts.appChrome
    ? `<script>if ("serviceWorker" in navigator) { navigator.serviceWorker.register("/sw.js").catch(() => {}); }</script>`
    : "";
  const assetTags = (opts.scripts ?? [])
    .map((u) => `<script src="${u}"></script>`)
    .join("");
  return `<!doctype html>
<html lang="${locale}"${themeAttr}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2456c8">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/icons/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")} — Kosu</title><link rel="stylesheet" href="${STYLE_URL}"></head>
<body${opts.wide ? ' class="wide"' : ""}><a class="skip" href="#main">本文へ移動</a><main id="main">${body}</main><footer class="site-footer"><span>Kosu</span><a href="/terms">${t(locale, "nav.terms")}</a><a href="/privacy">${t(locale, "nav.privacy")}</a><a href="/health">/health (JSON)</a></footer>${palette}${assetTags}<script>${script}</script>${chrome}${sw}</body></html>`;
}

/** Command palette (phase 5 item 10): Cmd/Ctrl+K opens a dialog that
 * searches tasks across the default tenant's projects, creates a task
 * in the first project, and jumps between app pages. */
export const PALETTE_JS = `
(() => {
  const dlg = document.getElementById("palette");
  if (!dlg) return;
  const input = document.getElementById("paletteInput");
  const list = document.getElementById("paletteList");
  let items = [];
  let selected = 0;
  let tenantId = null;
  let firstProjectPath = null;
  let createMode = false;
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
  async function projectPaths() {
    const paths = [];
    const wss = (await api("/api/v1/tenants/" + tenantId + "/workspaces")).workspaces;
    for (const w of wss) {
      const teams = (await api("/api/v1/tenants/" + tenantId + "/workspaces/" + w.id + "/teams")).teams;
      for (const tm of teams) {
        const ps = (await api("/api/v1/tenants/" + tenantId + "/workspaces/" + w.id + "/teams/" + tm.id + "/projects")).projects;
        for (const p of ps) paths.push({ id: p.id, name: p.name, path: "/api/v1/tenants/" + tenantId + "/workspaces/" + w.id + "/teams/" + tm.id + "/projects/" + p.id });
      }
    }
    return paths;
  }
  function render() {
    list.innerHTML = "";
    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.id = "palette-item-" + i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", i === selected ? "true" : "false");
      li.textContent = item.label;
      li.onclick = () => choose(item);
      list.appendChild(li);
    });
    input.setAttribute("aria-activedescendant", items.length ? "palette-item-" + selected : "");
  }
  async function refresh() {
    const q = input.value.trim().toLowerCase();
    items = [];
    if (createMode) {
      items.push({ label: "作成: " + input.value, run: async () => {
        if (!firstProjectPath) return;
        await api(firstProjectPath + "/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: input.value.trim() }) });
        location.href = "/app";
      }});
      render();
      return;
    }
    items.push({ label: "タスクを作成", run: () => { createMode = true; input.value = ""; input.placeholder = "タスク名を入力して Enter"; refresh(); } });
    items.push({ label: "ダッシュボードへ移動", run: () => { location.href = "/app"; } });
    items.push({ label: "表示設定へ移動", run: () => { location.href = "/app/preferences"; } });
    items.push({ label: "初期設定へ移動", run: () => { location.href = "/app/onboarding"; } });
    if (q) {
      try {
        const paths = await projectPaths();
        for (const p of paths) {
          const data = await api(p.path + "/tasks?limit=100");
          for (const task of data.tasks) {
            if (task.title.toLowerCase().includes(q)) {
              items.push({ label: task.title + "（" + p.name + "）", run: () => { location.href = "/app/projects/" + p.id + "/gantt"; } });
            }
          }
        }
      } catch (e) { /* palette search is best-effort */ }
      items = items.filter((it, i) => i < 3 || it.label.toLowerCase().includes(q));
    }
    selected = 0;
    render();
  }
  async function choose(item) {
    if (!item) return;
    dlg.close();
    await item.run();
  }
  input.addEventListener("input", () => { selected = 0; refresh(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); selected = Math.min(selected + 1, items.length - 1); render(); }
    if (ev.key === "ArrowUp") { ev.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
    if (ev.key === "Enter") { ev.preventDefault(); choose(items[selected]); }
  });
  document.addEventListener("keydown", async (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      if (!tenantId) {
        try {
          const me = await api("/api/v1/me");
          tenantId = me.account.default_tenant_id || (me.tenants[0] && me.tenants[0].id);
          const paths = await projectPaths();
          firstProjectPath = paths.length ? paths[0].path : null;
        } catch (e) { return; }
      }
      createMode = false;
      input.value = "";
      dlg.showModal();
      refresh();
      input.focus();
    }
  });
})();
`;

/** Command palette script, served as a cacheable external asset (phase 8). */
export const PALETTE_URL = assetUrl("palette", "js", PALETTE_JS);

/**
 * Offline support (phase 9): wraps window.fetch on app pages.
 * Mutations to /api/v1/ made while the network is down are stored in
 * an IndexedDB outbox and replayed in order when connectivity
 * returns; a small status bar explains the state. Timer start/stop
 * are stamped with the client-side moment so queued calls keep the
 * real times. One-shot secret responses (API keys, tokens, the
 * encryption key) are never queued: they fail fast instead.
 */
export const OFFLINE_JS = `
(function () {
  if (window.__kosuOffline) return;
  window.__kosuOffline = true;
  var rawFetch = window.fetch.bind(window);
  var EXCLUDED = ["api-keys", "encryption-key", "/export", "share-tokens", "intake-tokens", "ical-feeds", "/tokens"];
  function excluded(url) { return EXCLUDED.some(function (s) { return url.indexOf(s) >= 0; }); }

  /* ---------------- IndexedDB outbox ---------------- */
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("kosu-offline", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("outbox", { autoIncrement: true }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction("outbox", mode);
        var store = t.objectStore("outbox");
        var out = fn(store);
        t.oncomplete = function () { resolve(out && out.__result); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  function enqueue(item) {
    return tx("readwrite", function (store) { store.add(item); }).then(refreshBar);
  }
  function allItems() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var items = [];
        var t = db.transaction("outbox", "readonly");
        var req = t.objectStore("outbox").openCursor();
        req.onsuccess = function () {
          var cur = req.result;
          if (cur) { items.push({ key: cur.key, value: cur.value }); cur.continue(); }
          else resolve(items);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function removeItem(key) {
    return tx("readwrite", function (store) { store.delete(key); });
  }
  function countItems() { return allItems().then(function (i) { return i.length; }); }

  /* ---------------- status bar ---------------- */
  var dropped = 0;
  function bar() {
    var el = document.getElementById("kosuOfflineBar");
    if (!el) {
      el = document.createElement("div");
      el.id = "kosuOfflineBar";
      el.setAttribute("role", "status");
      el.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:60;background:#ffffff;color:#1a1a2e;border:1px solid #2456c8;border-left:4px solid #2456c8;padding:8px 12px;font-size:13px;max-width:82vw;display:none";
      document.body.appendChild(el);
    }
    return el;
  }
  function refreshBar() {
    return countItems().then(function (n) {
      var el = bar();
      var parts = [];
      if (!navigator.onLine) parts.push("オフラインです。前回取得したデータを表示しています。");
      if (n > 0) parts.push("未送信の変更が " + n + " 件あります。オンラインに戻ると自動で送信します。");
      if (dropped > 0) parts.push("送信できなかった変更が " + dropped + " 件あります（権限や競合で却下）。");
      el.textContent = parts.join(" ");
      el.style.display = parts.length ? "" : "none";
    }).catch(function () {});
  }

  /* ---------------- fetch wrapper ---------------- */
  function isApiMutation(input, init) {
    var url = typeof input === "string" ? input : input.url;
    var method = ((init && init.method) || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") return null;
    var u = new URL(url, location.origin);
    if (u.origin !== location.origin) return null;
    if (!u.pathname.startsWith("/api/v1/")) return null;
    if (excluded(u.pathname)) return null;
    return { url: u.pathname + u.search, method: method };
  }
  window.fetch = function (input, init) {
    var meta = isApiMutation(input, init || {});
    if (!meta) return rawFetch(input, init);
    return rawFetch(input, init).catch(function (err) {
      var body = init && init.body !== undefined && init.body !== null ? init.body : "";
      if (typeof body !== "string") throw err; // uploads etc. are not queued
      var stamped = body;
      try {
        var parsed = JSON.parse(body || "{}");
        if (meta.url.indexOf("/timer/start") >= 0 && !parsed.client_started_at) parsed.client_started_at = new Date().toISOString();
        if (meta.url.indexOf("/timer/stop") >= 0 && !parsed.client_stopped_at) parsed.client_stopped_at = new Date().toISOString();
        stamped = JSON.stringify(parsed);
      } catch (e) { /* not JSON: queue as-is */ }
      return enqueue({ url: meta.url, method: meta.method, body: stamped, queuedAt: new Date().toISOString() }).then(function () {
        return new Response(JSON.stringify({ queued: true, offline: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      });
    });
  };

  /* ---------------- flush ---------------- */
  var flushing = false;
  function flush() {
    if (flushing || !navigator.onLine) return;
    flushing = true;
    allItems().then(function (items) {
      var chain = Promise.resolve();
      items.forEach(function (item) {
        chain = chain.then(function () {
          var opts = { method: item.value.method };
          if (item.value.body) {
            opts.headers = { "content-type": "application/json" };
            opts.body = item.value.body;
          }
          return rawFetch(item.value.url, opts).then(function (r) {
            if (r.ok) return removeItem(item.key);
            if (r.status >= 400 && r.status < 500) { dropped++; return removeItem(item.key); }
            throw new Error("retry later");
          });
        });
      });
      return chain;
    }).catch(function () { /* keep the rest for the next flush */ })
      .then(function () { flushing = false; refreshBar(); });
  }
  window.addEventListener("online", function () { refreshBar(); flush(); });
  window.addEventListener("offline", refreshBar);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { refreshBar(); flush(); });
  else { refreshBar(); flush(); }
  setInterval(function () { if (navigator.onLine) flush(); }, 60000);
})();
`;
export const OFFLINE_URL = assetUrl("offline", "js", OFFLINE_JS);

export async function sessionAccountId(c: Ctx): Promise<string | null> {
  return readSessionAccountId(
    c.env,
    c.req.header("cookie") ?? null,
    c.req.url,
  );
}

async function loggedIn(c: Ctx): Promise<boolean> {
  return (await sessionAccountId(c)) !== null;
}

export async function prefsFor(c: Ctx): Promise<UserPrefs | null> {
  const accountId = await sessionAccountId(c);
  if (!accountId) return null;
  return getUserPrefs(c.env, accountId);
}

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
      const color = t.status === "done" ? "#3d9970" : t.status === "doing" ? "#2456c8" : "#7a7a8c";
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
      el("path", { d: "M" + mx + " 20 l6 6 l-6 6 l-6 -6 z", fill: "#b97a1e" });
      el("text", { x: mx + 9, y: 30, "font-size": 11, fill: "#8a6414" }, m.name);
    });
    $("chart").appendChild(svg);
    if (tasks.length === 0) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "開始予定・期限のあるタスクがまだありません。"; $("chart").appendChild(p); }
  } catch (err) {
    $("msg").textContent = "読み込みに失敗しました: " + err.message;
  }
})();
`;
  return c.html(
    shell("ガント", body, script, {
      prefs: await prefsFor(c),
      appChrome: true,
    }),
  );
});

pageRoutes.get("/app/conflicts", async (c) => {
  if (!(await loggedIn(c))) return c.redirect("/auth/login", 302);
  const body = `
<h1>同期の競合</h1>
<p class="muted"><a href="/app">← ダッシュボード</a></p>
<p class="muted">オフライン中の変更がサーバー側とぶつかった項目です。フィールドごとに両方を見比べて、どちらを採用するか選んでください。</p>
<div id="list"><p class="muted">読み込み中…</p></div>
<p id="msg" class="err"></p>`;
  const script = `
const $ = (id) => document.getElementById(id);
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { const t = await r.text(); throw new Error(r.status + " " + t); }
  return r.json();
}
function fmtVal(v) {
  if (v === null || v === undefined) return "（なし）";
  if (typeof v === "string") return v.length > 120 ? v.slice(0, 120) + "…" : v;
  return JSON.stringify(v);
}
async function load() {
  const me = await api("/api/v1/me");
  const tenantId = me.account.default_tenant_id || (me.tenants[0] && me.tenants[0].id);
  const data = await api("/api/v1/tenants/" + tenantId + "/sync-conflicts?status=open");
  const list = $("list");
  list.innerHTML = "";
  if (data.conflicts.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "未解決の競合はありません。";
    list.appendChild(p);
    return;
  }
  for (const summary of data.conflicts) {
    const detail = await api("/api/v1/tenants/" + tenantId + "/sync-conflicts/" + summary.id);
    const cf = detail.conflict;
    const box = document.createElement("div");
    box.className = "card";
    box.style.marginBottom = "1rem";
    const h = document.createElement("h2");
    h.textContent = cf.entity_type + " / " + cf.entity_id + "（発生: " + new Date(cf.created_at).toLocaleString() + "）";
    box.appendChild(h);
    const table = document.createElement("table");
    const thead = document.createElement("tr");
    for (const name of ["フィールド", "サーバー側", "あなたの変更"]) {
      const th = document.createElement("th"); th.textContent = name; thead.appendChild(th);
    }
    table.appendChild(thead);
    for (const d of cf.diff || []) {
      const tr = document.createElement("tr");
      const tdF = document.createElement("td"); tdF.textContent = d.field;
      const tdS = document.createElement("td"); tdS.textContent = fmtVal(d.server);
      const tdC = document.createElement("td"); tdC.textContent = fmtVal(d.client);
      if (d.differs) { tdS.style.boxShadow = "inset 0 0 0 2px #b00020"; tdC.style.boxShadow = "inset 0 0 0 2px #2e7d32"; }
      tr.append(tdF, tdS, tdC);
      table.appendChild(tr);
    }
    box.appendChild(table);
    const row = document.createElement("p");
    const bServer = document.createElement("button");
    bServer.className = "secondary";
    bServer.textContent = "サーバー側を採用";
    const bClient = document.createElement("button");
    bClient.textContent = "自分の変更を採用";
    bClient.style.marginLeft = ".5rem";
    const resolve = async (choice) => {
      try {
        await api("/api/v1/tenants/" + tenantId + "/sync-conflicts/" + cf.id + "/resolve", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ choice }),
        });
        box.remove();
        if (!$("list").children.length) load();
      } catch (e) { $("msg").textContent = "解決に失敗しました: " + e.message; }
    };
    bServer.onclick = () => resolve("server");
    bClient.onclick = () => resolve("client");
    row.append(bServer, bClient);
    box.appendChild(row);
    list.appendChild(box);
  }
}
(async () => { try { await load(); } catch (err) { $("msg").textContent = "読み込みに失敗しました: " + err.message; } })();
`;
  return c.html(
    shell("同期の競合", body, script, {
      prefs: await prefsFor(c),
      appChrome: true,
    }),
  );
});

pageRoutes.get("/app/settings/integrations", async (c) => {
  if (!(await loggedIn(c))) return c.redirect("/auth/login", 302);
  const body = `
<h1>外部連携・MCP 設定</h1>
<p class="muted"><a href="/app">← ダッシュボード</a></p>
<p class="muted" id="who"></p>
<div id="notice" class="card" style="display:none"></div>
<h2>連携一覧</h2>
<table><thead><tr><th scope="col">名前</th><th scope="col">種別</th><th scope="col">状態</th><th scope="col">最終同期</th><th scope="col"></th></tr></thead><tbody id="conns"></tbody></table>
<h2>連携を追加</h2>
<form id="createForm">
<p>種別
<select id="fProvider">
<option value="linear">Linear（Issue をタスク化）</option>
<option value="github">GitHub Issues（Issue をタスク化）</option>
<option value="slack">Slack（通知）</option>
<option value="google_calendar">Google カレンダー</option>
<option value="timecrowd">TimeCrowd（取り込み）</option>
</select></p>
<p>名前 <input id="fName" type="text" size="30"></p>
<p>取り込み先プロジェクト <select id="fProject"></select></p>
<p id="rowRepo">GitHub リポジトリ（owner/repo） <input id="fRepo" type="text" size="30"></p>
<p id="rowTeam">Linear チーム ID（任意） <input id="fTeam" type="text" size="30"></p>
<p id="rowChannel">Slack チャンネル名（任意・表示用） <input id="fChannel" type="text" size="30"></p>
<p id="rowCalendar">カレンダー ID（任意） <input id="fCalendar" type="text" size="30"></p>
<p id="rowBase">TimeCrowd API ベース URL（任意） <input id="fBase" type="text" size="40"></p>
<p><span id="tokenLabel">API トークン</span> <input id="fToken" type="password" size="40" autocomplete="off">
<span class="muted">未入力なら「未接続」として登録されます。トークンは暗号化して保存し、再表示はしません。</span></p>
<p><button type="submit">追加する</button></p>
</form>
<h2>同期履歴</h2>
<table><thead><tr><th scope="col">日時</th><th scope="col">種別</th><th scope="col">方法</th><th scope="col">結果</th><th scope="col">内容</th></tr></thead><tbody id="runs"></tbody></table>
<h2>iCal フィード（タスク期限の購読）</h2>
<p class="muted">期限のあるタスクをカレンダーアプリで購読できます。フィード URL は作成時に1回だけ表示します。</p>
<p><button id="icalCreate" class="secondary">フィードを作成</button></p>
<table><thead><tr><th scope="col">ラベル</th><th scope="col">作成日時</th><th scope="col">最終アクセス</th><th scope="col"></th></tr></thead><tbody id="feeds"></tbody></table>
<h2>メールでタスク作成</h2>
<p class="muted">転送サービスから POST するためのトークンをプロジェクトごとに発行します。受付 URL は作成時に1回だけ表示します。</p>
<p>プロジェクト <select id="mProject"></select> <button id="mailCreate" class="secondary">トークンを発行</button></p>
<table><thead><tr><th scope="col">ラベル</th><th scope="col">作成日時</th><th scope="col"></th></tr></thead><tbody id="mailTokens"></tbody></table>
<h2>Google カレンダー</h2>
<p id="gcal" class="muted">確認中…</p>
<h2>データ書き出し（バックアップ）</h2>
<p class="muted">テナントの全データを JSON で書き出します（オーナーのみ）。暗号化フィールドは暗号文のまま、連携トークン類は含まれません。</p>
<p><a id="exportLink" href="#">kosu-export.json をダウンロード</a></p>
<p id="msg" class="err"></p>`;
  const script = `
const $ = (id) => document.getElementById(id);
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || ("HTTP " + r.status)); }
  return r.json();
}
const jsonOpts = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
let tenantId = null;
let projects = [];
function showNotice(title, lines) {
  const box = $("notice");
  box.style.display = "";
  box.innerHTML = "";
  const h = document.createElement("div");
  h.innerHTML = "<strong></strong>";
  h.firstChild.textContent = title;
  box.appendChild(h);
  for (const line of lines) {
    const p = document.createElement("p");
    const code = document.createElement("code");
    code.textContent = line;
    p.appendChild(code);
    box.appendChild(p);
  }
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "この情報は再表示できません。控えてから他の操作をしてください。";
  box.appendChild(note);
}
function statusText(it) {
  if (it.status === "connected") return "接続済み";
  if (it.status === "disabled") return "無効";
  return "未接続" + (it.status_detail ? "（" + it.status_detail + "）" : "");
}
async function loadProjects() {
  projects = [];
  const wss = (await api("/api/v1/tenants/" + tenantId + "/workspaces")).workspaces;
  for (const w of wss) {
    const teams = (await api("/api/v1/tenants/" + tenantId + "/workspaces/" + w.id + "/teams")).teams;
    for (const t of teams) {
      const ps = (await api("/api/v1/tenants/" + tenantId + "/workspaces/" + w.id + "/teams/" + t.id + "/projects")).projects;
      for (const p of ps) projects.push({ id: p.id, name: p.name, path: "/api/v1/tenants/" + tenantId + "/workspaces/" + w.id + "/teams/" + t.id + "/projects/" + p.id });
    }
  }
  for (const sel of [$("fProject"), $("mProject")]) {
    sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = ""; none.textContent = "（なし）";
    sel.appendChild(none);
    for (const p of projects) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    }
  }
}
function projectPath(id) { const p = projects.find((x) => x.id === id); return p ? p.path : null; }
async function loadConns() {
  const data = await api("/api/v1/tenants/" + tenantId + "/integrations");
  const tbody = $("conns");
  tbody.innerHTML = "";
  for (const it of data.integrations) {
    const tr = document.createElement("tr");
    const cells = [it.name, it.provider, statusText(it), it.last_sync ? (it.last_sync.status + " / " + new Date(it.last_sync.at).toLocaleString()) : "—"];
    for (const text of cells) { const td = document.createElement("td"); td.textContent = text; tr.appendChild(td); }
    const ops = document.createElement("td");
    const mk = (label, fn) => { const b = document.createElement("button"); b.className = "secondary"; b.textContent = label; b.onclick = fn; ops.appendChild(b); ops.appendChild(document.createTextNode(" ")); };
    if (it.provider === "linear" || it.provider === "github" || it.provider === "timecrowd") {
      mk("同期", async () => { try { const r = await api("/api/v1/tenants/" + tenantId + "/integrations/" + it.id + "/sync", jsonOpts("POST")); $("msg").textContent = "同期結果: " + r.sync_run.status + (r.sync_run.message ? " — " + r.sync_run.message : ""); await loadAll(); } catch (e) { $("msg").textContent = e.message; } });
    }
    mk(it.enabled ? "無効化" : "有効化", async () => { try { await api("/api/v1/tenants/" + tenantId + "/integrations/" + it.id, jsonOpts("PATCH", { enabled: !it.enabled })); await loadAll(); } catch (e) { $("msg").textContent = e.message; } });
    mk("削除", async () => { try { await api("/api/v1/tenants/" + tenantId + "/integrations/" + it.id, { method: "DELETE" }); await loadAll(); } catch (e) { $("msg").textContent = e.message; } });
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
  if (data.integrations.length === 0) { const tr = document.createElement("tr"); const td = document.createElement("td"); td.colSpan = 5; td.className = "muted"; td.textContent = "連携はまだありません"; tr.appendChild(td); tbody.appendChild(tr); }
}
async function loadRuns() {
  try {
    const data = await api("/api/v1/tenants/" + tenantId + "/sync-runs");
    const tbody = $("runs");
    tbody.innerHTML = "";
    for (const r of data.sync_runs.slice(0, 20)) {
      const tr = document.createElement("tr");
      const stats = r.stats ? Object.keys(r.stats).filter((k) => typeof r.stats[k] === "number").map((k) => k + "=" + r.stats[k]).join(" ") : "";
      const cells = [new Date(r.created_at).toLocaleString(), r.provider, r.kind, r.status, (r.message || "") + (stats ? " (" + stats + ")" : "")];
      for (const text of cells) { const td = document.createElement("td"); td.textContent = text; tr.appendChild(td); }
      tbody.appendChild(tr);
    }
  } catch (e) { /* 管理者以外では履歴は見えません */ }
}
async function loadFeeds() {
  const data = await api("/api/v1/tenants/" + tenantId + "/ical-feeds");
  const tbody = $("feeds");
  tbody.innerHTML = "";
  for (const f of data.ical_feeds) {
    const tr = document.createElement("tr");
    const cells = [f.label || "（ラベルなし）", new Date(f.created_at).toLocaleString(), f.last_accessed_at ? new Date(f.last_accessed_at).toLocaleString() : "—"];
    for (const text of cells) { const td = document.createElement("td"); td.textContent = text; tr.appendChild(td); }
    const ops = document.createElement("td");
    const b = document.createElement("button");
    b.className = "secondary"; b.textContent = "失効";
    b.onclick = async () => { try { await api("/api/v1/tenants/" + tenantId + "/ical-feeds/" + f.id, { method: "DELETE" }); await loadFeeds(); } catch (e) { $("msg").textContent = e.message; } };
    ops.appendChild(b);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}
async function loadMailTokens() {
  const pid = $("mProject").value;
  const tbody = $("mailTokens");
  tbody.innerHTML = "";
  if (!pid) return;
  const path = projectPath(pid);
  const data = await api(path + "/mail-inbound-tokens");
  for (const t of data.mail_inbound_tokens) {
    const tr = document.createElement("tr");
    const cells = [t.label || "（ラベルなし）", new Date(t.created_at).toLocaleString()];
    for (const text of cells) { const td = document.createElement("td"); td.textContent = text; tr.appendChild(td); }
    const ops = document.createElement("td");
    const b = document.createElement("button");
    b.className = "secondary"; b.textContent = "失効";
    b.onclick = async () => { try { await api(path + "/mail-inbound-tokens/" + t.id, { method: "DELETE" }); await loadMailTokens(); } catch (e) { $("msg").textContent = e.message; } };
    ops.appendChild(b);
    tr.appendChild(ops);
    tbody.appendChild(tr);
  }
}
async function loadAll() { await loadConns(); await loadRuns(); await loadFeeds(); await loadMailTokens(); }
function syncProviderFields() {
  const p = $("fProvider").value;
  $("rowRepo").style.display = p === "github" ? "" : "none";
  $("rowTeam").style.display = p === "linear" ? "" : "none";
  $("rowChannel").style.display = p === "slack" ? "" : "none";
  $("rowCalendar").style.display = p === "google_calendar" ? "" : "none";
  $("rowBase").style.display = p === "timecrowd" ? "" : "none";
  $("tokenLabel").textContent = p === "slack" ? "Incoming Webhook URL" : p === "google_calendar" ? "（このフェーズでは未使用）" : "API トークン";
}
$("fProvider").onchange = syncProviderFields;
$("mProject").onchange = () => loadMailTokens().catch((e) => { $("msg").textContent = e.message; });
$("createForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const p = $("fProvider").value;
  const config = {};
  if (p === "github") config.repo = $("fRepo").value.trim();
  if (p === "linear" && $("fTeam").value.trim()) config.team_id = $("fTeam").value.trim();
  if (p === "slack" && $("fChannel").value.trim()) config.channel = $("fChannel").value.trim();
  if (p === "google_calendar" && $("fCalendar").value.trim()) config.calendar_id = $("fCalendar").value.trim();
  if (p === "timecrowd" && $("fBase").value.trim()) config.base_url = $("fBase").value.trim();
  const body = { provider: p, name: $("fName").value.trim() || p, config };
  if ($("fProject").value) body.project_id = $("fProject").value;
  if ($("fToken").value) body.token = $("fToken").value;
  try {
    const r = await api("/api/v1/tenants/" + tenantId + "/integrations", jsonOpts("POST", body));
    $("fToken").value = "";
    if (r.webhook_secret) {
      showNotice("Webhook の受付情報（1回だけ表示）", [location.origin + r.webhook_path, "secret: " + r.webhook_secret]);
    }
    await loadAll();
  } catch (e) { $("msg").textContent = e.message; }
};
$("icalCreate").onclick = async () => {
  try {
    const r = await api("/api/v1/tenants/" + tenantId + "/ical-feeds", jsonOpts("POST", {}));
    showNotice("iCal フィード URL（1回だけ表示）", [location.origin + r.feed_path]);
    await loadFeeds();
  } catch (e) { $("msg").textContent = e.message; }
};
$("mailCreate").onclick = async () => {
  const pid = $("mProject").value;
  if (!pid) { $("msg").textContent = "プロジェクトを選んでください"; return; }
  try {
    const r = await api(projectPath(pid) + "/mail-inbound-tokens", jsonOpts("POST", {}));
    showNotice("メール受付 URL（1回だけ表示）", [location.origin + r.inbound_path]);
    await loadMailTokens();
  } catch (e) { $("msg").textContent = e.message; }
};
(async () => {
  try {
    const me = await api("/api/v1/me");
    tenantId = me.account.default_tenant_id || (me.tenants[0] && me.tenants[0].id);
    $("who").textContent = "テナント: " + tenantId;
    $("exportLink").href = "/api/v1/tenants/" + tenantId + "/export";
    await loadProjects();
    syncProviderFields();
    const g = await api("/api/v1/tenants/" + tenantId + "/google-calendar/status");
    $("gcal").textContent = g.detail;
    await loadAll();
  } catch (err) {
    $("msg").textContent = "読み込みに失敗しました: " + err.message;
  }
})();
`;
  return c.html(
    shell("外部連携・MCP 設定", body, script, {
      prefs: await prefsFor(c),
      appChrome: true,
    }),
  );
});

pageRoutes.get("/app/preferences", async (c) => {
  const prefs = await prefsFor(c);
  if (!prefs) return c.redirect("/auth/login", 302);
  const locale = prefs.locale;
  const weekdayOptions = [1, 2, 3, 4, 5, 6, 7]
    .map(
      (d) =>
        `<option value="${d}"${prefs.week_start === d ? " selected" : ""}>${t(locale, `weekday.${d}` as MessageKey)}</option>`,
    )
    .join("");
  const body = `
<h1>${t(locale, "prefs.title")}</h1>
<p class="muted"><a href="/app">← ${t(locale, "nav.dashboard")}</a></p>
<form id="prefsForm">
<p>${t(locale, "prefs.theme")}
<select id="fTheme">
<option value="system"${prefs.theme === "system" ? " selected" : ""}>${t(locale, "prefs.theme_system")}</option>
<option value="light"${prefs.theme === "light" ? " selected" : ""}>${t(locale, "prefs.theme_light")}</option>
<option value="dark"${prefs.theme === "dark" ? " selected" : ""}>${t(locale, "prefs.theme_dark")}</option>
</select></p>
<p>${t(locale, "prefs.locale")}
<select id="fLocale">
<option value="ja"${locale === "ja" ? " selected" : ""}>日本語</option>
<option value="en"${locale === "en" ? " selected" : ""}>English</option>
</select></p>
<p>${t(locale, "prefs.week_start")}
<select id="fWeekStart">${weekdayOptions}</select></p>
<p><button type="submit">${t(locale, "prefs.save")}</button> <span id="saved" class="muted"></span></p>
</form>
<p id="msg" class="err"></p>`;
  const script = `
const $ = (id) => document.getElementById(id);
$("prefsForm").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const r = await fetch("/api/v1/me/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        theme: $("fTheme").value,
        locale: $("fLocale").value,
        week_start: Number($("fWeekStart").value),
      }),
    });
    if (!r.ok) throw new Error(r.status);
    $("saved").textContent = ${jsonForScript(t(locale, "prefs.saved"))};
    setTimeout(() => location.reload(), 400);
  } catch (e) { $("msg").textContent = e.message; }
};
`;
  return c.html(
    shell(t(locale, "prefs.title"), body, script, { prefs, appChrome: true }),
  );
});

pageRoutes.get("/app/onboarding", async (c) => {
  const prefs = await prefsFor(c);
  if (!prefs) return c.redirect("/auth/login", 302);
  const locale = prefs.locale;
  const body = `
<h1>${t(locale, "onboarding.title")}</h1>
<p class="muted"><a href="/app">← ${t(locale, "nav.dashboard")}</a></p>
<ol>
<li>プロジェクトを作る（または下のサンプルで試す）</li>
<li>タスクを作成し、タイマーで時間を記録する</li>
<li>Cmd+K（Ctrl+K）のコマンドパレットで検索・作成する</li>
<li>連携設定から MCP や外部サービスをつなぐ</li>
</ol>
<h2>サンプルデータ</h2>
<p class="muted">サンプルプロジェクト（タスク3件つき）を自分のテナントに追加できます。不要になったら削除できます。</p>
<p id="sampleState" class="muted">確認中…</p>
<p><button id="addSample">${t(locale, "onboarding.add_sample")}</button>
<button id="removeSample" class="secondary">${t(locale, "onboarding.remove_sample")}</button></p>
<p id="msg" class="err"></p>`;
  const script = `
const $ = (id) => document.getElementById(id);
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || ("HTTP " + r.status)); }
  return r.json();
}
let tenantId = null;
async function refresh() {
  const s = await api("/api/v1/tenants/" + tenantId + "/onboarding/sample");
  $("sampleState").textContent = s.sample_project_id ? "サンプルプロジェクト: 投入済み" : "サンプルプロジェクト: 未投入";
  $("addSample").disabled = !!s.sample_project_id;
  $("removeSample").disabled = !s.sample_project_id;
}
(async () => {
  try {
    const me = await api("/api/v1/me");
    tenantId = me.account.default_tenant_id || (me.tenants[0] && me.tenants[0].id);
    await refresh();
    $("addSample").onclick = async () => { try { await api("/api/v1/tenants/" + tenantId + "/onboarding/sample", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await refresh(); } catch (e) { $("msg").textContent = e.message; } };
    $("removeSample").onclick = async () => { try { await api("/api/v1/tenants/" + tenantId + "/onboarding/sample", { method: "DELETE" }); await refresh(); } catch (e) { $("msg").textContent = e.message; } };
  } catch (e) { $("msg").textContent = e.message; }
})();
`;
  return c.html(
    shell(t(locale, "onboarding.title"), body, script, {
      prefs,
      appChrome: true,
    }),
  );
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

