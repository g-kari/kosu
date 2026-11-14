# Kosu 外部連携ガイド

フェーズ4の外部連携の仕様と運用手順です。設定は画面
（`/app/settings/integrations`）または REST API
（`/api/v1/tenants/:tenantId/integrations`、テナント管理者のみ）から
行います。

## 共通の考え方

- 連携は「接続（connection）」単位で管理します。1 テナントに同じ
  プロバイダの接続を複数作れます（プロジェクトごとに分けるなど）。
- プロバイダのトークン類は `FIELD_ENCRYPTION_KEY` で暗号化して
  保存し、API や画面に再表示することはありません（書き込み専用）。
  PATCH で `token` に文字列を渡すと差し替え、`null` を渡すと消去、
  省略すると維持します。
- トークン未設定の接続は **未接続（not_connected）** と表示され、
  同期を実行しても「Not connected」のエラー履歴が残るだけで、
  外部サービスへは一切アクセスしません。
- 同期の履歴は接続ごと・テナント全体で確認できます
  （`/api/v1/tenants/:tenantId/sync-runs`、設定画面の「同期履歴」）。
- 取り込んだ Issue の本文はコピーしません。Kosu のタスク本文は
  クライアント側暗号化のため、平文の外部本文の置き場所がないため
  です。タイトル・状態と、外部オブジェクトへのリンクを持ちます。

## プロバイダ別

### Linear

- 設定: API トークン（`secret` ではなく `token` フィールド）、
  取り込み先プロジェクト、任意で `config.team_id` /
  `config.project_ext_id`（対象の絞り込み）。
- 同期: 手動同期（GraphQL で Issue を取得し、外部 ID で重複防止）と
  Webhook の両対応。状態は Linear の state type から
  open / doing / done へ写します（canceled は取り込みません）。
  タイトルは `ENG-123: タイトル` 形式です。
- Webhook: 接続作成時に受付 URL とシークレットが1回だけ表示され
  ます。Linear 側の Webhook 設定でその URL を登録し、シークレットで
  署名（`Linear-Signature`、HMAC-SHA256 hex）させてください。

### GitHub Issues / コミット・PR

- 設定: API トークン、`config.repo`（`owner/repo`、必須）、
  取り込み先プロジェクト。
- 同期: 手動同期（Issues API、`state=all`、PR は除外）と Webhook。
  外部 ID は `owner/repo#番号` です。
- Webhook: Linear と同じく受付 URL + シークレット方式
  （`X-Hub-Signature-256: sha256=<hex>`）。Issue の
  opened/edited/closed/reopened でタスクを同期します。
- PR マージでタスク自動完了: タスクに `github_pr` リンク（PR の URL）
  を付けておくと、その PR がマージされた Webhook でタスクが
  done カテゴリのステータスへ進みます（監査ログに記録）。
- コミット・PR への単なる紐付けはタスクのリンク機能
  （`github_commit` / `github_pr` / `github_issue`）で行います。
  リンクの外部 ID の既定は URL そのもので、テナント内で一意です。

### Slack

- リンク紐付け: タスクに Slack メッセージの URL を `slack` リンク
  として付けられます（内容の取得は行いません）。
- 通知: 接続に Incoming Webhook URL をトークンとして設定すると、
  Kosu の通知イベント（割当・コメント・締切リマインド等）が
  テナントに1回だけ Slack へ投稿されます。`config.channel` は
  表示用のラベルです（Incoming Webhook の投稿先は URL 側で決まります）。

### Google カレンダー（基盤のみ）

- 現状、サービス側に Google の OAuth 資格情報が未設定のため、
  カレンダーの取り込みは行えません。接続は常に「未接続」と表示され、
  `GET /api/v1/tenants/:tenantId/google-calendar/status` が理由と
  現在の到達範囲（ダッシュボード API と MCP の `kosu_dashboard` で
  日単位の予定対照ができること）を返します。
- OAuth 資格情報を設定した時点で、予定の取り込みと工数との対照表示を
  有効化する設計です（この範囲はフェーズ4では未実装として明記）。

### iCal フィード

- `POST /api/v1/tenants/:tenantId/ical-feeds` でフィードを作成し、
  表示される URL（`/feeds/ical/<token>.ics`、1回だけ表示）を
  カレンダーアプリに登録します。
- 内容は、自分が読めるプロジェクトの、期限があり未アーカイブの
  タスクです（終日イベントとして表現）。トークンはハッシュで保存し、
  失効は DELETE で即時に効きます。

### メールでタスク作成

- プロジェクトごとに受付トークンを発行します
  （`POST .../projects/:projectId/mail-inbound-tokens`、1回だけ表示）。
- 転送サービス（メールの内容を HTTP POST するサービス）から
  `POST /inbound/mail/<token>` に `{ "subject": "...", "from": "...",
  "text": "..." }` を送ると、subject がタイトルのタスクがその
  プロジェクトにできます。プレーンテキスト本文の場合は1行目を
  タイトルにします。
- 実メールボックスへの接続（IMAP 等）はフェーズ4の範囲外です。

### TimeCrowd

- 設定: API トークン、取り込み先プロジェクト、任意で
  `config.base_url`（既定 `https://timecrowd.net/api/v1`）。
- 手動同期でタスクと工数を取り込みます。外部 ID で重複防止し、
  再同期しても二重に記録されません。取り込んだ工数は同期を
  実行したアカウントのものとして記録します。

## 移行インポート（ファイル取り込み）

`POST .../projects/:projectId/imports` に `{ format, content }` を
送ります。対応形式:

| format | 元データ | 列の対応 |
|---|---|---|
| `toggl` | Toggl の詳細レポート CSV | Task / Project / Description、Start date+time、End date+time、Duration |
| `clockify` | Clockify の詳細レポート CSV | Task / Project / Description、Start/End date+time、Duration |
| `kimai` | Kimai のエクスポート CSV | Activity / Project、Date + Begin / End、Duration |
| `csv` | 汎用 CSV | `task`（または title）、`started_at`、`ended_at`、`duration_seconds`（ISO 日時も可） |
| `activitywatch` | ActivityWatch のエクスポート JSON | バケットの events。30 秒未満は除外し、アプリごとに `ActivityWatch: <app>` タスクへ工数の下書きとして記録 |

- 取り込んだ行は内容ハッシュで外部 ID を作り、同じファイルを
  再取り込みしても二重に記録されません（上限 5,000 行/回、4 MB）。
- 元データの説明文はコピーしません（タスク本文・工数メモは
  クライアント側暗号化のため）。
- 結果は同期履歴（kind=import）に残ります。

## テナント単位のデータ書き出し（バックアップ）

- `GET /api/v1/tenants/:tenantId/export`（テナントのオーナーのみ）。
- 形式は `format: "kosu-tenant-export"`、version 1 の JSON です。
- 暗号化フィールド（タスク本文、工数メモ、コメント本文など）は
  **暗号文のまま**含まれます。復号にはクライアント側の鍵が要ります。
- 含まれないもの: アカウント本体（ID 参照のみ）、API キーのハッシュ、
  セッション/OIDC の内部状態、同期の変更ログ・競合・端末、通知の
  配信ログ、そして連携トークンや Webhook シークレット、フィード/
  受付トークン のハッシュなどの秘密情報全般（接続には
  `has_secret` フラグだけが付きます）。

## セキュリティメモ

- 受信 Webhook は接続ごとのシークレットで HMAC-SHA256 署名を
  検証し、定数時間比較します。シークレットの再発行は接続の
  作り直しで行います。
- 連携トークン・Webhook URL・フィード/受付トークンの平文は、
  作成時に1回だけ返します。
