---
name: kosu
description: Kosu（工数・タスク管理）の MCP ツールでタスクと工数を操作する。作業の開始・終了の記録、タスク作成、進捗確認に使う。
---

# Kosu の使い方（Claude Code 向け）

Kosu は工数（作業時間）とタスクを一体で管理するサービスです。このプラグインは
Kosu の MCP サーバー（`https://kosu.0g0.xyz/mcp`、Streamable HTTP）へ接続し、
環境変数 `KOSU_API_KEY` に入れた API キー（Bearer）で認証します。

## 前提

- API キーは Kosu の画面（テナント設定 → API キー）で発行します。スコープは
  読み取り専用（`read`）と読み書き（`read` + `write`）があります。工数の記録や
  タスク作成には `write` が必要です。
- API キーは発行したテナントに紐付きます。ツールの `tenant_id` は原則その
  テナントの ID を渡します（省略もできます）。
- タスク本文（description）はクライアント側暗号化のため、MCP では暗号文
  （`description_enc`）としてやり取りします。平文を送らないでください。

## よくある手順

### 作業を始めるとき

1. `kosu_list_projects` で対象プロジェクトの ID を確認する。
2. `kosu_list_tasks` で自分のタスクを探す（無ければ `kosu_create_task` で作る）。
3. `kosu_start_timer`（workspace_id と task_id）でタイマーを開始する。
   タイマーは1アカウントにつき1件だけです（実行中があるとエラーになります）。

### 作業を終えるとき

1. `kosu_stop_timer` でタイマーを止める（工数が自動で記録されます）。
2. 必要なら `kosu_update_task` でステータスを done に寄せる。

### 後から工数を記録するとき

- `kosu_create_time_entry` に task_id と started_at（ISO 8601）、
  ended_at または duration_seconds を渡します。

### 外部リンクを付けるとき

- GitHub PR や Slack メッセージは `kosu_add_task_link` でタスクに紐付けます。
  `github_pr` のリンクがあると、その PR がマージされたときに（GitHub 連携の
  Webhook 経由で）タスクが自動で完了します。

## ツール一覧

| ツール | 内容 |
|---|---|
| kosu_list_tenants | 所属テナント一覧 |
| kosu_list_projects | テナント内のプロジェクト一覧 |
| kosu_list_tasks | プロジェクトのタスク一覧 |
| kosu_create_task | タスク作成 |
| kosu_update_task | タスク更新（部分更新） |
| kosu_list_time_entries | 自分の工数一覧 |
| kosu_create_time_entry | 工数の手入力記録 |
| kosu_start_timer / kosu_stop_timer | タイマー開始・停止 |
| kosu_get_gantt | ガント用データ（タスク・依存・マイルストーン） |
| kosu_list_task_links / kosu_add_task_link | 外部リンクの参照・追加 |
| kosu_list_integrations | 連携の状態（接続済み／未接続／無効、最終同期） |
| kosu_sync_integration | 連携の手動同期を実行 |
| kosu_dashboard | 今日／今週の工数、実行中タイマー、進行中タスク |

詳細な引数仕様はリポジトリの `docs/MCP.md` を参照してください。
