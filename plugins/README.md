# plugins/

Kosu の MCP サーバー（`https://kosu.0g0.xyz/mcp`）へ各エージェント環境から接続するためのプラグイン置き場です。

| ディレクトリ | 対象 |
|---|---|
| [codex/](codex/) | Codex |
| [claude-code/](claude-code/) | Claude Code |
| [dsh/](dsh/) | dsh（dots 環境） |

現時点では枠組みのみで、MCP エンドポイント自体の実装は後段で行います。認証は Kosu が発行する API キー（スコープ付き）または OIDC トークンを想定しています。API キーは秘密情報なので、設定ファイルに直書きせず各環境のシークレット管理に置いてください。
