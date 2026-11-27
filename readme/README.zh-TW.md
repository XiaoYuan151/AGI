# Anti-Gravity Integration (AGI)

[English](../README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

Anti-Gravity Integration (AGI) 是一款適用於 Claude Code、Codex、OpenCode、DeepSeek Harness、Neuro SDK 等工具的外掛，將先進的 Gemini 模型整合至這些工作流程中。

安裝完成後，只需使用各工具原生的連線指令登入，即可在 `/model` 中選擇 Antigravity 模型，也可於對話中途隨時切換回原本的模型，並支援一鍵更新及將多個帳號隔離儲存至不同的資料目錄。

| 工具 | 登入 / 連線指令 | `/model` 中的模型 ID | 外掛目錄 |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](../claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](../codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](../opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](../deepseek-harness/plugins/agi) |

---

## 安裝與更新

系統需求：**Node.js 18+**，以及已加入 `PATH` 的官方 **Antigravity CLI (`agy`)**。

### 快速安裝

**透過 npx / GitHub 一鍵安裝（無需全域安裝）：**

```bash
npx xiaoyuan151/agi install
```

或透過 npm 全域安裝 / 直接執行：

```bash
npm install -g @xiaoyuan151/agi
agi install
# 或從 npm 直接執行：
npx @xiaoyuan151/agi install
```

**透過安裝腳本：**

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

亦可複製儲存庫至本機後執行：

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

執行安裝程式後會開啟互動式多選介面（使用方向鍵或 `j`/`k` 移動、`Space` 勾選、`a` 全選、`Enter` 確認），選擇要設定的工具。

常用參數（透過 `curl` 執行時請接在 `bash -s --` 之後）：

```bash
agi install -a opencode,dsh              # 僅安裝指定工具 (claude | codex | opencode | dsh | all)
agi install --all --yes                  # 略過互動提示，安裝全部
agi install --claude --local-token       # 無 Anthropic 帳號時設定 Claude Code
agi install --codex --codex-mode default # 直接寫入預設 Codex 設定，免去每次輸入 -p agy
agi install --dsh --dsh-profile desktop  # 指定 DeepSeek Harness 的 profile
agi install --dry-run                    # 僅預覽變更，不修改檔案
agi uninstall --purge                    # 移除外掛並刪除 ~/.agi 狀態目錄
```

（以上旗標同樣適用於 `./install.sh`。）

### 更新

更新程式碼或 npm 套件、重新整理已安裝的外掛與設定，並重啟背景橋接服務，同時保留原本選擇的工具、設定選項與所有多帳號資料：

```bash
agi update                  # 更新外掛與設定（加上 --self 可同時更新全域 npm 套件）
agi update --check          # 檢查是否有可用更新
./install.sh --update       # 從 git / 遠端拉取更新並刷新所有已設定的工具
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --update
```

---

## 認證與多帳號隔離

AGI 僅透過官方 `agy acp` CLI 與模型通訊，並將每個帳號的認證狀態獨立儲存於各自的資料目錄（`--gemini-dir`），集中記錄在 `~/.agi/acp.json` 中，互不干擾。

支援兩種登入方式：

- **Gemini API Key（建議）：** 設定環境變數 `GEMINI_API_KEY`，或在各工具的連線引導流程中輸入。企業帳號（`oauth-business` / `agent-platform`）亦可透過 `--method` 指定。
- **Google 互動式登入：** 執行對應工具的連線指令，或直接執行 `agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login`。

尚未登入時，`/model` 仍會顯示預設的 Gemini 備用清單；登入並重新整理後，即會自動切換為帳號可用的完整模型清單。

### 管理多個帳號（獨立資料目錄）

您可以新增多個帳號並分別儲存至不同目錄（預設為 `~/.agi/accounts/<name>`，或透過 `--data-dir` 指定任意目錄）：

```bash
agi account add work --data-dir ~/agy-accounts/work --login
agi account add personal --login
agi account list --probe
agi account use work        # 切換目前啟用的帳號，並熱通知執行中的 Claude/Codex 橋接
agi account remove work --purge
```

上述指令亦可透過 `./install.sh account ...`（或 `--add-account`、`--list-accounts`、`--use-account`、`--remove-account`）執行。在各工具對話內也能直接管理帳號：

- **Claude Code / Codex**：呼叫 `agy_accounts` MCP 工具（`list` | `add` | `switch` | `remove`）
- **OpenCode / DeepSeek Harness**：使用 `/agy-accounts` 指令（`list` | `add <name> --data-dir <dir>` | `use <name>` | `remove <name>`）

---

## 各工具使用方式

### Claude Code

若透過 `agi install` 或 `./install.sh` 安裝，外掛與本機橋接已自動設定完成。手動設定方式如下：

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

重啟 `claude` 後，執行 `/agi:connect` 登入或查看狀態，接著開啟 `/model` 選擇 `anthropic-agy/...`。原有的 Anthropic 金鑰與 `claude-*` 模型仍可正常共用。

其他常用指令：`/agi:agy-models` 重新整理模型清單，或執行 `agy-claude-setup --scope user --remove` 還原設定。

> 沒有 Anthropic 帳號？請在 `agy-claude-setup` 加上 `--auth-mode local-token`（或在 `agi install` / `install.sh` 加上 `--local-token`）。

### Codex

手動安裝與設定：

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
node ./plugins/agi/scripts/setup-codex.mjs --start-bridge
```

使用 `codex -p agy` 啟動 Codex，執行 `$agy-connect` 完成登入或刷新模型，並在 `/model` 中切換 `agy/*` 與 OpenAI 模型。若不希望每次輸入 `-p agy`，可在執行 `setup-codex.mjs` 時加上 `--mode default`。

### OpenCode

將 `opencode/plugins/agi` 複製至專案的 `.opencode/plugins/agi/`，或在 `opencode.jsonc` 中設定：

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

在 OpenCode 中執行 `/connect`，選擇 **Antigravity (ACP)**，即可透過 `agy acp --login` 或 `GEMINI_API_KEY` 登入。模型會自動顯示於 `/model` 與 `opencode models`，亦可隨時使用 `/agy-connect`（`status` | `refresh` | `logout`）、`/agy-models` 與 `/agy-accounts` 管理。

### DeepSeek Harness

手動連結至您的 DeepSeek Harness profile：

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

重啟 DeepSeek Harness 後，開啟 **外掛 → `@local/dsh-agi`** 進入外掛詳細頁面（或執行 `/agy-gui start` / `agi gui` 啟動獨立網頁控制台，或在對話中執行 `/agy-connect`）以完成登入與多帳號管理，接著在模型選擇器中挑選任一 `agy/<model>`。同時支援 `/agy-models`、`/agy-status`、`/agy-accounts` 與 `/agy-gui`。

---

## 環境變數

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `AGI_HOME` | `~/.agi` | 共用 AGI 狀態目錄（`acp.json`、`install.json`、`accounts/`） |
| `AGY_ACCOUNT` | `acp.json` 目前啟用帳號 | 覆寫目前使用的帳號名稱 |
| `AGY_BIN` | `agy` | `agy` 執行檔路徑 |
| `GEMINI_API_KEY` | — | 選用的 Gemini API Key |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | 覆寫 ACP 獨立資料目錄 |
| `AGY_CLAUDE_PORT` | `43110` | Claude Code 本機橋接埠 |
| `AGY_CODEX_PORT` | `43111` | Codex 本機橋接埠 |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness 資料目錄 |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
