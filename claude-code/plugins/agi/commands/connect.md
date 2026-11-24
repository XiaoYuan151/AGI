---
description: Sign in to Google Antigravity ACP (agy acp) and refresh models in /model
argument-hint: "[--status | --method api-key|enterprise|vertex | --refresh | --logout]"
---

Help the user connect or manage authentication for Google Antigravity ACP (`agy acp`) in Claude Code using **Google's official supported ACP sign-in flow only** (never scrape OAuth tokens or bypass ToS).

Arguments: $ARGUMENTS

1. Inspect current status first by calling the `agy_connect` MCP tool with `{ action: "status" }`.
2. Handle the requested action based on `$ARGUMENTS`:
   - **`--status`**: Report `authenticated`, isolated `--gemini-dir` / `--app-data-dir`, available official `authMethods`, and the exact official `loginCommand`.
   - **`--logout`**: Call `agy_connect` with `{ action: "logout" }` (uses official ACP `logout` RPC).
   - **`--refresh`**: Call `agy_connect` with `{ action: "refresh" }` to restart ACP after sign-in and refresh `/model`.
   - **`--method api-key|gemini-api-key|enterprise|oauth-business|vertex|agent-platform`**: Map aliases (`api-key` -> `gemini-api-key`, `enterprise` -> `oauth-business`, `vertex` -> `agent-platform`) and call `agy_connect` with `{ action: "authenticate", methodId }`.
   - **No arguments / interactive Google sign-in**:
     - If `GEMINI_API_KEY` is already set (`hasGeminiApiKey: true`), offer to authenticate directly via `agy_connect({ action: "authenticate", methodId: "gemini-api-key" })`.
     - Otherwise, tell the user to run the exact official interactive login helper in their terminal (or run `agy-claude-connect` when an interactive TTY is available):
       ```bash
       agy-claude-connect
       ```
       (which runs the official unmodified `agy acp [--gemini-dir ...] [--app-data-dir ...] --login` command and automatically refreshes the local bridge).
     - After sign-in completes, call `agy_connect({ action: "refresh" })` and confirm the live `anthropic-agy/*` models are ready in `/model`.
3. **Multi-account management**:
   - Use the `agy_accounts` MCP tool (`action: "list" | "add" | "switch" | "remove"`) to add or switch between isolated accounts stored in separate data folders (or run `agi account add <name> --data-dir <dir> --login` / `agi account use <name>` in your terminal).
4. Include a brief Google ToS compliance note: this plugin only uses Google's official `agy acp` stdio protocol and `agy acp --login`; for automated or third-party harness usage, `GEMINI_API_KEY` or Gemini Enterprise (`oauth-business` / `agent-platform`) is recommended.
