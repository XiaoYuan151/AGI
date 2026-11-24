# Anti-Gravity Integration (AGI)

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

Anti-Gravity Integration (AGI) is a plugin for Claude Code, Codex, OpenCode, DeepSeek Harness, Neuro SDK, and other harnesses that brings the advanced Gemini models into them.

Install the plugin once, sign in with your harness's native connect command, and pick a Gemini model from `/model`. You can switch between Antigravity models and your normal models mid-session, update everything with one command, and manage multiple accounts in isolated data folders.

| Harness | Connect command | Model IDs in `/model` | Plugin folder |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) |

---

## Install & Update

Requirements: **Node.js 18+** and the official **Antigravity CLI (`agy`)** on your `PATH`.

### Quick install

**Via npx / GitHub (no global install needed):**

```bash
npx xiaoyuan151/agi install
```

Or install globally via npm:

```bash
npm install -g @xiaoyuan151/agi
agi install
# or without installing:
npx @xiaoyuan151/agi install
```

**Via shell script:**

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

Or clone the repo and run it locally:

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

The installer opens an interactive multi-select picker (arrow keys / `j`/`k` to move, `Space` to toggle, `a` to select all, `Enter` to confirm) to choose which harnesses to set up.

Useful flags (append after `bash -s --` when using `curl`):

```bash
agi install -a opencode,dsh              # install only specific harnesses (claude | codex | opencode | dsh | all)
agi install --all --yes                  # install all without prompting
agi install --claude --local-token       # Claude Code without an Anthropic account
agi install --codex --codex-mode default # add agy to default Codex config instead of `-p agy`
agi install --dsh --dsh-profile desktop  # target a specific DeepSeek Harness profile
agi install --dry-run                    # preview what would change
agi uninstall --purge                    # remove plugins and delete ~/.agi state
```

(Every flag above also works with `./install.sh`.)

### Update

Update your checkout or npm package, refresh installed plugins/configs, and restart background bridges while preserving your chosen harnesses, options, and multi-account profiles:

```bash
agi update                  # refresh plugins & configs (add --self to also update the global npm package)
agi update --check          # check if an update is available
./install.sh --update       # update from git/remote and refresh all configured harnesses
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --update
```

---

## Authentication & Multi-Account

AGI connects through the official `agy acp` CLI only and keeps each account's auth state in an isolated data folder (`--gemini-dir`), tracked in `~/.agi/acp.json`.

You can sign in with either:

- **Gemini API key (recommended):** set `GEMINI_API_KEY` or paste it when prompted by your harness's connect flow. Enterprise accounts (`oauth-business` / `agent-platform`) are also supported via `--method`.
- **Google interactive login:** run each harness's connect command (or `agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login` directly).

If you haven't signed in yet, `/model` still shows a default Gemini fallback list. Once you sign in and refresh, your full model list appears automatically.

### Managing multiple accounts (separate data folders)

Add separate accounts into their own data folders (defaults to `~/.agi/accounts/<name>`, or specify any folder with `--data-dir`):

```bash
agi account add work --data-dir ~/agy-accounts/work --login
agi account add personal --login
agi account list --probe
agi account use work        # switches active profile and updates running Claude/Codex bridges
agi account remove work --purge
```

The same commands work via `./install.sh account ...` (or `--add-account`, `--list-accounts`, `--use-account`, `--remove-account`). Inside harnesses, you can also switch accounts directly using:

- **Claude Code / Codex**: `agy_accounts` MCP tool (`list` | `add` | `switch` | `remove`)
- **OpenCode / DeepSeek Harness**: `/agy-accounts` slash command (`list` | `add <name> --data-dir <dir>` | `use <name>` | `remove <name>`)

---

## Usage by Harness

### Claude Code

If you installed via `agi install` or `./install.sh`, the plugin and local bridge are already configured. To set up manually from a local clone:

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

Restart `claude`, run `/agi:connect` to sign in or check auth status, and open `/model` to pick an `anthropic-agy/...` model. Existing Anthropic keys and `claude-*` models continue to work alongside it.

Other commands: `/agi:agy-models` to refresh the model list, or `agy-claude-setup --scope user --remove` to revert settings.

> No Anthropic account? Pass `--auth-mode local-token` to `agy-claude-setup` (or `--local-token` to `agi install` / `install.sh`).

### Codex

To install manually from a local clone:

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
node ./plugins/agi/scripts/setup-codex.mjs --start-bridge
```

Start Codex with the `agy` profile (`codex -p agy`), run `$agy-connect` to sign in or refresh models, and use `/model` to switch between `agy/*` and OpenAI models. Pass `--mode default` to `setup-codex.mjs` if you don't want to type `-p agy` each time.

### OpenCode

Copy `opencode/plugins/agi` into `.opencode/plugins/agi/` in your project, or add it in `opencode.jsonc`:

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

Inside OpenCode, run `/connect`, choose **Antigravity (ACP)**, and sign in with `agy acp --login` or a `GEMINI_API_KEY`. Models appear automatically in `/model` and `opencode models`. You can also use `/agy-connect` (`status` | `refresh` | `logout`), `/agy-models`, and `/agy-accounts`.

### DeepSeek Harness

To link manually from a local clone:

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

Restart DeepSeek Harness, run `/agy-connect` to check status or sign in (e.g. `/agy-connect method gemini-api-key` or `agy-dsh-connect`), and choose any `agy/<model>` in the model selector. `/agy-models`, `/agy-status`, and `/agy-accounts` are also available.

---

## Environment Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `AGI_HOME` | `~/.agi` | Shared AGI state (`acp.json`, `install.json`, `accounts/`) |
| `AGY_ACCOUNT` | active in `acp.json` | Active account profile name override |
| `AGY_BIN` | `agy` | Path to the `agy` binary |
| `GEMINI_API_KEY` | — | Optional Gemini API key |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | Override isolated Gemini data folder for ACP |
| `AGY_CLAUDE_PORT` | `43110` | Local bridge port for Claude Code |
| `AGY_CODEX_PORT` | `43111` | Local bridge port for Codex |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness data directory |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
