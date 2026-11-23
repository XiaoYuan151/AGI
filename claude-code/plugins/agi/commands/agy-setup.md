---
description: Configure Claude Code to expose Antigravity (agy acp) models natively in /model
argument-hint: "[--scope user|local] [--auth-mode auto|preserve|local-token]"
---

Help the user configure Claude Code to route `anthropic-agy/*` models through `agy acp` and show them natively in `/model`.

Arguments: $ARGUMENTS

1. If the user passed flags or wants automatic setup, call the `agy_configure_claude` MCP tool (or run `agy-claude-setup $ARGUMENTS`).
2. Default to `scope: "user"` and `authMode: "auto"`, which preserves any existing `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `claude.ai` login while setting `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, and `ANTHROPIC_CUSTOM_MODEL_OPTION`.
3. Mention that if they do NOT have an Anthropic API key or `claude.ai` login and want `/v1/models` gateway discovery to populate every AGY model in `/model`, they can pass `--auth-mode local-token`.
4. Remind them to restart `claude` (or reload settings) and run `/model` to select an `AGY · ...` (`anthropic-agy/<model-id>`) model.
5. Also note `agy acp --login` (or `GEMINI_API_KEY`) is required if `agy_status` shows `authenticated: false`.
