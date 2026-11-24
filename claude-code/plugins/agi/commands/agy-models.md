---
description: List and refresh Antigravity (agy acp) models available in /model
argument-hint: "[--refresh]"
---

List and optionally refresh the Antigravity ACP models exposed to Claude Code's `/model` picker.

Arguments: $ARGUMENTS

1. Call `agy_status` and `agy_list_models` (or `agy_refresh_models` if `--refresh` was passed).
2. Show the list of `anthropic-agy/<model-id>` IDs and display names, the bridge URL, and authentication status (suggest `/agi:connect` if unauthenticated).
3. Tell the user they can switch immediately in Claude Code via `/model` or `/model anthropic-agy/<model-id>`.
