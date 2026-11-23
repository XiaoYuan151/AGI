#!/usr/bin/env bash
# SessionStart hook: preserves agi greeting and ensures the local agy acp bridge is running.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${AGY_CLAUDE_PORT:-43110}"
HOST="${AGY_CLAUDE_HOST:-127.0.0.1}"

echo "agi loaded (project: ${CLAUDE_PROJECT_DIR:-unknown})"

if [[ "${AGY_AUTO_START_BRIDGE:-1}" == "0" ]]; then
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  if status_line="$(node "${SCRIPT_DIR}/agy-claude-bridge.mjs" ensure --host "${HOST}" --port "${PORT}" 2>/dev/null)"; then
    echo "${status_line} (use /model anthropic-agy/... or /agi:agy-setup)"
  else
    echo "agy-claude-bridge could not be started automatically; run agy-claude-bridge start"
  fi
fi
