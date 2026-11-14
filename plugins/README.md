# plugins/

Kosu の MCP サーバー（`https://kosu.0g0.xyz/mcp`）へ各エージェント環境から
接続するためのプラグインです。MCP エンドポイントはフェーズ4で実装済みで、
以下の設定とガイドはそのまま使えます。

| ディレクトリ | 対象 | 入っているもの |
|---|---|---|
| [codex/](codex/) | Codex | `config.toml`（MCP 設定）、`AGENTS.md`（ガイド） |
| [claude-code/](claude-code/) | Claude Code | `.claude-plugin/plugin.json`、`.mcp.json`、`skills/kosu/SKILL.md` |
| [dsh/](dsh/) | dsh（dots 環境） | `mcp.json`（接続設定）、`SKILL.md`（ガイド） |

認証は Kosu が発行する API キー（スコープ付き）です。キーは秘密情報なので、
設定ファイルに直書きせず、環境変数 `KOSU_API_KEY` や各環境のシークレット
管理から渡してください。

ツールの詳細仕様は [docs/MCP.md](../docs/MCP.md) を参照してください。
