# Kosu plugin for dsh

dsh（dots 環境）から Kosu の MCP サーバーへ接続するための設定とガイドです。

- MCP エンドポイント: `https://kosu.0g0.xyz/mcp`（Streamable HTTP、ステートレス）
- 認証: Kosu が発行する API キー（Bearer）。キーは dsh 側のシークレット管理に
  置き、環境変数 `KOSU_API_KEY` 経由で渡します。実キーをファイルに書かないで
  ください。

## 入っているもの

- `mcp.json` — MCP サーバー接続設定（汎用 JSON 形式）
- `SKILL.md` — Kosu の操作ガイド（スキル文書）

## 導入手順

1. Kosu の画面で対象テナントの API キーを発行する（読み書きする場合は
   スコープ `read` + `write`）。
2. dsh のシークレット管理にキーを登録し、`KOSU_API_KEY` として参照できる
   ようにする。
3. `mcp.json` を dsh の MCP 設定に登録する。
4. `kosu_list_tenants` を呼んで疎通を確認する。

## 利用できるツール

タスク CRUD、工数の開始/停止/記録、ガント用データ取得、外部リンク追加、
連携の状態確認と手動同期、ダッシュボード取得。詳細は `docs/MCP.md` を
参照してください。
