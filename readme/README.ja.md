# Anti-Gravity Integration (AGI)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **日本語** | [한국어](README.ko.md) | [Español](README.es.md)

Anti-Gravity Integration (AGI) は、Claude Code、Codex、OpenCode、DeepSeek Harness、Neuro SDK などのハーネスに先進的な Gemini モデルを組み込むプラグインです。

一度インストールして各ツール標準の接続コマンドでサインインすれば、`/model` からすぐに Antigravity モデルを選択でき、会話の途中で元のモデルへ戻すこともできます。また、コマンド一つでのアップデートや、アカウントごとにデータフォルダを分離したマルチアカウント管理にも対応しています。

| ハーネス | 接続コマンド | `/model` のモデル ID | プラグインディレクトリ |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](../claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](../codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](../opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](../deepseek-harness/plugins/agi) |

---

## インストールとアップデート

必要なもの：**Node.js 18+** と `PATH` の通った公式 **Antigravity CLI (`agy`)**。

### クイックインストール

**npx / GitHub から直接実行（グローバルインストール不要）：**

```bash
npx xiaoyuan151/agi install
```

または npm でグローバルインストール：

```bash
npm install -g @xiaoyuan151/agi
agi install
# または npm から直接実行：
npx @xiaoyuan151/agi install
```

**シェルスクリプトで実行する場合：**

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

リポジトリをクローンして実行する場合：

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

インストーラーを実行すると複数選択 UI（矢印キー / `j`・`k` で移動、`Space` で選択、`a` で全選択、`Enter` で確定）が開き、導入したいハーネスを選べます。

よく使うオプション（`curl` 経由の場合は `bash -s --` の後に指定）：

```bash
agi install -a opencode,dsh              # 指定したハーネスのみ導入 (claude | codex | opencode | dsh | all)
agi install --all --yes                  # 確認なしで全ハーネスを導入
agi install --claude --local-token       # Anthropic アカウントなしで Claude Code を使う
agi install --codex --codex-mode default # `-p agy` なしで使えるよう標準設定へ追加
agi install --dsh --dsh-profile desktop  # DeepSeek Harness の特定プロファイルを指定
agi install --dry-run                    # 変更内容のみプレビュー
agi uninstall --purge                    # 削除対象を選択し ~/.agi も削除
```

（上記のフラグはすべて `./install.sh` でも利用できます。）

### アップデート

選択したハーネス・設定オプション・すべてのマルチアカウント情報を保持したまま、本体と各プラグインを更新し、ブリッジを再起動します：

```bash
agi update                  # プラグインと設定を更新（`--self` でグローバル npm パッケージも更新）
agi update --check          # 更新の有無を確認
./install.sh --update       # Git/リモートを更新し、導入済みハーネスを再構成
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --update
```

---

## 認証とマルチアカウント管理

AGI は公式の `agy acp` 経由でのみ動作し、各アカウントの認証状態は独立したデータフォルダ（`--gemini-dir`）に分離され、`~/.agi/acp.json` で管理されます。

次のいずれかでサインインできます：

- **Gemini API キー（推奨）：** `GEMINI_API_KEY` を設定するか、各ツールの接続画面から入力します。エンタープライズ向けアカウント（`oauth-business` / `agent-platform`）も `--method` で指定できます。
- **Google 対話式ログイン：** 各ツールの接続コマンドを実行するか、`agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login` を実行します。

未ログインのままでも `/model` にはデフォルトの Gemini モデル一覧が表示され、サインイン後に更新するとアカウントで利用可能な全モデルが読み込まれます。

### 複数アカウントを別フォルダで管理

アカウントごとに異なるデータフォルダを割り当てて追加・切り替えできます（デフォルトは `~/.agi/accounts/<name>`、`--data-dir` で任意のフォルダを指定可能）：

```bash
agi account add work --data-dir ~/agy-accounts/work --login
agi account add personal --login
agi account list --probe
agi account use work        # アクティブなアカウントを切り替え、稼働中のブリッジも更新
agi account remove work --purge
```

`./install.sh account ...`（または `--add-account`、`--list-accounts`、`--use-account`、`--remove-account`）でも同様に操作できます。ハーネス内からは次を利用できます：

- **Claude Code / Codex**: `agy_accounts` MCP ツール（`list` | `add` | `switch` | `remove`）
- **OpenCode / DeepSeek Harness**: `/agy-accounts` コマンド（`list` | `add <name> --data-dir <dir>` | `use <name>` | `remove <name>`）

---

## 各ハーネスでの使い方

### Claude Code

`agi install` または `./install.sh` を使った場合はすでに設定済みです。手動で設定する場合は以下を実行します：

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

`claude` を再起動して `/agi:connect` でサインインまたは状態確認を行い、`/model` から `anthropic-agy/...` を選択します。既存の Anthropic キーや `claude-*` モデルもそのまま併用できます。

モデル一覧の更新には `/agi:agy-models`、設定を戻すには `agy-claude-setup --scope user --remove` を使用してください。

> Anthropic アカウントがない場合は、`agy-claude-setup` に `--auth-mode local-token`（`agi install` / `install.sh` なら `--local-token`）を渡します。

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

OpenCode 内で `/connect` を開き **Antigravity (ACP)** を選ぶと、`agy acp --login` または `GEMINI_API_KEY` でサインインできます。モデルは `/model` と `opencode models` に自動で反映されます。`/agy-connect`（`status` | `refresh` | `logout`）、`/agy-models`、`/agy-accounts` も利用できます。

### DeepSeek Harness

手動でリンクする場合：

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

DeepSeek Harness を再起動し、**Plugins → `@local/dsh-agi`** からプラグイン詳細画面を開く（またはスタンドアロン Web コンソール用に `/agy-gui start` / `agi gui` を実行、あるいはチャット内で `/agy-connect` を実行）ことで、サインインとマルチアカウント管理が行えます。その後、モデル選択で任意の `agy/<model>` を選択してください。`/agy-models`、`/agy-status`、`/agy-accounts`、`/agy-gui` も利用できます。

---

## 環境変数

| 変数名 | デフォルト | 説明 |
| --- | --- | --- |
| `AGI_HOME` | `~/.agi` | AGI の共有状態ディレクトリ (`acp.json`, `install.json`, `accounts/`) |
| `AGY_ACCOUNT` | `acp.json` のアクティブアカウント | 使用するアカウント名のオーバーライド |
| `AGY_BIN` | `agy` | `agy` コマンドのパス |
| `GEMINI_API_KEY` | — | 任意の Gemini API キー |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | ACP 用データディレクトリのオーバーライド |
| `AGY_CLAUDE_PORT` | `43110` | Claude Code 用ローカルブリッジポート |
| `AGY_CODEX_PORT` | `43111` | Codex 用ローカルブリッジポート |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness のデータディレクトリ |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
