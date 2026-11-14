# Kosu フェーズ5 API（拡張と運用、v0.6.0）

フェーズ5で追加した REST API と公開ページの概要です。認証は従来どおり
セッション Cookie または API キー（Bearer）で、権限は階層ロールに従います。

## 自動化ルール

- `GET/POST /api/v1/tenants/:tenantId/automation-rules`
- `GET/PATCH/DELETE /api/v1/tenants/:tenantId/automation-rules/:ruleId`
- `GET /api/v1/tenants/:tenantId/automation-runs`（実行ログ、`limit` 任意）

ルール本体:

```json
{
  "name": "マージで担当へ通知",
  "project_id": null,
  "trigger": "pr_merged",
  "condition": { "to_status": "done" },
  "actions": [{ "type": "notify", "recipient": "assignee" }],
  "enabled": true
}
```

- trigger: `task_created` / `task_status_changed` / `task_assigned` / `pr_merged`
- condition: `from_status` / `to_status` / `assignee_account_id`（任意、AND）
- actions: `{"type":"set_status","status":...}` /
  `{"type":"set_assignee","account_id":...}` /
  `{"type":"notify","recipient":"assignee|watchers|tenant_admins"}`
- ルールの動作は別のルールを起動しません。実行結果はすべて
  automation_runs に残ります（ok / skipped / error）。

## プロジェクトテンプレート

- `GET/POST /api/v1/tenants/:tenantId/project-templates`
  （POST は `{project_id, name?}` で既存プロジェクトを取り込む）
- `DELETE /api/v1/tenants/:tenantId/project-templates/:templateId`
- `POST /api/v1/tenants/:tenantId/project-templates/:templateId/instantiate`
  （`{team_id, name?, start_date?}`。タスク・依存・マイルストーンを
  日付をずらして複製）

## 繰り返し（完了ベース）

`PUT .../tasks/:taskId/recurrence` の body に `basis` を追加しました。
`schedule`（従来：前回の日付基準）/ `completion`（完了日基準）。

## レポート定義と定期配信

- `GET/POST /api/v1/tenants/:tenantId/report-definitions`
- `PATCH/DELETE /api/v1/tenants/:tenantId/report-definitions/:defId`
- `POST /api/v1/tenants/:tenantId/report-definitions/:defId/run`（即時実行）
- `GET /api/v1/tenants/:tenantId/report-definitions/:defId/runs`

```json
{
  "name": "週次レポート",
  "definition": {
    "group_by": "project",
    "range": { "kind": "last_days", "days": 7 },
    "project_id": null
  },
  "schedule": "weekly"
}
```

range.kind は `last_days`（days）/ `this_month` / `last_month` /
`custom`（from/to）。schedule は `off` / `daily` / `weekly` / `monthly`。
Cron が期限の来た定義を実行し、作成者へアプリ内通知と Webhook で
知らせます（メール配信はありません）。

## 見積もり単位

タスクの入出力に `estimate_points`（数値）と `estimate_size`
（`XS|S|M|L|XL`）を追加しました。`estimate_minutes` と併記できます。

## 締切エスカレーション

- `GET/PUT /api/v1/tenants/:tenantId/escalation`（PUT はテナント管理者）

```json
{ "enabled": true, "before_days": 3, "overdue_admin_days": 1, "repeat_days": 2 }
```

## 利用量と上限

- `GET /api/v1/tenants/:tenantId/usage`（メンバー数・タスク数・添付容量と上限）
- `PUT /api/v1/tenants/:tenantId/limits`（テナント管理者。NULL は無制限）

上限到達時は作成系が `422 limit_exceeded` を返します。

## 表示設定・ログイン履歴

- `GET/PATCH /api/v1/me/prefs`
  （`theme`: system/light/dark、`locale`: ja/en、`week_start`: 1-7）
- `GET /api/v1/me/login-events`（自分のログイン履歴）

新しい端末・IP からのログインはアプリ内通知（login_alert）でも
知らせます。

## API キーの IP 制限

- 発行時に `ip_allowlist: ["203.0.113.0/24", "2001:db8::1"]` を指定可
- `PATCH /api/v1/tenants/:tenantId/api-keys/:keyId`
  （`{ip_allowlist: [...] | null}` で変更。null は制限なし）

範囲外からの呼び出しは 403 です。

## タスク一覧のページング

`GET .../projects/:projectId/tasks?limit=50&cursor=...`
`limit` を付けるとキーセットページングになり、応答に
`next_cursor` が付きます（末尾では null）。未指定時は全件です。

## 進捗の公開リンクと受付フォーム（プロジェクト管理者）

- `GET/POST .../projects/:projectId/share-links`、
  `DELETE .../projects/:projectId/share-links/:linkId`
  （作成時にトークンと `/share/:token` のパスを1回だけ返す）
- `GET/POST .../projects/:projectId/intake-forms`、
  `PATCH/DELETE .../projects/:projectId/intake-forms/:formId`
  （作成時に `/intake/:token` を1回だけ返す）

公開側:

- `GET /share/:token` — 完了率・ステータス別件数・期間・マイルストーン
  のみの読み取り専用ページ
- `GET/POST /intake/:token` — タイトルだけを受け付けるフォーム
  （ハニーポットつき、1時間10件まで）

## 初期設定（サンプルデータ）

- `GET/POST/DELETE /api/v1/tenants/:tenantId/onboarding/sample`
- 画面は `/app/onboarding`、表示設定は `/app/preferences`

## アカウント削除

- `GET /api/v1/me/deletion-preview` — 所有テナントと引き継ぎ要否
- `DELETE /api/v1/me`（セッション認証のみ）

```json
{
  "confirm": "user@example.com",
  "successors": { "<tenant-id>": "<account-id>" },
  "dissolve_tenant_ids": ["<tenant-id>"]
}
```

`confirm` は自分のメールアドレス（未設定なら `DELETE`）。
所有テナントは後継者指定（引き継ぎ）か解散のどちらかが必須で、
どちらもなければ 400 で拒否します。削除は物理削除です。

## 運営者

- `GET /api/v1/admin/overview` — テナント横断の利用量と連携状態
  （セッション認証＋環境変数 `OPERATOR_ACCOUNT_IDS` に内部 ID が
  含まれるアカウントのみ）

## PWA・規約

- `GET /manifest.webmanifest`、`GET /sw.js`、`GET /icons/icon.svg`
- `GET /terms`、`GET /privacy`（文面はプレースホルダー）
