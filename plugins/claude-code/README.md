# Kosu plugin for Claude Code

Claude Code から Kosu の MCP サーバーへ接続するためのプラグインです。

- MCP エンドポイント: `https://kosu.0g0.xyz/mcp`（Streamable HTTP、ステートレス）
- 認証: Kosu が発行する API キー（Bearer）。キーは環境変数 `KOSU_API_KEY` から
  渡します。リポジトリ内のファイルに実キーを書かないでください。

## 入っているもの

- `.claude-plugin/plugin.json` — プラグインメタデータ
- `.mcp.json` — MCP サーバー定義（`${KOSU_API_KEY}` を環境変数展開します）
- `skills/kosu/SKILL.md` — Kosu の操作ガイド（スキル文書）

## 導入手順

1. Kosu の画面で対象テナントの API キーを発行する（読み書きする場合は
   スコープ `read` + `write`）。
2. 環境変数を設定する: `export KOSU_API_KEY=<発行されたキー>`
3. このディレクトリをプラグインとして読み込むか、プロジェクトの
   `.mcp.json` に `.mcp.json` の内容をコピーする。
4. Claude Code から `kosu_list_tenants` を呼んで疎通を確認する。

## 利用できるツール

タスク CRUD、工数の開始/停止/記録、ガント用データ取得、外部リンク追加、
連携の状態確認と手動同期、ダッシュボード取得。詳細は `docs/MCP.md` と
スキル文書（`skills/kosu/SKILL.md`）を参照してください。
