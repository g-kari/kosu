# Kosu plugin for Codex

Codex から Kosu の MCP サーバーへ接続するための設定とガイドです。

- MCP エンドポイント: `https://kosu.0g0.xyz/mcp`（Streamable HTTP、ステートレス）
- 認証: Kosu が発行する API キー（Bearer）。キーは環境変数 `KOSU_API_KEY`
  から渡します（`bearer_token_env_var`）。実キーをファイルに書かないでください。

## 入っているもの

- `config.toml` — Codex の MCP サーバー設定スニペット
- `AGENTS.md` — Kosu の操作ガイド

## 導入手順

1. Kosu の画面で対象テナントの API キーを発行する（読み書きする場合は
   スコープ `read` + `write`）。
2. 環境変数を設定する: `export KOSU_API_KEY=<発行されたキー>`
3. `config.toml` の内容を `~/.codex/config.toml` に追記する。
4. Codex から `kosu_list_tenants` を呼んで疎通を確認する。

## 利用できるツール

タスク CRUD、工数の開始/停止/記録、ガント用データ取得、外部リンク追加、
連携の状態確認と手動同期、ダッシュボード取得。詳細は `docs/MCP.md` を
参照してください。
