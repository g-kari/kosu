# Kosu の使い方（Codex 向け）

Kosu は工数（作業時間）とタスクを一体で管理するサービスです。Codex からは
Kosu の MCP サーバー（`https://kosu.0g0.xyz/mcp`、Streamable HTTP）へ接続し、
環境変数 `KOSU_API_KEY` の API キー（Bearer）で認証します。

## 前提

- API キーは Kosu の画面（テナント設定 → API キー）で発行します。書き込みには
  スコープ `write` が必要です（読み取りだけなら `read` のみで可）。
- API キーは発行したテナントに紐付きます。ツールの `tenant_id` はその
  テナントの ID を渡します（省略可）。
- タスク本文はクライアント側暗号化のため、MCP では `description_enc`
  （暗号文）として扱います。平文を送らないでください。

## 基本フロー

- 作業開始: `kosu_list_projects` → `kosu_list_tasks` でタスクを確認し、
  `kosu_start_timer`（workspace_id, task_id）でタイマーを開始する。
  タイマーは1アカウント1件までです。
- 作業終了: `kosu_stop_timer` で停止（工数が記録されます）。
- 後付け記録: `kosu_create_time_entry`（task_id, started_at, ended_at
  または duration_seconds）。
- PR の紐付け: `kosu_add_task_link`（kind=github_pr）。対象 PR がマージ
  されると GitHub 連携 Webhook がタスクを自動完了します。
- 状況確認: `kosu_dashboard`（今日／今週の工数、実行中タイマー、進行中）、
  `kosu_get_gantt`（期間と依存関係）。

ツール15件の引数仕様はリポジトリの `docs/MCP.md` を参照してください。
