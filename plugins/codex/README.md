# Kosu plugin for Codex

Codex から Kosu の MCP サーバーへ接続するためのプラグイン（枠組みのみ、実装は後段）。

- MCP エンドポイント: `https://kosu.0g0.xyz/mcp`（Streamable HTTP）
- 認証: Kosu が発行する API キー（Bearer）。キーは環境変数やシークレット管理から渡し、リポジトリ内のファイルには書かない

想定する設定イメージ（MCP サーバー登録）:

```json
{
  "mcpServers": {
    "kosu": {
      "url": "https://kosu.0g0.xyz/mcp",
      "headers": { "Authorization": "Bearer <KOSU_API_KEY>" }
    }
  }
}
```

利用できるツール（予定）: タスク CRUD、工数の開始/停止/記録、ガント用データ取得、リンク追加、Linear / GitHub Issues 同期状態の確認。
