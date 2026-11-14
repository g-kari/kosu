# Kosu（工数）

工数（作業時間）記録とタスク管理を一体にしたサービスです。

- 公開先: https://kosu.0g0.xyz
- 設計メモ: [docs/DESIGN.md](docs/DESIGN.md)
- MCP リファレンス: [docs/MCP.md](docs/MCP.md)
- 外部連携ガイド: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)

## 特徴（予定を含む）

- タスク管理＋工数記録（タイマー／手入力）とガントチャート表示
- MCP 対応：エージェント（Claude Code / Codex / dsh 等）からタスク・工数を操作できる
- ログインは OIDC（0g0-id、認可コード＋PKCE）
- 機密フィールドは AES-GCM で暗号化して D1 に保存
- タスクに Slack リンク、Linear、GitHub のコミット・PR を紐付け可能
- Linear / GitHub Issues は自動連携でタスク化

## 構成

- Cloudflare Workers（Hono + TypeScript）
- D1（データベース）／ R2（添付・書き出しファイル）
- プラグイン同梱：[plugins/](plugins/)（Codex / Claude Code / dsh 向け、MCP 接続先は `https://kosu.0g0.xyz/mcp`）

## 開発

```sh
npm install
npm run dev        # wrangler dev
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run build      # デプロイ用バンドルのドライラン生成
npm run deploy     # wrangler deploy
```

## ステータス

本番稼働中（v0.5.0）。フェーズ1（土台と認証）、フェーズ2（タスク・工数・
差分同期・ガント）、フェーズ3（実務機能：ラベル・レポート・承認フロー・
通知など）、フェーズ4（連携と MCP：MCP エンドポイント、プラグイン実体、
Linear / GitHub Issues 自動連携、Slack 通知、iCal フィード、メールで
タスク作成、TimeCrowd・移行インポート、テナント書き出し）まで実装済み。
フェーズ5（拡張と運用）は今後対応します。詳細は docs/DESIGN.md の
フェーズ計画を参照してください。
