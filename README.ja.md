# Anti-Gravity Integration (AGI)

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語** | [한국어](README.ko.md) | [Español](README.es.md)

**Anti-Gravity Integration (AGI)** は、**Claude Code**、**Codex**、**OpenCode**、**DeepSeek Harness**、**Neuro SDK** などのハーネス向けに、Google の公式 `agy acp` stdio プロトコルを通じて先進的な Gemini モデルを組み込むプラグイン集です。

本リポジトリ内の各フォルダは、それぞれのエージェントハーネスに合わせて設計された独立した `agi` プラグインです。インストール後は、各ハーネス固有の接続コマンドでサインインし、**`/model`** を開いて Antigravity モデルを選択（または会話の途中でネイティブモデルに切り替え）しながら、ターミナルを離れることなく作業を続けられます。すべてのプラグインは自己完結型で、ビルド手順やサードパーティ製 npm ランタイム依存はありません。

| プラグイン | ハーネス | `agy acp` との接続方式 | ネイティブサインイン | `/model` のモデル ID |
| --- | --- | --- | --- | --- |
| [`claude-code/plugins/agi/`](claude-code/plugins/agi) | Claude Code | ローカル Anthropic 互換ブリッジ (`127.0.0.1:43110`) + MCP ツール + `SessionStart` フック | `/agi:connect` (`agy-claude-connect`) | `anthropic-agy/<model>` |
| [`codex/plugins/agi/`](codex/plugins/agi) | Codex | ローカル OpenAI Responses API ブリッジ (`127.0.0.1:43111`) + MCP ツール + モデルカタログ | `$agy-connect` (`agy-codex-connect.mjs`) | `agy/<model>` |
| [`opencode/plugins/agi/`](opencode/plugins/agi) | OpenCode V2 | ネイティブインプロセス `LanguageModelV3` プロバイダー + Integration API（デーモン不要） | ネイティブ `/connect` → **Antigravity (ACP)** (`/agy-connect`) | `agy/<model>` |
| [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) | DeepSeek Harness (`dsh`) | ネイティブインプロセス Cordis `LlmAdapter` バンドル（デーモン不要） | `/agy-connect` (`agy-dsh-connect.mjs`) | `agy/<model>` |

---

## 仕組み

各プラグインは内部で Google 公式の未改変 **`agy acp`**（stdio JSON-RPC 2.0 ベースの Antigravity Agent Client Protocol サーバー）を起動し、アカウントで利用可能なモデルや思考/推論レベル（effort）を取得して、会話ごとの ACP セッションをターン間で維持します。

- **OpenCode V2** は `@opencode/plugin` によりカスタムプロバイダーと `/connect` 統合（`ctx.provider.transform`、`ctx.integration.transform`、`ctx.aisdk.hook`）をネイティブサポートしているため、`agi` は完全にインプロセスで動作します。
- **DeepSeek Harness (`dsh`)** はカスタム Cordis `LlmAdapter` バンドル（`ctx.llm.registerAdapter` + `ctx.commands.register`）をサポートしているため、`@local/dsh-agi` も完全にインプロセスで動作し、リアルタイムストリーミングおよび `/agy-connect`・`/agy-models`・`/agy-status` コマンドを提供します。
- **Claude Code** と **Codex** は HTTP モデルエンドポイント（それぞれ Anthropic Messages API と OpenAI Responses API）を想定しているため、各 `agi` プラグインにはリクエストを `agy acp` へ変換し、ネイティブの `claude-*` や `gpt-*` リクエストを Anthropic / OpenAI へ透過的にプロキシする軽量ローカルホストブリッジが含まれています。

---

## クイックインストール（`curl | bash` または `./install.sh`）

### インタラクティブエージェント選択付きワンラインインストール（手動クローン不要）

インストーラーを実行すると、**`npx skills` スタイルの複数選択ピッカー**（`↑/↓` で移動、`Space` で切り替え、`a` で全選択/解除、`Enter` で確定）が起動し、インストール対象（**Claude Code**、**Codex**、**OpenCode V2**、**DeepSeek Harness**）を選択できます。リポジトリは `~/.agi/repo` にクローンされ、T3 Code 方式の安全な隔離 ACP プロファイルで構成されます。

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

非対話実行や対象指定には `bash -s --` でフラグを渡します：

```bash
# エージェントを直接指定（`npx skills -a ...` と同様）
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- -a opencode,dsh

# 4 つすべてを非対話でインストール
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --all --yes

# Anthropic アカウントなしで Claude Code を構成（ゲートウェイ /v1/models 検出を有効化）
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --claude --local-token

# 変更をプレビュー、またはクリーンにアンインストール
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --uninstall --purge
```

### ローカルクローンからのインストール

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

### Google 公式プロトコルおよび利用規約（ToS）への準拠（T3 Code モデル）

- **公式未改変の `agy acp` サブプロセスのみを使用：** すべての通信は Google 公式 `agy acp` stdio JSON-RPC 2.0 サーバー、公式 `agy acp [--gemini-dir ...] [--app-data-dir ...] --login`、および公式 ACP `authenticate` / `logout` RPC を使用します。`~/.gemini` やキーチェーン、Antigravity IDE からの OAuth トークン抽出、`cloudcode-pa` HTTP エンドポイントの直接プロキシ・偽装、User-Agent ヘッダーの改変は一切行いません。
- **サードパーティ/自動化ハーネスでの推奨認証方式：** Google の利用規約（ToS）に準拠するため、個人向けコンシューマー OAuth よりも **Gemini API キー（`GEMINI_API_KEY` → `gemini-api-key`）** または **Gemini Enterprise（`oauth-business` / `agent-platform`）** の利用を推奨します。
- **隔離された ACP プロファイル（`--gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp`）：** T3 Code の `antigravity-acp` 隔離方式に準拠し、ACP セッションや認証情報が普段使う `agy` CLI や Antigravity デスクトップ IDE と競合しないようにします。設定は `~/.agi/acp.json` に保存され、4 つのプラグインで共有されます。
- **リトライループ保護：** 認証エラー（`-32000`）やポリシー/クォータエラー（`403` / `429` / `PERMISSION_DENIED`）発生時は即座にローカルクールダウンに入り、`session/new` の連続リトライを防ぎます。

主なインストーラーオプション：

```bash
./install.sh                               # インタラクティブ複数選択ピッカー（TTY）
./install.sh -a claude,opencode            # 対象を指定してインストール: claude | codex | opencode | dsh | all
./install.sh --all --yes                   # 4 つすべてを非対話でインストール
./install.sh --dsh --dsh-profile desktop   # 指定した DeepSeek Harness プロファイルに導入
./install.sh --claude --local-token        # Anthropic アカウントなしで Claude Code を導入
./install.sh --codex --codex-mode default  # ~/.codex/config.toml へ直接統合
./install.sh --dry-run                     # ファイルを変更せずに動作をプレビュー
./install.sh --uninstall                   # アンインストール対象を対話選択（または -a / --all）
./install.sh --uninstall --all --purge     # すべて削除し ~/.agi 隔離状態も消去
```

---

## 1. 前提条件

各プラグインを利用する前に以下を確認してください：

1. **Node.js**（18 以上）がインストールされていること。
2. **Antigravity CLI (`agy`)** が `PATH` 上に存在すること（または `AGY_BIN=/path/to/agy` を設定）。
3. `agy` の**認証**設定（各ハーネス固有の connect コマンドまたは CLI）：
   - **推奨（サードパーティ/自動化ハーネスでの Google ToS 準拠）：Gemini API キーまたは Gemini Enterprise：**
     ```bash
     export GEMINI_API_KEY="your-api-key"
     ```
     または OpenCode のネイティブ `/connect` → **Antigravity (ACP)** から **Gemini API Key** を選択するか、`--method gemini-api-key` / `--method oauth-business` / `--method agent-platform` を指定してください。
   - **対話式 Google サインイン（公式 `agy acp --login`）：**
     ```bash
     agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login
     ```
     または各ハーネスのコマンド（OpenCode `/connect`、Claude Code `/agi:connect`、Codex `$agy-connect`、DeepSeek Harness `/agy-connect`）を使用します。

> **補足：** `agy` が未サインインの状態でも、各プラグインはデフォルトの Gemini フォールバック一覧で正常起動し、`/model` がエラーになることはありません。認証して更新（または再起動）すると、ライブの Antigravity カタログに切り替わります。

---

## 2. Claude Code セットアップ

### プラグインの検証と読み込み

```bash
claude plugin validate ./claude-code/plugins/agi
claude --plugin-dir ./claude-code/plugins/agi
```

セッション開始時、`SessionStart` フックがローカルブリッジ（`agy-claude-bridge`）を `http://127.0.0.1:43110` で自動起動します。

### `/model` への Antigravity モデル登録

セットアップヘルパーを実行します（Claude Code 内の `/agi:agy-setup`、`agy_configure_claude` MCP ツール、またはシェルから実行可能）：

```bash
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

`~/.claude/settings.json`（プロジェクトローカルにする場合は `--scope local`）に以下が書き込まれます：
- `ANTHROPIC_BASE_URL=http://127.0.0.1:43110`
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
- `ANTHROPIC_CUSTOM_MODEL_OPTION=anthropic-agy/gemini-2.5-pro`（および `_NAME` / `_DESCRIPTION`）

**認証モードの選択：**
- デフォルト（`--auth-mode auto`）は既存の `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`claude.ai` ログインを**保持**し、ネイティブの Claude モデルもそのまま利用できます。
- Anthropic アカウントをお持ちでなく、`/v1/models` 経由で全 AGY モデルを `/model` に表示したい場合は `--auth-mode local-token` を指定してください（プレースホルダー `ANTHROPIC_AUTH_TOKEN=agy-acp-local` を設定し、ブリッジが `api.anthropic.com` への送信をブロックします）。

### 使い方と管理
1. 設定後、`claude` を再起動して起動時に `/v1/models` を取得させます。
2. Claude Code 内で **`/agi:connect`**（またはシェルで `./claude-code/plugins/agi/bin/agy-claude-connect`）を実行し、ACP 認証状態の確認、公式 `agy acp ... --login` / `GEMINI_API_KEY` によるサインイン、モデル更新、または公式 ACP `logout` を行います。
3. **`/model`** を開き `AGY · ...`（`anthropic-agy/<model-id>`）を選択するか、`/model anthropic-agy/gemini-2.5-pro` で直接切り替えます。
4. `/agi:agy-models` で利用可能なモデルを確認・更新でき、`/agi:hello` でプラグインの動作テストが可能です。
5. 設定を元に戻す場合：
   ```bash
   ./claude-code/plugins/agi/bin/agy-claude-setup --scope user --remove
   ```

---

## 3. Codex セットアップ

### ローカルマーケットプレイスからプラグインをインストール

`codex/` ディレクトリ内で実行します：

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
codex plugin list -m local-repo
```

### `/model` への Antigravity モデル登録

セキュリティ上の理由から Codex はリポジトリ内の `.codex/config.toml` にある `model_providers` と `model_provider` を無視するため、ユーザー単位の `$CODEX_HOME`（`~/.codex`）に配置する必要があります。セットアップスクリプトを実行してください（Codex 内の `agy_configure_codex` MCP ツールからも実行できます）：

```bash
node ./codex/plugins/agi/scripts/setup-codex.mjs --start-bridge
```

デフォルトで以下が作成されます：
- `~/.codex/agy-models.json` — `agy/*` エントリーおよび Codex バンドルモデルを含むモデルカタログ。
- `~/.codex/agy.config.toml` — `[model_providers.agy]`（`wire_api = "responses"`）を `http://127.0.0.1:43111/v1` に向ける `agy` プロファイル。

プロファイル指定で Codex を起動します：

```bash
codex -p agy
```

> `-p agy` なしでデフォルトの `codex` セッションから使いたい場合は、`setup-codex.mjs` に `--mode default` を渡すと `~/.codex/config.toml` にマージされます。どちらのモードも `--remove` で元に戻せます。

Codex 内で：
- **`$agy-connect`**（またはターミナルで `node ./codex/plugins/agi/scripts/agy-codex-connect.mjs`）を実行して ACP 認証の確認、公式 `agy acp ... --login` / `GEMINI_API_KEY` サインイン、ブリッジと `agy-models.json` の更新、ログアウトを行います。
- **`/model`** を実行して `agy/*` Antigravity モデル（および推論レベル）とネイティブ Codex モデルを切り替えます。

---

## 4. OpenCode V2 セットアップ

OpenCode は TypeScript プラグインを直接読み込むため、ブリッジプロセスやポート設定は不要です。

### 方法 A：プロジェクトごとの自動検出
`opencode/plugins/agi` をプロジェクトの `.opencode/plugins/agi/` にコピーします。

### 方法 B：`opencode.jsonc` で参照

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./opencode/plugins/agi",
      "options": {
        "greeting": "Hey",
        "providerId": "agy",
        "providerName": "Antigravity (ACP)",
        "autoApprove": true
      }
    }
  ]
}
```

### 使い方
- OpenCode ネイティブの **`/connect`** コマンドを実行し **Antigravity (ACP)** を選択してサインインします：
  - **Antigravity ACP Sign-In (`agy acp ... --login`)** — ターミナルで Google 公式の対話式ログインを実行
  - **Gemini API Key** — `GEMINI_API_KEY` を OpenCode の認証ストアへ安全に保存（Google ToS 準拠のため推奨）
  - **`GEMINI_API_KEY` 環境変数**
  `credential.updated` イベントにより ACP プロセスが自動的に再起動され、`/model` が更新されます。
- **`/agy-connect`**（`status` | `refresh` | `logout`）で認証状態の確認や公式 ACP ログアウトができます。
- `opencode models` または OpenCode 内の **`/model`** から `agy/<model-id>`（推論レベルバリアント付き）を選択します。
- **`/agy-models`** で `agy acp` からライブ更新、**`/agy-status`** で接続・認証状態を確認できます。
- `hello_greet`、`agy_connect`、`agy_status`、`agy_refresh_models` ツールも利用可能です。

---

## 5. DeepSeek Harness (`dsh`) セットアップ

DeepSeek Harness は Cordis バンドルを直接読み込むため、HTTP ブリッジデーモンやポート設定は不要です。

### DeepSeek Harness プロファイルへのインストール

対話式インストーラー（`./install.sh -a dsh`）またはスタンドアロンセットアップスクリプトを実行します：

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

デフォルトでは `~/.dsh/profiles/` 配下の既存プロファイルすべてに `@local/dsh-agi` をリンクします（存在しない場合は `~/.dsh/profiles/desktop/` を作成、`--profile <name>` で対象指定、`--remove` で削除可能）。

### 使い方
1. DeepSeek Harness（Desktop または CLI）を再起動し、Cordis に `@local/dsh-agi` バンドルを読み込ませます。
2. DeepSeek Harness 内で **`/agy-connect`**（またはターミナルで `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs`）を実行し、ステータス確認、公式 `agy acp ... --login` や `/agy-connect method gemini-api-key` でのサインイン、モデル更新、または `/agy-connect logout` を行います。
3. DeepSeek Harness のモデルピッカーから任意の **`agy/<model-id>`** モデル（Low / Medium / High 推論レベル対応）を選択します。
4. **`/agy-models`** でライブ ACP カタログを更新、**`/agy-status`** でランタイム状態を確認できます。

---

## 環境変数とトラブルシューティング

| 変数 | デフォルト | 用途 |
| --- | --- | --- |
| `AGY_BIN` | `agy` | `agy` CLI 実行ファイルのパス |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity`（`acp.json` 経由） | `agy acp` に渡す隔離 `--gemini-dir` |
| `AGY_APP_DATA_DIR` | `antigravity-acp`（`acp.json` 経由） | `agy acp` に渡す `--app-data-dir` |
| `AGY_AUTH_METHOD` | _(自動)_ | 明示的な ACP 認証方式（`gemini-api-key`、`oauth-business`、`agent-platform`、`oauth-personal`） |
| `AGY_FALLBACK_MODELS` | Gemini 2.5/2.0 一覧 | ライブ ACP 取得前に使用するカンマ区切り（`id` または `id:Name`）または JSON 配列 |
| `AGY_CLAUDE_PORT` | `43110` | Claude Code ローカルブリッジのポート |
| `AGY_CODEX_PORT` | `43111` | Codex ローカルブリッジのポート |
| `AGY_UPSTREAM_ANTHROPIC_URL` | `https://api.anthropic.com` | ネイティブ `claude-*` パススルー先 |
| `AGY_UPSTREAM_OPENAI_URL` | `https://api.openai.com` | ネイティブ `gpt-*` パススルー先 |
| `DSH_HOME` | `~/.dsh` | `profiles/` を含む DeepSeek Harness ホームディレクトリ |

---

## テストスイートの実行

テストスイートはローカルのモック `agy acp` サーバー（`tests/fixtures/mock-agy-acp.mjs`）と一時ディレクトリを使用するため、`~/.claude`、`~/.codex`、`~/.config/opencode`、`~/.dsh`、`~/.agi` を変更しません：

```bash
node --test tests/acp-client.test.mjs tests/claude-bridge.test.mjs tests/codex-bridge.test.mjs tests/dsh-plugin.test.mjs tests/install.test.mjs
bun test tests/opencode-plugin.test.mjs
```

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
