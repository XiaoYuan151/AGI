---
name: agy-connect
description: Sign in to Google Antigravity ACP (agy acp), check auth status, refresh Codex /model entries, or sign out using Google's official ACP workflow. Invoke natively via $agy-connect in Codex.
---

# Connect Google Antigravity ACP (`$agy-connect`)

Use this native Codex skill whenever the user invokes `$agy-connect` or asks to sign in, connect, check authentication, or sign out of Antigravity ACP (`agy acp`).

Strictly use **Google's official supported `agy acp` sign-in protocol** (never scrape OAuth tokens or bypass ToS).

## Workflow

1. Call the `agy_connect` MCP tool with `{ "action": "status" }` first to inspect:
   - `authenticated`
   - Isolated profile (`geminiDir`, `appDataDir`)
   - Available official `authMethods` (`oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`)
   - Exact official `loginCommand` (`agy acp [--gemini-dir ...] [--app-data-dir ...] --login`)
2. Based on what the user wants:
   - **Check status**: Summarize auth state, isolated profile, model count, and official `loginCommand`.
   - **API Key / Gemini Enterprise / Vertex AI**: If the user has `GEMINI_API_KEY` set or asks for `gemini-api-key`, `oauth-business`, or `agent-platform`, call `agy_connect` with `{ "action": "authenticate", "methodId": "<id>" }`.
   - **Interactive Google sign-in (`agy acp --login`)**:
     - Instruct the user to run the official interactive sign-in helper in their terminal (or run it when interactive TTY is available):
       ```bash
       node ~/.agi/repo/codex/plugins/agi/scripts/agy-codex-connect.mjs
       ```
       (or directly run the exact `loginCommand` reported by `agy_connect`, then call `agy_connect({ "action": "refresh" })`).
     - Refreshing automatically restarts the ACP subprocess, clears cooldowns, discovers live models, and updates `~/.codex/agy-models.json`.
   - **Sign out**: Call `agy_connect` with `{ "action": "logout" }` (uses official ACP `logout` RPC).
   - **Multi-account management**: Call `agy_accounts` (`{ "action": "list" | "add" | "switch" | "remove", ... }`) to add or switch between isolated accounts saved in separate data folders (or run `agi account add <name> --data-dir <dir> --login` / `agi account use <name>`).
3. Include a brief Google ToS note: this plugin uses Google's official unmodified `agy acp` stdio protocol and `agy acp --login`; for automated or third-party harness usage, `GEMINI_API_KEY` or Gemini Enterprise (`oauth-business` / `agent-platform`) is recommended.
