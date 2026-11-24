# Anti-Gravity Integration (AGI)

[English](README.md) | **简体中文** | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

**Anti-Gravity Integration (AGI)** 是一个面向 **Claude Code**、**Codex**、**OpenCode**、**DeepSeek Harness**、**Neuro SDK** 等 AI Agent 工具的插件集合，通过 Google 官方 `agy acp` 标准输入输出协议，将先进的 Gemini 模型无缝引入这些工具中。

本仓库中的每个目录都是针对对应工具定制的独立 `agi` 插件。安装后，你可以使用各工具原生的登录/连接命令完成认证，打开 **`/model`** 选择 Antigravity 模型（或在对话中途随时切回原生模型），无需离开终端即可持续工作。每个插件均为自包含实现——零构建步骤、零第三方 npm 运行时依赖。

| 插件 | 目标工具 | 连接 `agy acp` 方式 | 原生登录命令 | `/model` 中的模型 ID |
| --- | --- | --- | --- | --- |
| [`claude-code/plugins/agi/`](claude-code/plugins/agi) | Claude Code | 本地 Anthropic 兼容桥接服务 (`127.0.0.1:43110`) + MCP 工具 + `SessionStart` 钩子 | `/agi:connect` (`agy-claude-connect`) | `anthropic-agy/<model>` |
| [`codex/plugins/agi/`](codex/plugins/agi) | Codex | 本地 OpenAI Responses API 桥接服务 (`127.0.0.1:43111`) + MCP 工具 + 模型目录 | `$agy-connect` (`agy-codex-connect.mjs`) | `agy/<model>` |
| [`opencode/plugins/agi/`](opencode/plugins/agi) | OpenCode V2 | 原生进程内 `LanguageModelV3` Provider + Integration API（无需后台进程） | 原生 `/connect` → **Antigravity (ACP)** (`/agy-connect`) | `agy/<model>` |
| [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) | DeepSeek Harness (`dsh`) | 原生进程内 Cordis `LlmAdapter` 插件包（无需后台进程） | `/agy-connect` (`agy-dsh-connect.mjs`) | `agy/<model>` |

---

## 工作原理

每个插件在底层都会拉起 Google 官方未修改的 **`agy acp`**（基于 stdio JSON-RPC 2.0 的 Antigravity Agent Client Protocol 服务端），自动发现你账号可用的模型及思考/推理强度（thinking/effort）档位，并在多轮对话中保持独立的 ACP 会话状态。

- **OpenCode V2** 通过 `@opencode/plugin` 原生支持自定义 Provider 与 `/connect` 集成（`ctx.provider.transform`、`ctx.integration.transform`、`ctx.aisdk.hook`），因此 `agi` 完全以进程内方式运行。
- **DeepSeek Harness (`dsh`)** 原生支持 Cordis `LlmAdapter` 插件包（`ctx.llm.registerAdapter` + `ctx.commands.register`），因此 `@local/dsh-agi` 同样完全在进程内运行，支持实时流式输出及原生 `/agy-connect`、`/agy-models`、`/agy-status` 斜杠命令。
- **Claude Code** 与 **Codex** 需要 HTTP 模型接口（分别为 Anthropic Messages API 与 OpenAI Responses API），因此它们的 `agi` 插件内置了轻量级本地桥接服务，将请求转换至 `agy acp`，并将原生 `claude-*` 或 `gpt-*` 请求透明透传给 Anthropic 或 OpenAI。

---

## 快速安装（`curl | bash` 或 `./install.sh`）

### 一键安装与交互式 Agent 选择器（无需手动克隆）

运行安装脚本即可启动类似 **`npx skills` 风格的多选交互界面**（`↑/↓` 移动、`Space` 勾选、`a` 全选/全不选、`Enter` 确认），自由选择要安装到哪些工具（**Claude Code**、**Codex**、**OpenCode V2** 和/或 **DeepSeek Harness**）。脚本会自动克隆至 `~/.agi/repo`，并按 T3 Code 的安全隔离方式配置 Antigravity ACP：

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

通过 `bash -s --` 传入参数以进行非交互式或指定目标安装：

```bash
# 直接指定目标工具（类似 `npx skills -a ...`）
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- -a opencode,dsh

# 非交互式安装全部 4 个工具
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --all --yes

# 无 Anthropic 账号时配置 Claude Code（启用网关 /v1/models 自动发现）
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --claude --local-token

# 预览将执行的操作，或彻底卸载
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --uninstall --purge
```

### 从本地仓库安装

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

### Google 官方协议与服务条款（ToS）合规说明（T3 Code 安全模型）

- **仅使用官方未修改的 `agy acp` 子进程：** 所有通信均通过 Google 官方 `agy acp` stdio JSON-RPC 2.0 协议、官方 `agy acp [--gemini-dir ...] [--app-data-dir ...] --login` 以及官方 ACP `authenticate` / `logout` RPC 完成。AGI 绝不会从 `~/.gemini`、系统钥匙串或 Antigravity IDE 窃取/提取 OAuth Token，绝不代理或伪造 `cloudcode-pa` HTTP 接口，也绝不篡改 User-Agent 请求头。
- **第三方 / 自动化工具推荐认证方式：** 为严格遵守 Google 服务条款，建议优先使用 **Gemini API Key（`GEMINI_API_KEY` → `gemini-api-key`）** 或 **Gemini Enterprise（`oauth-business` / `agent-platform`）**，而非个人消费级 OAuth。
- **隔离的 ACP 配置目录（`--gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp`）：** 与 T3 Code 的 `antigravity-acp` 隔离方案一致，确保 ACP 会话与凭据不会与你的日常 `agy` CLI 或 Antigravity 桌面端产生冲突。配置持久化在 `~/.agi/acp.json` 中并由四个插件共享。
- **防重试风暴保护：** 遇到认证失败（`-32000`）或策略/配额错误（`403` / `429` / `PERMISSION_DENIED`）时立即触发本地冷却，避免高频重复调用 `session/new` 触发风控。

常用安装参数：

```bash
./install.sh                               # 启动交互式多选 Agent 选择器（TTY）
./install.sh -a claude,opencode            # 安装指定工具：claude | codex | opencode | dsh | all
./install.sh --all --yes                   # 非交互式安装全部 4 个插件
./install.sh --dsh --dsh-profile desktop   # 安装 DeepSeek Harness 插件到指定 profile
./install.sh --claude --local-token        # 无 Anthropic 账号时配置 Claude Code
./install.sh --codex --codex-mode default  # 直接将 agy 合并写入 ~/.codex/config.toml
./install.sh --dry-run                     # 仅预览，不修改任何文件
./install.sh --uninstall                   # 交互式选择要卸载的工具（或配合 -a / --all）
./install.sh --uninstall --all --purge     # 卸载全部 4 个插件并删除 ~/.agi 隔离状态
```

---

## 1. 环境要求

在使用任何插件前，请确保本机已安装：

1. **Node.js**（18+）。
2. **Antigravity CLI (`agy`)** 已安装并位于 `PATH` 中（或设置 `AGY_BIN=/path/to/agy`）。
3. 完成 `agy` **身份认证**（可通过各工具原生连接命令或命令行完成）：
   - **推荐（最符合第三方/自动化工具 Google ToS 规范）：Gemini API Key 或 Gemini Enterprise：**
     ```bash
     export GEMINI_API_KEY="your-api-key"
     ```
     或在 OpenCode 原生 `/connect` → **Antigravity (ACP)** 中选择 **Gemini API Key**，或使用 `--method gemini-api-key` / `--method oauth-business` / `--method agent-platform`。
   - **交互式 Google 登录（官方 `agy acp --login`）：**
     ```bash
     agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login
     ```
     或直接在对应工具中运行原生命令：OpenCode `/connect`、Claude Code `/agi:connect`、Codex `$agy-connect`、DeepSeek Harness `/agy-connect`。

> **提示：** 如果 `agy` 尚未登录，各插件仍会使用默认的 Gemini 备选模型列表正常启动，确保 `/model` 不会报错。完成认证并刷新（或重启）后，将自动切换为实时发现的 Antigravity 模型列表。

---

## 2. Claude Code 配置说明

### 加载并校验插件

```bash
claude plugin validate ./claude-code/plugins/agi
claude --plugin-dir ./claude-code/plugins/agi
```

会话启动时，`SessionStart` 钩子会自动确保本地桥接服务（`agy-claude-bridge`）运行在 `http://127.0.0.1:43110`。

### 在 `/model` 中注册 Antigravity 模型

运行安装助手（可在 Claude Code 内运行 `/agi:agy-setup`、通过 MCP 工具 `agy_configure_claude`，或在终端执行）：

```bash
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

脚本会在 `~/.claude/settings.json` 中写入（传入 `--scope local` 可写入当前项目的 `.claude/settings.local.json`）：
- `ANTHROPIC_BASE_URL=http://127.0.0.1:43110`
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
- `ANTHROPIC_CUSTOM_MODEL_OPTION=anthropic-agy/gemini-2.5-pro`（以及对应的 `_NAME` 和 `_DESCRIPTION`）

**选择认证模式：**
- 默认模式（`--auth-mode auto`）会**保留**你现有的 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或 `claude.ai` 订阅登录，使原生 Claude 模型继续正常使用。
- 如果你**没有** Anthropic 账号或密钥，希望 Claude Code 通过网关 `/v1/models` 列出所有 AGY 模型，请传入 `--auth-mode local-token`（会设置占位符 `ANTHROPIC_AUTH_TOKEN=agy-acp-local`，桥接服务会拦截该占位符，绝不会发送给 `api.anthropic.com`）。

### 使用与管理
1. 配置完成后重启 `claude`，使其在启动时拉取 `/v1/models`。
2. 在 Claude Code 内运行 **`/agi:connect`**（或在终端运行 `./claude-code/plugins/agi/bin/agy-claude-connect`）查看 ACP 认证状态、通过官方 `agy acp ... --login` 或 `GEMINI_API_KEY` 登录、刷新模型或通过官方 ACP `logout` 退出登录。
3. 运行 **`/model`** 选择任意 `AGY · ...`（`anthropic-agy/<model-id>`）模型，或直接执行 `/model anthropic-agy/gemini-2.5-pro` 切换。
4. 使用 `/agi:agy-models` 检查或刷新可用模型，使用 `/agi:hello` 测试插件问候技能。
5. 如需随时撤销配置修改：
   ```bash
   ./claude-code/plugins/agi/bin/agy-claude-setup --scope user --remove
   ```

---

## 3. Codex 配置说明

### 从本地市场安装插件

在 `codex/` 目录下运行：

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
codex plugin list -m local-repo
```

### 在 `/model` 中注册 Antigravity 模型

出于安全策略，Codex 会忽略项目本地 `.codex/config.toml` 中的 `model_providers` 与 `model_provider`，因此需要写入用户级 `$CODEX_HOME`（`~/.codex`）。运行配置脚本（或在 Codex 中调用 `agy_configure_codex` MCP 工具）：

```bash
node ./codex/plugins/agi/scripts/setup-codex.mjs --start-bridge
```

默认会生成：
- `~/.codex/agy-models.json` — 包含 `agy/*` 条目以及 Codex 内置模型的模型目录（可在 `/model` 中自由切换）。
- `~/.codex/agy.config.toml` — 干净的 `agy` profile，将 `[model_providers.agy]`（`wire_api = "responses"`）指向 `http://127.0.0.1:43111/v1`。

使用该 profile 启动 Codex：

```bash
codex -p agy
```

> 希望在默认 `codex` 会话中直接使用 `agy` 而无需 `-p agy`？可向 `setup-codex.mjs` 传入 `--mode default`，将配置干净地合并到 `~/.codex/config.toml`。传入 `--remove` 即可完整还原。

在 Codex 中：
- 运行 **`$agy-connect`**（或在终端执行 `node ./codex/plugins/agi/scripts/agy-codex-connect.mjs`）查看 ACP 认证状态、运行官方 `agy acp ... --login` / `GEMINI_API_KEY` 登录、刷新桥接服务与 `agy-models.json` 或退出登录。
- 运行 **`/model`** 在 `agy/*` Antigravity 模型（及推理强度档位）与原生 Codex 模型之间随时切换。

---

## 4. OpenCode V2 配置说明

OpenCode 直接加载 TypeScript 插件，无需额外的本地 HTTP 桥接进程或端口配置。

### 方式 A：项目自动发现
将 `opencode/plugins/agi` 复制到项目目录下的 `.opencode/plugins/agi/`。

### 方式 B：在 `opencode.jsonc` 中引用

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

### 使用方式
- 运行 OpenCode 原生 **`/connect`** 命令并选择 **Antigravity (ACP)**，支持以下认证方式：
  - **Antigravity ACP Sign-In (`agy acp ... --login`)** — 在终端执行 Google 官方交互式登录；
  - **Gemini API Key** — 将 `GEMINI_API_KEY` 安全保存至 OpenCode 凭据库（推荐，符合 Google ToS）；
  - **`GEMINI_API_KEY` 环境变量**。
  OpenCode 的 `credential.updated` 事件会自动重启 ACP 进程并刷新 `/model`。
- 运行 **`/agy-connect`**（`status` | `refresh` | `logout`）快速查看认证状态或执行官方 ACP 退出登录。
- 运行 `opencode models` 或在 OpenCode 内打开 **`/model`** 选择 `agy/<model-id>`（含推理强度变体）。
- 运行 **`/agy-models`** 强制从 `agy acp` 刷新模型列表，或运行 **`/agy-status`** 查看运行与认证状态。
- 同时提供 `hello_greet`、`agy_connect`、`agy_status` 与 `agy_refresh_models` 工具。

---

## 5. DeepSeek Harness (`dsh`) 配置说明

DeepSeek Harness 直接加载 Cordis 插件包，无需启动 HTTP 桥接守护进程或配置端口。

### 安装到 DeepSeek Harness Profile

运行交互式安装脚本（`./install.sh -a dsh`）或直接运行独立配置脚本：

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

默认情况下，这会将 `@local/dsh-agi` 链接到 `~/.dsh/profiles/` 下所有已存在的 profile（若不存在则创建 `~/.dsh/profiles/desktop/`；可传入 `--profile <name>` 指定目标 profile，或传入 `--remove` 干净卸载）。

### 使用方式
1. 重启 DeepSeek Harness（桌面端或 CLI），使 Cordis 加载 `@local/dsh-agi` 插件包。
2. 在 DeepSeek Harness 内运行 **`/agy-connect`**（或在终端运行 `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs`）查看状态、通过官方 `agy acp ... --login` 或 `/agy-connect method gemini-api-key` 登录、刷新模型或执行 `/agy-connect logout`。
3. 在 DeepSeek Harness 的模型选择器中选择任意 **`agy/<model-id>`** 模型（支持 Low / Medium / High 推理强度）。
4. 使用 **`/agy-models`** 刷新实时 ACP 模型列表，或使用 **`/agy-status`** 查看运行时状态。

---

## 环境变量与故障排查

| 变量名 | 默认值 | 用途 |
| --- | --- | --- |
| `AGY_BIN` | `agy` | `agy` CLI 可执行文件路径 |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity`（通过 `acp.json`） | 传给 `agy acp` 的隔离 `--gemini-dir` 目录 |
| `AGY_APP_DATA_DIR` | `antigravity-acp`（通过 `acp.json`） | 传给 `agy acp` 的 `--app-data-dir` 名称 |
| `AGY_AUTH_METHOD` | _(自动)_ | 显式指定 ACP 认证方式（`gemini-api-key`、`oauth-business`、`agent-platform`、`oauth-personal`） |
| `AGY_FALLBACK_MODELS` | Gemini 2.5/2.0 列表 | 实时发现前使用的逗号分隔（`id` 或 `id:Name`）或 JSON 数组模型列表 |
| `AGY_CLAUDE_PORT` | `43110` | Claude Code 本地桥接服务端口 |
| `AGY_CODEX_PORT` | `43111` | Codex 本地桥接服务端口 |
| `AGY_UPSTREAM_ANTHROPIC_URL` | `https://api.anthropic.com` | 原生 `claude-*` 透传上游地址 |
| `AGY_UPSTREAM_OPENAI_URL` | `https://api.openai.com` | 原生 `gpt-*` 透传上游地址 |
| `DSH_HOME` | `~/.dsh` | 包含 `profiles/` 的 DeepSeek Harness 主目录 |

---

## 运行测试套件

测试套件使用本地模拟 `agy acp` 服务端（`tests/fixtures/mock-agy-acp.mjs`）与隔离的临时目录（不会修改 `~/.claude`、`~/.codex`、`~/.config/opencode`、`~/.dsh` 或 `~/.agi`）：

```bash
node --test tests/acp-client.test.mjs tests/claude-bridge.test.mjs tests/codex-bridge.test.mjs tests/dsh-plugin.test.mjs tests/install.test.mjs
bun test tests/opencode-plugin.test.mjs
```

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
