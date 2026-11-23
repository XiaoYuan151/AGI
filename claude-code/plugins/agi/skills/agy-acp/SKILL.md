---
name: agy-acp
description: Integrate Google Antigravity (agy acp) with Claude Code so Antigravity models appear natively in /model and can be switched mid-session. Use when setting up, debugging, or refreshing Antigravity models in Claude Code.
---

# Antigravity ACP (`agy acp`) in Claude Code

This plugin includes a local Anthropic-compatible bridge (`agy-claude-bridge`) and MCP helper (`agy-acp`) backed by `agy acp`.

## How `/model` integration works

1. The local bridge listens on `http://127.0.0.1:43110` (`AGY_CLAUDE_PORT` overrides).
2. `GET /v1/models` returns Antigravity ACP models prefixed with `anthropic-agy/` (for example `anthropic-agy/gemini-2.5-pro`) so Claude Code gateway discovery keeps every model in `/model`.
3. `POST /v1/messages` routes `anthropic-agy/*` (and `agy/*`) models to `agy acp` via JSON-RPC over stdio, maintaining per-conversation ACP sessions and switching models cleanly when `/model` changes.
4. Native `claude-*` models are transparently forwarded to `ANTHROPIC_BASE_URL` upstream (`https://api.anthropic.com` by default).

## Setup & verification

- Run `agy-claude-setup` (or `/agi:agy-setup`) to write settings non-destructively.
- If Antigravity is not authenticated yet, run `agy acp --login` or export `GEMINI_API_KEY`.
- Restart `claude` after configuring settings so Claude Code queries `/v1/models` on startup, then run `/model`.
