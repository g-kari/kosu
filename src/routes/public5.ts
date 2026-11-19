/**
 * Phase 5 public routes (no login required):
 *
 *   GET  /manifest.webmanifest   PWA manifest
 *   GET  /sw.js                  service worker (app-shell cache)
 *   GET  /icons/icon.svg         app icon
 *   GET  /assets/:file           shared CSS/JS assets (hashed, immutable)
 *   GET  /terms                  terms of service (placeholder text)
 *   GET  /privacy                privacy policy (placeholder text)
 *   GET  /share/:token           read-only project progress page
 *   GET  /intake/:token          public task intake form
 *   POST /intake/:token          create a task from the form
 *
 * Share/intake tokens resolve through hashes only; an unknown,
 * revoked or expired token is always the same 404.
 */
import { Hono } from "hono";
import { notFound } from "../errors";
import { OFFLINE_JS, OFFLINE_URL, PALETTE_JS, PALETTE_URL, STYLE, STYLE_URL, shell, prefsFor } from "./pages";
import { UI_ASSET_URL, UI_SCRIPT, VAULT_ASSET_URL, VAULT_PANEL_SCRIPT } from "./ui";
import {
  countRecentSubmissions,
  INTAKE_RATE_LIMIT,
  projectProgress,
  recordSubmission,
  resolveIntakeToken,
  resolveShareToken,
} from "../public-links";
import { insertTask } from "../tasks";
import { assertWithinLimits } from "../usage";
import type { Env, Variables } from "../types";

export const public5Routes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

const MANIFEST = {
  name: "Kosu — 工数・タスク管理",
  short_name: "Kosu",
  description: "工数とタスクを管理するローカルファーストなサービス",
  start_url: "/app",
  scope: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#2456c8",
  icons: [
    {
      src: "/icons/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
};

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="18" fill="#2456c8"/><text x="50" y="68" font-size="52" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-weight="700">K</text></svg>`;

const SERVICE_WORKER = `
// Kosu service worker (phase 5 shell, phase 9 offline data).
// Navigations: network-first with the cached shell as fallback.
// Shell assets: cache-first. API GETs: network-first, successful
// responses are stored in a per-browser data cache and served when
// the network is down, so the app stays readable offline. Sensitive
// or file-serving GETs are never cached, and the data cache is
// purged on logout.
const CACHE = "kosu-shell-v3";
const DATA_CACHE = "kosu-data-v2";
let authGeneration = 0;
let authTransitions = 0;
const SHELL_URLS = ["/app", "/manifest.webmanifest", "/icons/icon.svg", "${STYLE_URL}", "${PALETTE_URL}", "${UI_ASSET_URL}", "${VAULT_ASSET_URL}", "${OFFLINE_URL}"];
const DATA_DENY = ["encryption-key", "/export", "/attachments/", "/sync/", "format=csv"];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => (k.startsWith("kosu-shell-") && k !== CACHE) || (k.startsWith("kosu-data-") && k !== DATA_CACHE)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (["/auth/logout", "/auth/login", "/auth/callback"].includes(url.pathname)) {
    authGeneration++;
    authTransitions++;
    event.respondWith((async () => {
      try {
        await caches.delete(DATA_CACHE);
        return await fetch(event.request);
      } finally {
        // Both edges invalidate work. Overlapping transitions keep the fence
        // closed until every auth request has settled, including failures.
        authGeneration++;
        try { await caches.delete(DATA_CACHE); }
        finally { authTransitions--; }
      }
    })());
    return;
  }
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/v1/")) {
    if (event.request.headers.has("authorization") || event.request.cache === "no-store" || url.pathname === "/api/v1/me" || url.pathname.startsWith("/api/v1/me/") || DATA_DENY.some((s) => (url.pathname + url.search).includes(s))) return;
    if (authTransitions) { event.respondWith(Promise.resolve(new Response("Account transition in progress", {status:409}))); return; }
    const generation = authGeneration;
    event.respondWith(
      fetch(event.request).then((r) => {
        if (generation !== authGeneration) return new Response("Account context changed", {status:409});
        if (r.ok && !/no-store|private/i.test(r.headers.get("cache-control") || "")) {
          const copy = r.clone();
          caches.open(DATA_CACHE).then(async (cache) => { if (generation !== authGeneration) return; await cache.put(event.request, copy); });
        }
        return r;
      }).catch(() =>
        generation !== authGeneration ? new Response("Account context changed", {status:409}) : caches.open(DATA_CACHE).then((cache) => cache.match(event.request)).then((hit) =>
          generation !== authGeneration ? new Response("Account context changed", {status:409}) : hit || new Response(JSON.stringify({ error: { message: "offline and no cached data" } }), { status: 503, headers: { "content-type": "application/json" } })
        )
      )
    );
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/app"))
    );
    return;
  }
  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request))
    );
  }
});
`;

public5Routes.get("/manifest.webmanifest", (c) => {
  return c.body(JSON.stringify(MANIFEST), 200, {
    "Content-Type": "application/manifest+json; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  });
});

public5Routes.get("/sw.js", (c) => {
  return c.body(SERVICE_WORKER, 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
  });
});

public5Routes.get("/icons/icon.svg", (c) => {
  return c.body(ICON_SVG, 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=86400",
  });
});

/**
 * Phase 8: shared CSS/JS as external assets. The URLs carry a content
 * hash (see assetUrl in routes/pages.ts), so responses are immutable:
 * browsers and the service worker fetch each version exactly once and
 * every later page view reuses the cache instead of re-downloading
 * and re-parsing the same code inside every HTML page.
 */
const ASSETS: Record<string, { body: string; type: string }> = {
  [STYLE_URL]: { body: STYLE, type: "text/css; charset=utf-8" },
  [PALETTE_URL]: { body: PALETTE_JS, type: "text/javascript; charset=utf-8" },
  [UI_ASSET_URL]: { body: UI_SCRIPT, type: "text/javascript; charset=utf-8" },
  [VAULT_ASSET_URL]: { body: VAULT_PANEL_SCRIPT, type: "text/javascript; charset=utf-8" },
  [OFFLINE_URL]: { body: OFFLINE_JS, type: "text/javascript; charset=utf-8" },
};

public5Routes.get("/assets/:file", (c) => {
  const asset = ASSETS[`/assets/${c.req.param("file")}`];
  if (!asset) throw notFound("Asset not found");
  return c.body(asset.body, 200, {
    "Content-Type": asset.type,
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

const TERMS_BODY = `
<h1>利用規約</h1>
<p class="muted">この文面はプレースホルダーです。正式な規約は公開前に差し替えます。</p>
<h2>第1条（適用）</h2>
<p>この利用規約（以下「本規約」）は、Kosu（以下「本サービス」）の利用条件を定めるものです。利用者は、本規約に同意のうえ本サービスを利用するものとします。</p>
<h2>第2条（アカウント）</h2>
<p>利用者は、連携する認証サービスのアカウントを用いて本サービスにログインします。アカウントの管理責任は利用者にあります。</p>
<h2>第3条（データの取り扱い）</h2>
<p>タスクの本文など一部のデータは、利用者の端末で暗号化されてからサーバーに保存されます。運営者は暗号化された内容を読むことができません。</p>
<h2>第4条（禁止事項）</h2>
<p>法令に違反する行為、本サービスの運営を妨げる行為、その他運営者が不適切と判断する行為を禁止します。</p>
<h2>第5条（免責）</h2>
<p>本サービスは現状有姿で提供されます。運営者は、本サービスの利用により生じた損害について、故意または重過失がある場合を除き責任を負いません。</p>
`;

const PRIVACY_BODY = `
<h1>プライバシーポリシー</h1>
<p class="muted">この文面はプレースホルダーです。正式なポリシーは公開前に差し替えます。</p>
<h2>取得する情報</h2>
<p>本サービスは、ログインに使う認証サービスから提供される識別子・表示名・メールアドレスと、利用者が登録したタスク・工数などのデータを保存します。タスク本文は端末側で暗号化され、サーバーは暗号文のみを保持します。</p>
<h2>利用目的</h2>
<p>取得した情報は、本サービスの提供・維持・改善のためにのみ利用します。</p>
<h2>第三者提供</h2>
<p>法令に基づく場合を除き、本人の同意なく個人情報を第三者に提供しません。連携機能は利用者が明示的に有効化した場合にのみ、指定した外部サービスへデータを送信します。</p>
<h2>削除</h2>
<p>利用者は、アカウント削除機能により、自分のアカウントと関連データを完全に削除できます。テナントのオーナーの場合は、引き継ぎまたは解散の手続きが必要です。</p>
`;

public5Routes.get("/terms", async (c) => {
  const prefs = await prefsFor(c);
  return c.html(shell("利用規約", TERMS_BODY, "", { prefs }));
});

public5Routes.get("/privacy", async (c) => {
  const prefs = await prefsFor(c);
  return c.html(shell("プライバシーポリシー", PRIVACY_BODY, "", { prefs }));
});

/* ------------------------------------------------------------------ */
/* Design system style guide (phase 11). Renders the real components   */
/* with the app's own stylesheet; the spec is docs/DESIGN_SYSTEM.md.   */
/* ------------------------------------------------------------------ */

const swatch = (hex: string) =>
  `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect x="1" y="1" width="32" height="32" fill="${hex}" stroke="#999" stroke-width="1"/></svg>`;

const DESIGN_SYSTEM_BODY = `
<h1>デザインシステム</h1>
<p class="muted">Kosu の画面はこのページの部品とトークンだけで組み立てる。仕様の正は docs/DESIGN_SYSTEM.md、実装の正はこのページ（実物のCSSで描画）。</p>
<h2>原則（6ルール）</h2>
<p>カードにしない（区切りは上端の罫）／パステルカラーを使わない／ポエム調の文言を使わない／絵文字を使わない／アニメーションを付ける／図解を中心にする。</p>
<h2>カラートークン</h2>
<table>
<tr><th>見本</th><th>トークン</th><th>値（ライト）</th><th>役割</th></tr>
<tr><td>${swatch("#2456c8")}</td><td>--brand</td><td>#2456c8</td><td>主要操作・リンク・進行中</td></tr>
<tr><td>${swatch("#1a1a2e")}</td><td>--ink</td><td>#1a1a2e</td><td>本文</td></tr>
<tr><td>${swatch("#666677")}</td><td>--muted</td><td>#666677</td><td>補足テキスト</td></tr>
<tr><td>${swatch("#e3e3ee")}</td><td>--line</td><td>#e3e3ee</td><td>罫線</td></tr>
<tr><td>${swatch("#b00020")}</td><td>--danger</td><td>#b00020</td><td>エラー・期限超過</td></tr>
<tr><td>${swatch("#b3541e")}</td><td>--warn</td><td>#b3541e</td><td>注意・期限間近</td></tr>
<tr><td>${swatch("#3d9970")}</td><td>--ok</td><td>#3d9970</td><td>完了</td></tr>
<tr><td>${swatch("#c96a00")}</td><td>--focus</td><td>#c96a00</td><td>キーボードフォーカスの枠</td></tr>
</table>
<p class="muted">ダークテーマでは --brand #8fb0ff、--ink #e9e9f2、--bg #14141c などに切り替わる（darkTokens）。テキストのコントラストは両テーマとも WCAG AA（4.5:1）以上、図形は 3:1 以上を数値監査で確認済み。</p>
<h2>ガントの色</h2>
<table>
<tr><th>見本</th><th>状態</th><th>値</th></tr>
<tr><td>${swatch("#7a7a8c")}</td><td>未着手</td><td>#7a7a8c</td></tr>
<tr><td>${swatch("#2456c8")}</td><td>進行中</td><td>#2456c8</td></tr>
<tr><td>${swatch("#3d9970")}</td><td>完了</td><td>#3d9970</td></tr>
<tr><td>${swatch("#b97a1e")}</td><td>マイルストーン（菱形）</td><td>#b97a1e</td></tr>
</table>
<h2>文字</h2>
<h1 style="margin:.2rem 0">見出し1（1.4rem）</h1>
<h2 style="margin:.2rem 0">見出し2（1.1rem）</h2>
<p>本文は system-ui、16px 相当。数値は tabular-nums で桁を揃える：<span style="font-variant-numeric:tabular-nums">12:34:56 / 1,234.5 h</span></p>
<p class="muted">補足テキスト（.muted、0.85rem）</p>
<h2>ボタン</h2>
<p>
<button type="button">作成する</button>
<button type="button" class="secondary">絞り込む</button>
<button type="button" disabled>保存（無効）</button>
<span class="chip">チップ</span>
<span class="tag">タグ</span>
</p>
<p class="muted">角丸はボタン・入力が 6px（--radius-control）、チップとタグが 4px（--radius-chip）。モバイルでは高さ44pxを確保する。無効は disabled 属性で表し、色だけに頼らない。</p>
<h2>入力</h2>
<p>
<label>テキスト <input type="text" value="サンプル"></label>
<label>選択 <select><option>選択肢A</option><option>選択肢B</option></select></label>
<label>日付 <input type="date" value="2026-11-15"></label>
</p>
<h2>フィードバック</h2>
<div class="toast static" role="status">トーストの見本：保存しました</div>
<p class="muted">処理中は画面上部に読み込みバー（#busybar）が出る。アニメーションは prefers-reduced-motion で止まる。</p>
<h2>ロゴ</h2>
<p><img src="/icons/icon.svg" width="48" height="48" alt="現在のアイコン"> 現在のアイコン。新しいロゴ候補は選定中。</p>
<p><a href="/">トップへ戻る</a></p>
`;

public5Routes.get("/design-system", async (c) => {
  const prefs = await prefsFor(c);
  c.header("Cache-Control", "no-store");
  return c.html(shell("デザインシステム", DESIGN_SYSTEM_BODY, "", { prefs }));
});

/* ------------------------------------------------------------------ */
/* Public share page                                                    */
/* ------------------------------------------------------------------ */

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

public5Routes.get("/share/:token", async (c) => {
  const token = c.req.param("token") as string;
  const resolved = await resolveShareToken(c.env, token);
  if (!resolved) throw notFound("Share link not found");
  const progress = await projectProgress(c.env, resolved.project);
  const statusRows = progress.by_status
    .map(
      (s) =>
        `<tr><td>${esc(s.status)}</td><td>${s.count}</td></tr>`,
    )
    .join("");
  const milestoneRows = progress.milestones
    .map((m) => `<li>${esc(m.date)} — ${esc(m.name)}</li>`)
    .join("");
  const width = Math.min(100, Math.max(0, progress.completion_rate));
  const body = `
<h1>${esc(progress.project_name)}</h1>
<p class="muted">このページは読み取り専用の進捗共有です。</p>
<h2>進捗</h2>
<p>完了 ${progress.done} / 全 ${progress.total} タスク（${progress.completion_rate}%）</p>
<div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}" aria-label="完了率" style="background:#e3e3ee;border-radius:6px;height:14px;max-width:480px">
<div style="background:#2456c8;height:14px;border-radius:6px;width:${width}%"></div>
</div>
<p class="muted">期間: ${progress.period.from ?? "—"} 〜 ${progress.period.to ?? "—"}</p>
<h2>ステータス別</h2>
<table><thead><tr><th>ステータス</th><th>件数</th></tr></thead><tbody>${statusRows}</tbody></table>
${milestoneRows ? `<h2>マイルストーン</h2><ul>${milestoneRows}</ul>` : ""}
`;
  return c.html(shell(`進捗: ${progress.project_name}`, body, ""));
});

/* ------------------------------------------------------------------ */
/* Public intake form                                                   */
/* ------------------------------------------------------------------ */

public5Routes.get("/intake/:token", async (c) => {
  const token = c.req.param("token") as string;
  const resolved = await resolveIntakeToken(c.env, token);
  if (!resolved) throw notFound("Intake form not found");
  const title = resolved.form.title ?? "タスク受付";
  const body = `
<h1>${esc(title)}</h1>
<p class="muted">プロジェクト「${esc(resolved.project.name)}」へのタスク受付フォームです。タイトルだけを入力してください。</p>
<form method="post" action="/intake/${esc(token)}">
<p><label>タイトル（必須）<br><input type="text" name="title" required maxlength="500" style="width:100%"></label></p>
<p style="display:none"><label>この欄は空のままにしてください<input type="text" name="website" tabindex="-1" autocomplete="off"></label></p>
<p><button type="submit">送信する</button></p>
</form>
`;
  return c.html(shell(title, body, ""));
});

public5Routes.post("/intake/:token", async (c) => {
  const token = c.req.param("token") as string;
  const resolved = await resolveIntakeToken(c.env, token);
  if (!resolved) throw notFound("Intake form not found");
  const formData = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const honeypot = formData["website"];
  if (typeof honeypot === "string" && honeypot !== "") {
    // Bot trap: pretend success, create nothing.
    return c.html(
      shell("送信しました", "<h1>送信しました</h1><p>ありがとうございました。</p>", ""),
    );
  }
  const titleRaw = formData["title"];
  const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
  if (!title || title.length > 500) {
    return c.html(
      shell(
        "入力エラー",
        "<h1>入力エラー</h1><p>タイトルは1〜500文字で入力してください。</p>",
        "",
      ),
      400,
    );
  }
  const recent = await countRecentSubmissions(c.env, resolved.form.id);
  if (recent >= INTAKE_RATE_LIMIT) {
    return c.html(
      shell(
        "しばらくお待ちください",
        "<h1>しばらくお待ちください</h1><p>短時間に多くの送信があったため、受付を一時的に制限しています。</p>",
        "",
      ),
      429,
    );
  }
  await assertWithinLimits(c.env, resolved.form.tenant_id, "task");
  const task = await insertTask(
    c.env,
    resolved.project,
    {
      title,
      descriptionEnc: null,
      status: "todo",
      priority: "medium",
      assigneeAccountId: null,
      parentTaskId: null,
      startDate: null,
      dueDate: null,
      sortOrder: 0,
      estimateMinutes: null,
    },
    { accountId: resolved.form.created_by_account_id },
  );
  await recordSubmission(c.env, resolved.form, task.id);
  return c.html(
    shell(
      "送信しました",
      "<h1>送信しました</h1><p>タスクを受け付けました。ありがとうございました。</p>",
      "",
    ),
  );
});

