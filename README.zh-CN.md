# Anti-Gravity Integration (AGI)

[English](README.md) | **简体中文** | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

Anti-Gravity Integration (AGI) 是一个面向 Claude Code、Codex、OpenCode、DeepSeek Harness、Neuro SDK 等工具的插件，将先进的 Gemini 模型带入这些工作流中。

安装完成后，只需使用各工具原生的连接命令登录，就能在 `/model` 中选择 Antigravity 模型，也可以在对话中途随时切回原有模型，并支持一键更新以及将多账号分别保存到独立的数据目录中。

| 工具 | 登录 / 连接命令 | `/model` 中的模型 ID | 插件目录 |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) |

---

## 安装与更新

环境要求：**Node.js 18+**，以及已加入 `PATH` 的官方 **Antigravity CLI (`agy`)**。

### 快速安装

**通过 npx / GitHub 一键安装（无需全局安装）：**

```bash
npx xiaoyuan151/agi install
```

或通过 npm 全局安装 / 直接运行：

```bash
npm install -g @xiaoyuan151/agi
agi install
# 或从 npm 临时运行：
npx @xiaoyuan151/agi install
```

**通过安装脚本：**

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

也可以先克隆到本地再运行：

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

运行安装程序会打开多选交互界面（方向键或 `j`/`k` 移动，`Space` 勾选，`a` 全选，`Enter` 确认），自由选择要配置的工具。

常用参数（使用 `curl` 时加在 `bash -s --` 后面）：

```bash
agi install -a opencode,dsh              # 只安装指定工具 (claude | codex | opencode | dsh | all)
agi install --all --yes                  # 跳过交互，安装全部
agi install --claude --local-token       # 没有 Anthropic 账号时配置 Claude Code
agi install --codex --codex-mode default # 直接写入默认 Codex 配置，不用每次加 -p agy
agi install --dsh --dsh-profile desktop  # 指定 DeepSeek Harness 的 profile
agi install --dry-run                    # 仅预览操作，不改文件
agi uninstall --purge                    # 卸载插件并删除 ~/.agi 状态目录
```

（以上参数同样适用于 `./install.sh`。）

### 更新

一键更新代码或 npm 包、刷新已安装插件与配置，并重启本地桥接进程，同时保留你之前选择的工具、配置项以及所有多账号数据：

```bash
agi update                  # 刷新插件与配置（加 --self 可同时更新全局 npm 包）
agi update --check          # 检查是否有可用更新
./install.sh --update       # 从 git / 远端拉取更新并刷新所有已配置的工具
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --update
```

---

## 登录与多账号隔离

AGI 仅通过官方 `agy acp` 与模型通信，并将每个账号的认证状态保存在独立的数据目录（`--gemini-dir`）下，统一记录在 `~/.agi/acp.json` 中，互不干扰。

支持两种登录方式：

- **Gemini API Key（推荐）：** 设置环境变量 `GEMINI_API_KEY`，或在各工具的连接引导中填入。企业账号（`oauth-business` / `agent-platform`）可通过 `--method` 指定。
- **Google 交互式登录：** 在对应工具里运行连接命令，或直接执行 `agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login`。

未登录时 `/model` 仍会提供一份默认 Gemini 列表；登录并刷新后会自动切换为你账号下可用的完整模型列表。

### 多账号管理（保存到不同数据目录）

你可以添加多个账号，并各自保存到独立目录（默认 `~/.agi/accounts/<name>`，或用 `--data-dir` 指定任意目录）：

```bash
agi account add work --data-dir ~/agy-accounts/work --login
agi account add personal --login
agi account list --probe
agi account use work        # 切换当前活跃账号，并热通知运行中的 Claude/Codex 桥接
agi account remove work --purge
```

以上操作也可通过 `./install.sh account ...`（或 `--add-account`、`--list-accounts`、`--use-account`、`--remove-account`）执行。在各工具对话中也可以直接管理账号：

- **Claude Code / Codex**：调用 `agy_accounts` MCP 工具（`list` | `add` | `switch` | `remove`）
- **OpenCode / DeepSeek Harness**：使用 `/agy-accounts` 命令（`list` | `add <name> --data-dir <dir>` | `use <name>` | `remove <name>`）

---

## 各工具使用方法

### Claude Code

如果通过 `agi install` 或 `./install.sh` 安装，插件与本地桥接已自动配置好。手动配置方式：

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

重启 `claude` 后，运行 `/agi:connect` 登录或查看状态，随后打开 `/model` 选择 `anthropic-agy/...`。你原有的 Anthropic 密钥与 `claude-*` 模型会保留并继续可用。

其他常用操作：`/agi:agy-models` 刷新模型列表，或运行 `agy-claude-setup --scope user --remove` 恢复设置。

> 没有 Anthropic 账号时，可在 `agy-claude-setup` 加上 `--auth-mode local-token`（或在 `agi install` / `install.sh` 加上 `--local-token`）。

### Codex

手动安装与配置：

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
node ./plugins/agi/scripts/setup-codex.mjs --start-bridge
```

使用 `codex -p agy` 启动 Codex，运行 `$agy-connect` 完成登录或刷新模型，然后在 `/model` 里切换 `agy/*` 与 OpenAI 模型。如果不希望每次加 `-p agy`，可在执行 `setup-codex.mjs` 时加上 `--mode default`。

### OpenCode

将 `opencode/plugins/agi` 复制到项目的 `.opencode/plugins/agi/`，或在 `opencode.jsonc` 中引用：

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

在 OpenCode 中运行 `/connect`，选择 **Antigravity (ACP)**，即可通过 `agy acp --login` 或 `GEMINI_API_KEY` 登录。之后模型会自动出现在 `/model` 和 `opencode models` 中，也可随时用 `/agy-connect`（`status` | `refresh` | `logout`）、`/agy-models` 和 `/agy-accounts` 管理。

### DeepSeek Harness

手动链接到你的 DeepSeek Harness profile：

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

重启 DeepSeek Harness 后，在对话中运行 `/agy-connect` 查看状态或登录（如 `/agy-connect method gemini-api-key` 或运行 `agy-dsh-connect`），然后在模型列表选择 `agy/<model>` 即可。同时支持 `/agy-models`、`/agy-status` 与 `/agy-accounts`。

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGI_HOME` | `~/.agi` | AGI 状态目录（`acp.json`、`install.json`、`accounts/`） |
| `AGY_ACCOUNT` | `acp.json` 当前活跃账号 | 覆盖当前使用的账号名称 |
| `AGY_BIN` | `agy` | `agy` 可执行文件路径 |
| `GEMINI_API_KEY` | — | 可选的 Gemini API Key |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | 覆盖 ACP 独立数据目录 |
| `AGY_CLAUDE_PORT` | `43110` | Claude Code 本地桥接端口 |
| `AGY_CODEX_PORT` | `43111` | Codex 本地桥接端口 |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness 数据目录 |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
