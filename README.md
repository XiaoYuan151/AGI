# AGI — Antigravity ACP Plugins for Claude Code, Codex, and OpenCode

Use Google Antigravity models directly inside **Claude Code**, **Codex**, and **OpenCode** as if they were built-in.

Each folder in this repository is a standalone `agi` plugin tailored to its agent harness. Once installed, you can open **`/model`** in any of the three tools, pick an Antigravity model (or switch back to your native Claude/OpenAI models mid-conversation), and keep working without leaving your terminal. Every plugin is self-contained—zero build steps and zero third-party npm runtime dependencies.

| Plugin | Harness | How it connects to `agy acp` | Model IDs in `/model` |
| --- | --- | --- | --- |
| [`claude-code/plugins/agi/`](claude-code/plugins/agi) | Claude Code | Local Anthropic-compatible bridge (`127.0.0.1:43110`) + MCP tools + `SessionStart` hook | `anthropic-agy/<model>` |
| [`codex/plugins/agi/`](codex/plugins/agi) | Codex | Local OpenAI Responses API bridge (`127.0.0.1:43111`) + MCP tools + model catalog | `agy/<model>` |
| [`opencode/plugins/agi/`](opencode/plugins/agi) | OpenCode V2 | Native in-process `LanguageModelV3` provider (no HTTP daemon needed) | `agy/<model>` |

---

## How it works

Under the hood, each plugin spawns **`agy acp`** (Antigravity's Agent Client Protocol server over stdio JSON-RPC 2.0), discovers the models and thinking/effort levels your account has access to, and keeps per-conversation ACP sessions alive across turns.

- **OpenCode V2** supports custom providers directly via `@opencode/plugin` (`ctx.provider.transform` + `ctx.aisdk.hook`), so the `agi` plugin runs completely in-process.
- **Claude Code** and **Codex** expect HTTP model endpoints (Anthropic Messages API and OpenAI Responses API respectively), so their `agi` plugins include lightweight localhost bridges that translate those protocols to `agy acp`—and transparently pass native `claude-*` or `gpt-*` requests straight through to Anthropic or OpenAI.

---

## Quick Install (`./install.sh`)

Run the included installer from the repository root to set up all detected harnesses (**Claude Code**, **Codex**, and **OpenCode V2**) with T3 Code's safe Antigravity ACP profile model:

```bash
chmod +x ./install.sh
./install.sh
```

### How it avoids Antigravity account bans (T3 Code model)

- **Official `agy acp` subprocess only:** Never scrapes OAuth tokens from `~/.gemini`, Keychain, or Antigravity IDE, never proxies or spoofs `cloudcode-pa` HTTP endpoints, and never overrides User-Agent headers.
- **Isolated ACP profile (`--gemini-dir ~/.agi/antigravity --app-data-dir antigravity-acp`):** Matches T3 Code's `antigravity-acp` isolation so ACP sessions and credentials never collide with your interactive `agy` CLI or Antigravity desktop IDE. Persisted in `~/.agi/acp.json` and shared across all three plugins.
- **Retry-loop protection:** Auth failures (`-32000`) and policy/quota errors (`403` / `429` / `PERMISSION_DENIED`) trigger an immediate local cooldown instead of hammering `session/new` in tight loops.

Common `install.sh` flags:

```bash
./install.sh --all                     # Install all 3 plugins even if a CLI is not on PATH yet
./install.sh --claude --local-token    # Install Claude Code with gateway discovery (no Anthropic account)
./install.sh --codex --codex-mode default  # Merge agy into ~/.codex/config.toml directly
./install.sh --dry-run                 # Preview actions without modifying files
./install.sh --uninstall               # Remove plugin registrations, settings, and stop bridges
```

---

## 1. Prerequisites

Before using any of the plugins, make sure you have:

1. **Node.js** (18+) installed on your machine.
2. **Antigravity CLI (`agy`)** installed and available on your `PATH` (or set `AGY_BIN=/path/to/agy`).
3. **Authentication** configured for `agy`:
   - **Sign in with Google (interactive):**
     ```bash
     agy acp --login
     ```
   - **Or use a Gemini API key (headless/CI):**
     ```bash
     export GEMINI_API_KEY="your-api-key"
     ```

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
2. Run **`/model`** and pick any `AGY · ...` (`anthropic-agy/<model-id>`) entry, or switch directly with `/model anthropic-agy/gemini-2.5-pro`.
3. Use `/agi:agy-models` to inspect or refresh available models, or `/agi:hello` to test the plugin's greeting skill.
4. To undo the settings changes at any time:
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

Inside Codex, run **`/model`** to switch between `agy/*` Antigravity models (and reasoning effort levels) or native Codex models.

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
- Run `opencode models` or open **`/model`** inside OpenCode to select `agy/<model-id>` (with reasoning effort variants).
- Run **`/agy-models`** to force a live refresh from `agy acp`, or **`/agy-status`** to check connection and authentication status.
- The original `hello_greet` tool (`tools.hello.greet({ name: "..." })`) and `agy_status` / `agy_refresh_models` tools are also available.

---

## Configuration & Troubleshooting

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGY_BIN` | `agy` | Path to the `agy` CLI executable |
| `AGY_AUTH_METHOD` | _(auto)_ | Explicit ACP auth method (`oauth-personal`, `gemini-api-key`, etc.) |
| `AGY_FALLBACK_MODELS` | Gemini 2.5/2.0 list | Comma-separated (`id` or `id:Name`) or JSON array used before live ACP discovery |
| `AGY_CLAUDE_PORT` | `43110` | Port for the Claude Code local bridge |
| `AGY_CODEX_PORT` | `43111` | Port for the Codex local bridge |
| `AGY_UPSTREAM_ANTHROPIC_URL` | `https://api.anthropic.com` | Upstream target for native `claude-*` pass-through |
| `AGY_UPSTREAM_OPENAI_URL` | `https://api.openai.com` | Upstream target for native `gpt-*` pass-through |

---

## Running the Test Suite

The test suite uses a local mock `agy acp` server (`tests/fixtures/mock-agy-acp.mjs`) plus non-destructive checks against your installed CLI tools (without modifying `~/.claude`, `~/.codex`, or `~/.config/opencode`):

```bash
node --test tests/acp-client.test.mjs tests/claude-bridge.test.mjs tests/codex-bridge.test.mjs
bun test tests/opencode-plugin.test.mjs
```
