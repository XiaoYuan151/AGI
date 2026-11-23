---
name: agy-acp
description: Integrate Google Antigravity (agy acp) with Codex so Antigravity models appear natively in /model and can be switched mid-session. Use when setting up, refreshing, or troubleshooting agy/* models in Codex.
---

# Antigravity ACP (`agy acp`) in Codex

This plugin bundles a local OpenAI Responses API bridge (`agy-codex-bridge.mjs`), an MCP control server (`agy-acp` in `mcp.json`), and a setup script (`setup-codex.mjs`) that registers Antigravity models in Codex's native `/model` picker.

## Quick setup

1. Call the `agy_configure_codex` MCP tool (or run `node scripts/setup-codex.mjs --start-bridge`), which:
   - Writes `~/.codex/agy-models.json` with `agy/*` model entries (plus bundled Codex models by default).
   - Writes `~/.codex/agy.config.toml` configuring `[model_providers.agy]` (`wire_api = "responses"`, `base_url = "http://127.0.0.1:43111/v1"`).
2. Start Codex with `codex -p agy` (or pass `--mode default` to configure `~/.codex/config.toml` directly).
3. Use `/model` inside Codex to switch between `agy/*` Antigravity models and native Codex models.

## Authentication

If `agy_status` reports `authenticated: false`, run `agy acp --login` or export `GEMINI_API_KEY`, then call `agy_refresh_models`.
