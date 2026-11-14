---
name: kosu
description: Kosu（工数・タスク管理）の MCP ツールでタスクと工数を操作する。作業の開始・終了の記録、タスク作成、進捗確認に使う。
---

# Kosu の使い方（dsh 向け）

Kosu は工数（作業時間）とタスクを一体で管理するサービスです。dsh からは
Kosu の MCP サーバー（`https://kosu.0g0.xyz/mcp`、Streamable HTTP）へ接続し、
環境変数 `KOSU_API_KEY` の API キー（Bearer）で認証します。キーは dsh 側の
シークレット管理に置き、リポジトリ内のファイルには書かないでください。

## 前提

- API キーは Kosu の画面（テナント設定 → API キー）で発行します。書き込みには
  スコープ `write` が必要です。
- API キーは発行したテナントに紐付きます。ツールの `tenant_id` はその
  テナントの ID を渡します（省略可）。
- タスク本文はクライアント側暗号化のため、MCP では `description_enc`
  （暗号文）として扱います。平文を送らないでください。

## 基本フロー

- 作業開始: `kosu_list_projects` → `kosu_list_tasks` でタスクを確認し、
  `kosu_start_timer`（workspace_id, task_id）で開始。タイマーは1アカウント
  1件までです。
- 作業終了: `kosu_stop_timer`。
- 状況確認: `kosu_dashboard`、`kosu_list_integrations`（連携の接続状態と
  最終同期）、`kosu_sync_integration`（Linear / GitHub Issues / TimeCrowd の
  手動同期）。
- PR の紐付け: `kosu_add_task_link`（kind=github_pr）。マージ時に GitHub
  連携 Webhook がタスクを自動完了します。

ツール15件の引数仕様はリポジトリの `docs/MCP.md` を参照してください。
