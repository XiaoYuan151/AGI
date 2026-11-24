# Anti-Gravity Integration (AGI)

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語** | [한국어](README.ko.md) | [Español](README.es.md)

Anti-Gravity Integration (AGI) は、Claude Code、Codex、OpenCode、DeepSeek Harness、Neuro SDK などのハーネスに先進的な Gemini モデルを組み込むプラグインです。

一度インストールして各ツール標準の接続コマンドでサインインすれば、`/model` からすぐに Antigravity モデルを選択でき、会話の途中で元のモデルへ戻すこともできます。

| ハーネス | 接続コマンド | `/model` のモデル ID | プラグインディレクトリ |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) |

---

## インストール

必要なもの：**Node.js 18+** と `PATH` の通った公式 **Antigravity CLI (`agy`)**。

### クイックインストール

インストーラーを実行すると複数選択 UI（矢印キー / `j`・`k` で移動、`Space` で選択、`a` で全選択、`Enter` で確定）が開き、導入したいハーネスを選べます。

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

リポジトリをクローンして実行する場合：

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

よく使うオプション（`curl` 経由の場合は `bash -s --` の後に指定）：

```bash
./install.sh -a opencode,dsh              # 指定したハーネスのみ導入 (claude | codex | opencode | dsh | all)
./install.sh --all --yes                  # 確認なしで全ハーネスを導入
./install.sh --claude --local-token       # Anthropic アカウントなしで Claude Code を使う
./install.sh --codex --codex-mode default # `-p agy` なしで使えるよう標準設定へ追加
./install.sh --dsh --dsh-profile desktop  # DeepSeek Harness の特定プロファイルを指定
./install.sh --dry-run                    # 変更内容のみプレビュー
./install.sh --uninstall                  # 削除対象を選択（`--purge` で ~/.agi も削除）
```

---

## 認証について

AGI は公式の `agy acp` 経由でのみ動作し、認証状態は `~/.agi/` 配下に分離して保存されます。

次のいずれかでサインインできます：

- **Gemini API キー（推奨）：** `GEMINI_API_KEY` を設定するか、各ツールの接続画面から入力します。エンタープライズ向けアカウント（`oauth-business` / `agent-platform`）も `--method` で指定できます。
- **Google 対話式ログイン：** 各ツールの接続コマンドを実行するか、`agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login` を実行します。

未ログインのままでも `/model` にはデフォルトの Gemini モデル一覧が表示され、サインイン後に更新するとアカウントで利用可能な全モデルが読み込まれます。

---

## 各ハーネスでの使い方

### Claude Code

`./install.sh` を使った場合はすでに設定済みです。手動で設定する場合は以下を実行します：

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

`claude` を再起動して `/agi:connect` でサインインまたは状態確認を行い、`/model` から `anthropic-agy/...` を選択します。既存の Anthropic キーや `claude-*` モデルもそのまま併用できます。

モデル一覧の更新には `/agi:agy-models`、設定を戻すには `./claude-code/plugins/agi/bin/agy-claude-setup --scope user --remove` を使用してください。

> Anthropic アカウントがない場合は、`agy-claude-setup` に `--auth-mode local-token`（`install.sh` なら `--local-token`）を渡します。

### Codex

手動でセットアップする場合：

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
node ./plugins/agi/scripts/setup-codex.mjs --start-bridge
```

`codex -p agy` で起動し、`$agy-connect` でサインインやモデル更新を行ってから、`/model` で `agy/*` と OpenAI モデルを切り替えます。毎回 `-p agy` を付けたくない場合は `setup-codex.mjs` に `--mode default` を指定してください。

### OpenCode

`opencode/plugins/agi` をプロジェクトの `.opencode/plugins/agi/` にコピーするか、`opencode.jsonc` に追加します：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode/plugins/agi",
      "options": {
        "providerId": "agy",
        "providerName": "Antigravity (ACP)"
      }
    }
  ]
}
```

OpenCode 内で `/connect` を開き **Antigravity (ACP)** を選ぶと、`agy acp --login` または `GEMINI_API_KEY` でサインインできます。モデルは `/model` と `opencode models` に自動で反映されます。`/agy-connect`（`status` | `refresh` | `logout`）や `/agy-models` も利用できます。

### DeepSeek Harness

手動でリンクする場合：

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

DeepSeek Harness を再起動し、`/agy-connect` で状態確認やサインイン（例：`/agy-connect method gemini-api-key`、または `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs`）を行ってから、モデル選択で `agy/<model>` を選びます。`/agy-models` と `/agy-status` も使えます。

---

## 環境変数

| 変数名 | デフォルト | 説明 |
| --- | --- | --- |
| `AGY_BIN` | `agy` | `agy` コマンドのパス |
| `GEMINI_API_KEY` | — | 任意の Gemini API キー |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | ACP 用の分離設定ディレクトリ |
| `AGY_CLAUDE_PORT` | `43110` | Claude Code 用ローカルブリッジポート |
| `AGY_CODEX_PORT` | `43111` | Codex 用ローカルブリッジポート |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness のデータディレクトリ |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
