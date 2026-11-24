# Anti-Gravity Integration (AGI)

[English](README.md) | **简体中文** | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

Anti-Gravity Integration (AGI) 是一个面向 Claude Code、Codex、OpenCode、DeepSeek Harness、Neuro SDK 等工具的插件，将先进的 Gemini 模型带入这些工作流中。

安装完成后，只需使用各工具原生的连接命令登录，就能在 `/model` 中选择 Antigravity 模型，也可以在对话中途随时切回原有模型。

| 工具 | 登录 / 连接命令 | `/model` 中的模型 ID | 插件目录 |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) |

---

## 安装

环境要求：**Node.js 18+**，以及已加入 `PATH` 的官方 **Antigravity CLI (`agy`)**。

### 快速安装

运行安装脚本会打开一个多选交互界面（方向键或 `j`/`k` 移动，`Space` 勾选，`a` 全选，`Enter` 确认），让你自由选择要配置哪些工具：

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

也可以先克隆到本地再运行：

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

常用参数（使用 `curl` 时加在 `bash -s --` 后面）：

```bash
./install.sh -a opencode,dsh              # 只安装指定工具 (claude | codex | opencode | dsh | all)
./install.sh --all --yes                  # 跳过交互，安装全部
./install.sh --claude --local-token       # 没有 Anthropic 账号时配置 Claude Code
./install.sh --codex --codex-mode default # 直接写入默认 Codex 配置，不用每次加 -p agy
./install.sh --dsh --dsh-profile desktop  # 指定 DeepSeek Harness 的 profile
./install.sh --dry-run                    # 仅预览操作，不改文件
./install.sh --uninstall                  # 交互选择卸载（加 --purge 会同时删除 ~/.agi）
```

---

## 登录与认证

AGI 仅通过官方 `agy acp` 与模型通信，并将认证状态单独保存在 `~/.agi/` 下，不干扰你原本的 `agy` 配置。

支持两种登录方式：

- **Gemini API Key（推荐）：** 设置环境变量 `GEMINI_API_KEY`，或在各工具的连接引导中填入。企业账号（`oauth-business` / `agent-platform`）可通过 `--method` 指定。
- **Google 交互式登录：** 在对应工具里运行连接命令，或直接执行 `agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login`。

未登录时 `/model` 仍会提供一份默认 Gemini 列表；登录并刷新后会自动切换为你账号下可用的完整模型列表。

---

## 各工具使用方法

### Claude Code

如果通过 `./install.sh` 安装，插件与本地桥接已自动配置好。手动配置方式：

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

重启 `claude` 后，运行 `/agi:connect` 登录或查看状态，随后打开 `/model` 选择 `anthropic-agy/...`。你原有的 Anthropic 密钥与 `claude-*` 模型会保留并继续可用。

其他常用操作：`/agi:agy-models` 刷新模型列表，或运行 `./claude-code/plugins/agi/bin/agy-claude-setup --scope user --remove` 恢复设置。

> 没有 Anthropic 账号时，可在 `agy-claude-setup` 加上 `--auth-mode local-token`（或在 `install.sh` 加上 `--local-token`）。

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

在 OpenCode 中运行 `/connect`，选择 **Antigravity (ACP)**，即可通过 `agy acp --login` 或 `GEMINI_API_KEY` 登录。之后模型会自动出现在 `/model` 和 `opencode models` 中，也可随时用 `/agy-connect`（`status` | `refresh` | `logout`）和 `/agy-models` 管理。

### DeepSeek Harness

手动链接到你的 DeepSeek Harness profile：

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

重启 DeepSeek Harness 后，在对话中运行 `/agy-connect` 查看状态或登录（如 `/agy-connect method gemini-api-key`，或运行 `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs`），然后在模型列表选择 `agy/<model>` 即可。同时支持 `/agy-models` 与 `/agy-status`。

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGY_BIN` | `agy` | `agy` 可执行文件路径 |
| `GEMINI_API_KEY` | — | 可选的 Gemini API Key |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | ACP 独立配置目录 |
| `AGY_CLAUDE_PORT` | `43110` | Claude Code 本地桥接端口 |
| `AGY_CODEX_PORT` | `43111` | Codex 本地桥接端口 |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness 数据目录 |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
