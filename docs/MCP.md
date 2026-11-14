# Kosu MCP リファレンス

Kosu の MCP サーバーは、タスク・工数・連携をエージェント（Claude Code /
Codex / dsh 等）から操作するためのエンドポイントです。

- エンドポイント: `POST https://kosu.0g0.xyz/mcp`
- トランスポート: Streamable HTTP（ステートレス）。1 回の POST に
  JSON-RPC 2.0 のリクエスト（単体またはバッチ）を送ります。通知
  （id なし）は 202 で受け付けます。サーバーから始まるストリームは
  無いため GET / DELETE は 405 です。
- プロトコル版: `2025-03-26`（`2024-11-05` / `2025-06-18` の
  initialize にも応答します）

## 認証

- `Authorization: Bearer <Kosu API キー>` を推奨します。API キーは
  Kosu の画面（テナント設定 → API キー）で発行し、発行テナントに
  紐付きます。
- ブラウザのセッション Cookie でも呼べます（同一オリジン検査が
  REST と同様に効きます）。
- スコープ: 読み取り専用キー（`read` のみ）は読み取りツールだけ
  呼べます。書き込みツールは `isError` で拒否されます。MCP の
  トランスポート自体は POST なので、スコープ判定はツール単位で
  行います。
- ツールの引数 `tenant_id` は、API キーの場合はキーのテナントと
  一致しなければならず、省略できます。セッションの場合は必須です。

## 注意（暗号化）

タスク本文・工数メモはクライアント側暗号化が原則です。MCP では
暗号文を `description_enc` / `note_enc` としてやり取りします。
サーバーは平文の本文を受け取りません。

## ツール一覧

### 読み取り

| ツール | 引数 | 内容 |
|---|---|---|
| `kosu_list_tenants` | — | 所属テナント一覧（内部 ID のみ） |
| `kosu_list_projects` | `tenant_id` | テナント内のプロジェクト一覧（階層を平坦化） |
| `kosu_list_tasks` | `tenant_id`, `project_id`, `include_archived?` | タスク一覧 |
| `kosu_list_time_entries` | `tenant_id` | 自分の工数一覧 |
| `kosu_get_gantt` | `tenant_id`, `project_id` | ガント用データ（タスク・依存・マイルストーン） |
| `kosu_list_task_links` | `tenant_id`, `project_id`, `task_id` | タスクの外部リンク一覧 |
| `kosu_list_integrations` | `tenant_id` | 連携一覧（状態・最終同期つき。秘密情報は返しません） |
| `kosu_dashboard` | `tenant_id`, `local_date?`, `tz_offset_minutes?` | 今日/今週の工数、実行中タイマー、進行中タスク |

### 書き込み（`write` スコープが必要）

| ツール | 引数 | 内容 |
|---|---|---|
| `kosu_create_task` | `tenant_id`, `project_id`, `title`, `description_enc?`, `status?`, `priority?`, `assignee_account_id?`, `parent_task_id?`, `start_date?`, `due_date?`, `sort_order?`, `estimate_minutes?` | タスク作成（ステータスはワークフロー定義で検証） |
| `kosu_update_task` | `tenant_id`, `project_id`, `task_id`, ＋作成と同じ任意項目 | タスクの部分更新 |
| `kosu_create_time_entry` | `tenant_id`, `started_at`, `task_id?` または `workspace_id`, `ended_at?`, `duration_seconds?`, `note_enc?` | 工数の手入力記録 |
| `kosu_start_timer` | `tenant_id`, `workspace_id`, `task_id?` | タイマー開始（1アカウント1件まで） |
| `kosu_stop_timer` | `tenant_id` | タイマー停止 |
| `kosu_add_task_link` | `tenant_id`, `project_id`, `task_id`, `kind`, `url`, `external_id?`, `title?` | 外部リンク追加。kind は `slack` / `linear` / `github_commit` / `github_pr` / `github_issue` / `url` |
| `kosu_sync_integration` | `tenant_id`, `connection_id` | 連携の手動同期（テナント管理者のみ） |

## 呼び出し例

```bash
curl -s https://kosu.0g0.xyz/mcp \
  -H "Authorization: Bearer $KOSU_API_KEY" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"kosu_create_task",
        "arguments":{"project_id":"<project-id>","title":"資料を作る"}}}'
```

応答は `result.content[0].text` に JSON 文字列が入る通常の MCP 形式です。
ツール側のエラー（権限不足、バリデーション等）は HTTP 200 のまま
`result.isError: true` で返り、本文にエラーコードとメッセージが入ります。
認証エラーは HTTP 401 です。

## プラグイン

接続設定と利用ガイドはリポジトリの `plugins/` に同梱しています
（Codex / Claude Code / dsh 向け）。導入手順は各 README を参照して
ください。
