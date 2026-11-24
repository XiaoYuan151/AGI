# AGI — Antigravity ACP Plugins for Claude Code, Codex, OpenCode, and DeepSeek Harness

Use Google Antigravity models directly inside **Claude Code**, **Codex**, **OpenCode V2**, and **DeepSeek Harness (`dsh`)** as if they were built-in—using Google's official `agy acp` stdio protocol.

Each folder in this repository is a standalone `agi` plugin tailored to its agent harness. Once installed, you can sign in using each harness's native connect command, open **`/model`**, pick an Antigravity model (or switch back to your native models mid-conversation), and keep working without leaving your terminal. Every plugin is self-contained—zero build steps and zero third-party npm runtime dependencies.

| Plugin | Harness | How it connects to `agy acp` | Native sign-in | Model IDs in `/model` |
| --- | --- | --- | --- | --- |
| [`claude-code/plugins/agi/`](claude-code/plugins/agi) | Claude Code | Local Anthropic-compatible bridge (`127.0.0.1:43110`) + MCP tools + `SessionStart` hook | `/agi:connect` (`agy-claude-connect`) | `anthropic-agy/<model>` |
| [`codex/plugins/agi/`](codex/plugins/agi) | Codex | Local OpenAI Responses API bridge (`127.0.0.1:43111`) + MCP tools + model catalog | `$agy-connect` (`agy-codex-connect.mjs`) | `agy/<model>` |
| [`opencode/plugins/agi/`](opencode/plugins/agi) | OpenCode V2 | Native in-process `LanguageModelV3` provider + Integration API (no HTTP daemon needed) | Native `/connect` → **Antigravity (ACP)** (`/agy-connect`) | `agy/<model>` |
| [`deepseek-harness/plugins/agi/`](deepseek-harness/plugins/agi) | DeepSeek Harness (`dsh`) | Native in-process Cordis `LlmAdapter` bundle (no HTTP daemon needed) | `/agy-connect` (`agy-dsh-connect.mjs`) | `agy/<model>` |

---

## How it works

Under the hood, each plugin spawns Google's official unmodified **`agy acp`** (Antigravity's Agent Client Protocol server over stdio JSON-RPC 2.0), discovers the models and thinking/effort levels your account has access to, and keeps per-conversation ACP sessions alive across turns.

- **OpenCode V2** supports custom providers and `/connect` integrations directly via `@opencode/plugin` (`ctx.provider.transform`, `ctx.integration.transform`, `ctx.aisdk.hook`), so the `agi` plugin runs completely in-process.
- **DeepSeek Harness (`dsh`)** supports custom Cordis `LlmAdapter` bundles (`ctx.llm.registerAdapter` + `ctx.commands.register`), so `@local/dsh-agi` also runs completely in-process with real-time streaming and native `/agy-connect`, `/agy-models`, and `/agy-status` commands.
- **Claude Code** and **Codex** expect HTTP model endpoints (Anthropic Messages API and OpenAI Responses API respectively), so their `agi` plugins include lightweight localhost bridges that translate those protocols to `agy acp`—and transparently pass native `claude-*` or `gpt-*` requests straight through to Anthropic or OpenAI.

---

## Quick Install (`curl | bash` or `./install.sh`)

### One-line install with interactive agent picker (no manual clone needed)

Run the installer to launch an **`npx skills`-style multi-select picker** (`↑/↓` move, `Space` toggle, `a` toggle all, `Enter` confirm) where you choose which harnesses to install (**Claude Code**, **Codex**, **OpenCode V2**, and/or **DeepSeek Harness**), cloned into `~/.agi/repo` and configured with T3 Code's safe Antigravity ACP profile model:

```bash
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash
```

Pass installer flags with `bash -s --` (non-interactive or targeted installs):

```bash
# Pick specific agents directly (like `npx skills -a ...`)
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- -a opencode,dsh

# Force all 4 harnesses non-interactively
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --all --yes

# Claude Code without an Anthropic account (enables gateway /v1/models discovery)
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --claude --local-token

# Preview actions without changing files, or uninstall cleanly
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- --uninstall --purge
```

### Install from a local clone

```bash
git clone https://github.com/XiaoYuan151/AGI.git
cd AGI
./install.sh
```

### Google Official Protocol & ToS Compliance (T3 Code model)

- **Official unmodified `agy acp` subprocess only:** All communication uses Google's official `agy acp` stdio JSON-RPC 2.0 server, official `agy acp [--gemini-dir ...] [--app-data-dir ...] --login`, and official ACP `authenticate` / `logout` RPCs. AGI never scrapes OAuth tokens from `~/.gemini`, Keychain, or Antigravity IDE, never proxies or spoofs `cloudcode-pa` HTTP endpoints, and never overrides User-Agent headers.
- **Recommended authentication for third-party / automated harness usage:** To stay comfortably within Google's Terms of Service, prefer a **Gemini API key (`GEMINI_API_KEY` → `gemini-api-key`)** or **Gemini Enterprise (`oauth-business` / `agent-platform`)** over personal consumer OAuth when driving third-party agent harnesses.
- **Isolated ACP profile (`--gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp`):** Matches T3 Code's `antigravity-acp` isolation so ACP sessions and credentials never collide with your interactive `agy` CLI or Antigravity desktop IDE. Persisted in `~/.agi/acp.json` and shared across all four plugins.
- **Retry-loop protection:** Auth failures (`-32000`) and policy/quota errors (`403` / `429` / `PERMISSION_DENIED`) trigger an immediate local cooldown instead of hammering `session/new` in tight loops.

Common installer flags:

```bash
./install.sh                               # Interactive multi-select agent picker (TTY)
./install.sh -a claude,opencode            # Install selected agent(s): claude | codex | opencode | dsh | all
./install.sh --all --yes                   # Install all 4 plugins non-interactively
./install.sh --dsh --dsh-profile desktop   # Install DeepSeek Harness bundle into a specific profile
./install.sh --claude --local-token        # Install Claude Code with gateway discovery (no Anthropic account)
./install.sh --codex --codex-mode default  # Merge agy into ~/.codex/config.toml directly
./install.sh --dry-run                     # Preview actions without modifying files
./install.sh --uninstall                   # Interactively pick agents to uninstall (or pass -a / --all)
./install.sh --uninstall --all --purge     # Remove all 4 agents and delete ~/.agi isolated state
```

---

## 1. Prerequisites

Before using any of the plugins, make sure you have:

1. **Node.js** (18+) installed on your machine.
2. **Antigravity CLI (`agy`)** installed and available on your `PATH` (or set `AGY_BIN=/path/to/agy`).
3. **Authentication** configured for `agy` (via your harness's native connect command or CLI):
   - **Recommended (Google ToS-friendly for third-party / automated harnesses): Gemini API key or Gemini Enterprise:**
     ```bash
     export GEMINI_API_KEY="your-api-key"
     ```
     Or select **Gemini API Key** inside OpenCode's native `/connect` → **Antigravity (ACP)**, or pass `--method gemini-api-key` / `--method oauth-business` / `--method agent-platform`.
   - **Interactive Google sign-in (official `agy acp --login`):**
     ```bash
     agy acp --gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp --login
     ```
     Or use each harness's native command: OpenCode `/connect`, Claude Code `/agi:connect`, Codex `$agy-connect`, or DeepSeek Harness `/agy-connect`.

> **Note:** If `agy` is not signed in yet, each plugin still starts cleanly using a default Gemini fallback list so `/model` populates without errors. As soon as you authenticate and refresh (or restart), your live Antigravity catalog takes over.

---

## 2. Claude Code Setup

### Load and validate the plugin

```bash
claude plugin validate ./claude-code/plugins/agi
claude --plugin-dir ./claude-code/plugins/agi
```

When the session starts, the `SessionStart` hook automatically ensures the local bridge (`agy-claude-bridge`) is running on `http://127.0.0.1:43110`.

### Register Antigravity models in `/model`

Run the included setup helper (either from inside Claude Code with `/agi:agy-setup`, via the `agy_configure_claude` MCP tool, or directly in your shell):

```bash
./claude-code/plugins/agi/bin/agy-claude-setup --scope user --start-bridge
```

What this writes to `~/.claude/settings.json` (use `--scope local` to target `.claude/settings.local.json` instead):
- `ANTHROPIC_BASE_URL=http://127.0.0.1:43110`
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
- `ANTHROPIC_CUSTOM_MODEL_OPTION=anthropic-agy/gemini-2.5-pro` (plus `_NAME` and `_DESCRIPTION`)

**Choosing an auth mode:**
- By default (`--auth-mode auto`), setup **preserves** any existing `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `claude.ai` subscription login so native Claude models keep working.
- If you do **not** have an Anthropic account/key and want Claude Code's gateway discovery (`/v1/models`) to populate every AGY model in `/model`, pass `--auth-mode local-token` (sets `ANTHROPIC_AUTH_TOKEN=agy-acp-local`; the bridge blocks that placeholder token from ever being sent to `api.anthropic.com`).

### Use & manage it
1. Restart `claude` after running setup so it fetches `/v1/models` on startup.
2. Run **`/agi:connect`** inside Claude Code (or `./claude-code/plugins/agi/bin/agy-claude-connect` in your terminal) to check ACP authentication, sign in via official `agy acp ... --login` or `GEMINI_API_KEY`, refresh models, or log out via official ACP `logout`.
3. Run **`/model`** and pick any `AGY · ...` (`anthropic-agy/<model-id>`) entry, or switch directly with `/model anthropic-agy/gemini-2.5-pro`.
4. Use `/agi:agy-models` to inspect or refresh available models, or `/agi:hello` to test the plugin's greeting skill.
5. To undo the settings changes at any time:
   ```bash
   ./claude-code/plugins/agi/bin/agy-claude-setup --scope user --remove
   ```

---

## 3. Codex Setup

### Install the plugin from the local marketplace

From inside the `codex/` directory:

```bash
cd codex
codex plugin marketplace add .
codex plugin add agi@local-repo
codex plugin list -m local-repo
```

### Register Antigravity models in `/model`

For security, Codex ignores `model_providers` and `model_provider` in repository-local `.codex/config.toml` files, so the provider must live in your user `$CODEX_HOME` (`~/.codex`). Run the setup script (or invoke the `agy_configure_codex` MCP tool inside Codex):

```bash
node ./codex/plugins/agi/scripts/setup-codex.mjs --start-bridge
```

By default this creates:
- `~/.codex/agy-models.json` — the Codex model catalog with `agy/*` entries (plus Codex's bundled models so you can switch between both in `/model`).
- `~/.codex/agy.config.toml` — a clean `agy` profile pointing `[model_providers.agy]` (`wire_api = "responses"`) at `http://127.0.0.1:43111/v1`.

Launch Codex with the profile:

```bash
codex -p agy
```

> Prefer making `agy` available in your default `codex` session without `-p agy`? Pass `--mode default` to `setup-codex.mjs` to merge the provider cleanly into `~/.codex/config.toml`. To revert either mode cleanly, pass `--remove`.

Inside Codex:
- Run **`$agy-connect`** (or `node ./codex/plugins/agi/scripts/agy-codex-connect.mjs` in your terminal) to inspect ACP authentication, sign in with official `agy acp ... --login` / `GEMINI_API_KEY`, refresh the bridge + `agy-models.json`, or log out.
- Run **`/model`** to switch between `agy/*` Antigravity models (and reasoning effort levels) or native Codex models.

---

## 4. OpenCode V2 Setup

OpenCode loads TypeScript plugins directly—no bridge process or port configuration required.

### Option A: Auto-discovery per project
Copy `opencode/plugins/agi` into `.opencode/plugins/agi/` in your project directory.

### Option B: Reference in `opencode.jsonc`

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

### Use it
- Run OpenCode's native **`/connect`** command and select **Antigravity (ACP)** to sign in via:
  - **Antigravity ACP Sign-In (`agy acp ... --login`)** — runs Google's official interactive login command in your terminal,
  - **Gemini API Key** — stores your `GEMINI_API_KEY` securely in OpenCode's credential store (recommended for Google ToS compliance), or
  - **`GEMINI_API_KEY` environment variable**.
  OpenCode's `credential.updated` event automatically restarts the ACP process and refreshes `/model`.
- Run **`/agy-connect`** (`status` | `refresh` | `logout`) for quick auth inspection or official ACP logout.
- Run `opencode models` or open **`/model`** inside OpenCode to select `agy/<model-id>` (with reasoning effort variants).
- Run **`/agy-models`** to force a live refresh from `agy acp`, or **`/agy-status`** to check connection and authentication status.
- The `hello_greet`, `agy_connect`, `agy_status`, and `agy_refresh_models` tools are also available.

---

## 5. DeepSeek Harness (`dsh`) Setup

DeepSeek Harness loads Cordis bundles directly—no HTTP bridge daemon or port configuration required.

### Install into your DeepSeek Harness profile(s)

Run the interactive installer (`./install.sh -a dsh`) or invoke the standalone setup script directly:

```bash
node ./deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

By default, this links `@local/dsh-agi` into every existing profile under `~/.dsh/profiles/` (or creates `~/.dsh/profiles/desktop/` if none exist; pass `--profile <name>` to target a specific profile, or `--remove` to cleanly uninstall).

### Use it
1. Restart DeepSeek Harness (Desktop or CLI) so Cordis loads the `@local/dsh-agi` bundle.
2. Run **`/agy-connect`** inside DeepSeek Harness (or `node ./deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs` in your terminal) to check status, sign in with official `agy acp ... --login` or `/agy-connect method gemini-api-key`, refresh models, or run `/agy-connect logout`.
3. Select any **`agy/<model-id>`** model (with Low/Medium/High reasoning effort) in DeepSeek Harness's model picker.
4. Use **`/agy-models`** to refresh the live ACP catalog or **`/agy-status`** to inspect runtime health.

---

## Configuration & Troubleshooting

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Path to the `agy` CLI executable |
| `AGY_GEMINI_DIR` | `~/.agi/antigravity` (via `acp.json`) | Isolated `--gemini-dir` passed to `agy acp` |
| `AGY_APP_DATA_DIR` | `antigravity-acp` (via `acp.json`) | `--app-data-dir` passed to `agy acp` |
| `AGY_AUTH_METHOD` | _(auto)_ | Explicit ACP auth method (`gemini-api-key`, `oauth-business`, `agent-platform`, `oauth-personal`) |
| `AGY_FALLBACK_MODELS` | Gemini 2.5/2.0 list | Comma-separated (`id` or `id:Name`) or JSON array used before live ACP discovery |
| `AGY_CLAUDE_PORT` | `43110` | Port for the Claude Code local bridge |
| `AGY_CODEX_PORT` | `43111` | Port for the Codex local bridge |
| `AGY_UPSTREAM_ANTHROPIC_URL` | `https://api.anthropic.com` | Upstream target for native `claude-*` pass-through |
| `AGY_UPSTREAM_OPENAI_URL` | `https://api.openai.com` | Upstream target for native `gpt-*` pass-through |
| `DSH_HOME` | `~/.dsh` | DeepSeek Harness home directory containing `profiles/` |

---

## Running the Test Suite

The test suite uses a local mock `agy acp` server (`tests/fixtures/mock-agy-acp.mjs`) plus isolated temporary directories (without modifying `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.dsh`, or `~/.agi`):

```bash
node --test tests/acp-client.test.mjs tests/claude-bridge.test.mjs tests/codex-bridge.test.mjs tests/dsh-plugin.test.mjs tests/install.test.mjs
bun test tests/opencode-plugin.test.mjs
```
