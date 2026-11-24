# Anti-Gravity Integration (AGI)

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md)

Anti-Gravity Integration (AGI) is a plugin for Claude Code, Codex, OpenCode, DeepSeek Harness, Neuro SDK, and other harnesses that brings the advanced Gemini models into them.

Install the plugin once, sign in with your harness's native connect command, and pick a Gemini model from `/model`. You can switch between Antigravity models and your normal models mid-session.

| Harness | Connect command | Model IDs in `/model` | Plugin folder |
| --- | --- | --- | --- |
| Claude Code | `/agi:connect` | `anthropic-agy/<model>` | [`claude-code/plugins/agi/`](claude-code/plugins/agi) |
| Codex | `$agy-connect` | `agy/<model>` | [`codex/plugins/agi/`](codex/plugins/agi) |
| OpenCode | `/connect` → **Antigravity (ACP)** | `agy/<model>` | [`opencode/plugins/agi/`](opencode/plugins/agi) |
| DeepSeek Harness | `/agy-connect` | `agy/<model>` | [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) |

---

## Install

Requirements: **Node.js 18+** and the official **Antigravity CLI (`agy`)** on your `PATH`.

### Quick install

Run the installer to open an interactive multi-select picker (arrow keys / `j`/`k` to move, `Space` to toggle, `a` to select all, `Enter` to confirm) and choose which harnesses to set up:

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

Or clone the repo and run it locally:

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

Useful flags (append after `bash -s --` when using `curl`):

```bash
./install.sh -a opencode,dsh        # install only specific harnesses (claude | codex | opencode | dsh | all)
./install.sh --all --yes            # install all without prompting
./install.sh --claude --local-token # Claude Code without an Anthropic account
./install.sh --codex --codex-mode default # add agy to your default codex config instead of `-p agy`
./install.sh --dsh --dsh-profile desktop  # target a specific DeepSeek Harness profile
./install.sh --dry-run              # preview what would change
./install.sh --uninstall            # pick harnesses to remove (add --purge to also clear ~/.agi)
```

---

## Authentication

AGI connects through the official `agy acp` CLI only and keeps its auth state separate under `~/.agi/`.

You can sign in with either:

- **Gemini API key (recommended):** set `GEMINI_API_KEY` or paste it when prompted by your harness's connect flow. Enterprise accounts (`oauth-business` / `agent-platform`) are also supported via `--method`.
- **Google interactive login:** run each harness's connect command (or `agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login` directly).

If you haven't signed in yet, `/model` still shows a default Gemini fallback list. Once you sign in and refresh, your full model list appears automatically.

---

## Usage by Harness

### Claude Code

If you installed via `./install.sh`, the plugin and local bridge are already configured. To set up manually from a local clone:

```bash
claude --plugin-dir ./claude-code/plugins/agi
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

Restart `claude`, run `/agi:connect` to sign in or check auth status, and open `/model` to pick an `anthropic-agy/...` model. Existing Anthropic keys and `claude-*` models continue to work alongside it.

Other commands: `/agi:agy-models` to refresh the model list, or `./claude-code/plugins/agi/bin/agy-claude-setup --scope user --remove` to revert settings.

> No Anthropic account? Pass `--auth-mode local-token` to `agy-claude-setup` (or `--local-token` to `install.sh`).

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

Inside OpenCode, run `/connect`, choose **Antigravity (ACP)**, and sign in with `agy acp --login` or a `GEMINI_API_KEY`. Models appear automatically in `/model` and `opencode models`. You can also use `/agy-connect` (`status` | `refresh` | `logout`) and `/agy-models`.

### DeepSeek Harness

To link manually from a local clone:

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

Restart DeepSeek Harness, run `/agy-connect` to check status or sign in (e.g. `/agy-connect method gemini-api-key` or `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs`), and choose any `agy/<model>` in the model selector. `/agy-models` and `/agy-status` are also available.

---

## Environment Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Path to the `agy` binary |
| `GEMINI_API_KEY` | — | Optional Gemini API key |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` | Separate Gemini config folder for ACP |
| `AGY_CLAUDE_PORT` | `43110` | Local bridge port for Claude Code |
| `AGY_CODEX_PORT` | `43111` | Local bridge port for Codex |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness data directory |

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=XiaoYuan151/AGI&type=Date)](https://www.star-history.com/#XiaoYuan151/AGI&Date)
