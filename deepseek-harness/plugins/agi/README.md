# DeepSeek Harness (`dsh`) Plugin + Antigravity ACP (`agy acp`)

Native DeepSeek Harness Cordis bundle (`@local/dsh-agi`). Zero build steps and zero third-party npm runtime dependencies.

- **Native LLM Provider (`agy`)**: Registers an in-process `LlmAdapter` via `ctx.llm.registerAdapter(["agy"], adapter)` backed directly by Google's official `agy acp` over stdio JSON-RPC 2.0 (no local HTTP bridge daemon needed).
- **Native Slash Commands**: Registers `/agy-connect`, `/agy-models`, `/agy-status`, `/agy-accounts`, and `/agy-gui` via `ctx.commands.register(...)`.
- **Native Settings & Standalone Account GUI**: Renders an **Antigravity (ACP)** panel in DeepSeek Harness **Settings** and **Plugins** views (backed by `POST/GET /api/agi`), plus a standalone local web GUI (`agy-dsh-gui` / `agi gui` / `/agy-gui start`) for signing in and managing isolated multi-account profiles.
- **Isolated ACP Profile & Multi-Account**: Reads `~/.agi/acp.json` (each account saved to its own `--gemini-dir` data folder + `--app-data-dir antigravity-acp`) and uses only Google's official unmodified `agy acp` subprocess and `agy acp --login` / official ACP `authenticate` & `logout` RPCs.

## Install into DeepSeek Harness

Use the root interactive installer:

```bash
./install.sh --dsh
```

Or run the DeepSeek Harness setup script directly:

```bash
node deepseek-harness/plugins/agi/scripts/setup-dsh.mjs
```

This non-destructively links `@local/dsh-agi` into your DeepSeek Harness profile(s) under `~/.dsh/profiles/<profile>/` (`desktop`, `web`, etc.) by adding the `link:` dependency and bundle entry in `package.json` plus symlinking `node_modules/@local/dsh-agi`.

To target a specific profile or uninstall:

```bash
node deepseek-harness/plugins/agi/scripts/setup-dsh.mjs --profile desktop
node deepseek-harness/plugins/agi/scripts/setup-dsh.mjs --remove
```

## Authenticate & Use

1. Authenticate via Google's official CLI or API key:
   - **Recommended for ToS compliance in third-party harnesses:** export `GEMINI_API_KEY` (or configure Gemini Enterprise `oauth-business` / `agent-platform`), then run `/agy-connect method gemini-api-key` inside DeepSeek Harness.
   - **Interactive Google sign-in:** run `node deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs` (invokes official `agy acp [--gemini-dir ...] [--app-data-dir ...] --login`), then run `/agy-connect refresh`.
2. Restart DeepSeek Harness (Desktop / Web / CLI) and pick an **`Antigravity (ACP)` (`agy/*`)** model in the model selector.
3. Use `/agy-connect`, `/agy-models`, `/agy-status`, and `/agy-accounts` (`list | add <name> --data-dir <dir> | use <name> | remove <name>`) anytime inside a session.
