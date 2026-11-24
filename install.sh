#!/usr/bin/env bash
set -euo pipefail

# AGI plugin installer for Claude Code, Codex, and OpenCode V2.
# Uses T3 Code's Antigravity safety model:
#   1. Official unmodified `agy acp` subprocess over stdio JSON-RPC 2.0 only
#      (no OAuth token extraction, no Cloud Code HTTP proxying, no UA spoofing).
#   2. Isolated ACP profile via `--gemini-dir` + `--app-data-dir antigravity-acp`
#      so ACP sessions never collide with interactive `agy` CLI or Antigravity IDE.
#   3. Built-in auth/policy cooldowns to prevent ban-triggering retry loops.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AGI_HOME="${AGI_HOME:-$HOME/.agi}"
AGY_BIN="${AGY_BIN:-agy}"
AGY_GEMINI_DIR="${AGY_GEMINI_DIR:-$AGI_HOME/antigravity}"
AGY_APP_DATA_DIR="${AGY_APP_DATA_DIR:-antigravity-acp}"
USE_DEFAULT_GEMINI_DIR=0

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

INSTALL_CLAUDE=0
INSTALL_CODEX=0
INSTALL_OPENCODE=0
FORCE_ALL=0

CLAUDE_AUTH_MODE="auto"
CODEX_MODE="profile"
FORCE_LOGIN=0
SKIP_LOGIN=0
START_BRIDGE=1
COPY_OPENCODE=0
UNINSTALL=0
PURGE=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Targets (default: auto-detect installed Claude Code, Codex, and OpenCode):
  --all                         Configure all three harnesses
  --claude                      Configure Claude Code plugin + bridge
  --codex                       Configure Codex plugin + bridge
  --opencode                    Configure OpenCode V2 plugin

Antigravity ACP isolation (T3 Code safe mode):
  --gemini-dir <dir>            Isolated --gemini-dir for agy acp (default: ~/.agi/antigravity)
  --app-data-dir <name>         --app-data-dir for agy acp (default: antigravity-acp)
  --use-default-gemini-dir      Do not pass --gemini-dir (share ~/.gemini, keep antigravity-acp)
  --login                       Force interactive `agy acp ... --login`
  --skip-login                  Skip interactive login if unauthenticated

Harness options:
  --claude-auth-mode <mode>     auto (default) | preserve | local-token
  --local-token                 Shorthand for --claude-auth-mode local-token
  --codex-mode <mode>           profile (default: `codex -p agy`) | default (merge ~/.codex/config.toml)
  --no-start-bridge             Configure without starting background bridge daemons
  --copy                        Copy OpenCode plugin instead of symlinking

Lifecycle:
  --uninstall, --remove         Remove plugin registrations, configs, and stop bridges
  --purge                       With --uninstall, also delete ~/.agi isolated state
  --dry-run                     Print actions without modifying files or running mutations
  -h, --help                    Show this help message
EOF
}

log() {
  printf '[agi-install] %s\n' "$*"
}

warn() {
  printf '[agi-install] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[agi-install] ERROR: %s\n' "$*" >&2
  exit 1
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) FORCE_ALL=1 ;;
    --claude) INSTALL_CLAUDE=1 ;;
    --codex) INSTALL_CODEX=1 ;;
    --opencode) INSTALL_OPENCODE=1 ;;
    --gemini-dir)
      [[ $# -ge 2 ]] || die "--gemini-dir requires a path"
      AGY_GEMINI_DIR="$2"
      shift
      ;;
    --app-data-dir)
      [[ $# -ge 2 ]] || die "--app-data-dir requires a value"
      AGY_APP_DATA_DIR="$2"
      shift
      ;;
    --use-default-gemini-dir) USE_DEFAULT_GEMINI_DIR=1 ;;
    --claude-auth-mode)
      [[ $# -ge 2 ]] || die "--claude-auth-mode requires auto|preserve|local-token"
      CLAUDE_AUTH_MODE="$2"
      shift
      ;;
    --local-token) CLAUDE_AUTH_MODE="local-token" ;;
    --codex-mode)
      [[ $# -ge 2 ]] || die "--codex-mode requires profile|default"
      CODEX_MODE="$2"
      shift
      ;;
    --login) FORCE_LOGIN=1 ;;
    --skip-login) SKIP_LOGIN=1 ;;
    --no-start-bridge) START_BRIDGE=0 ;;
    --copy) COPY_OPENCODE=1 ;;
    --uninstall|--remove) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (run ./install.sh --help)"
      ;;
  esac
  shift
done

if [[ "$USE_DEFAULT_GEMINI_DIR" -eq 1 ]]; then
  AGY_GEMINI_DIR=""
fi

if [[ "$FORCE_ALL" -eq 1 ]]; then
  INSTALL_CLAUDE=1
  INSTALL_CODEX=1
  INSTALL_OPENCODE=1
elif [[ "$INSTALL_CLAUDE" -eq 0 && "$INSTALL_CODEX" -eq 0 && "$INSTALL_OPENCODE" -eq 0 ]]; then
  if command -v claude >/dev/null 2>&1 || [[ -d "$CLAUDE_CONFIG_DIR" ]]; then
    INSTALL_CLAUDE=1
  fi
  if command -v codex >/dev/null 2>&1 || [[ -d "$CODEX_HOME" ]]; then
    INSTALL_CODEX=1
  fi
  if command -v opencode >/dev/null 2>&1 || [[ -d "$OPENCODE_CONFIG_DIR" ]]; then
    INSTALL_OPENCODE=1
  fi
  if [[ "$INSTALL_CLAUDE" -eq 0 && "$INSTALL_CODEX" -eq 0 && "$INSTALL_OPENCODE" -eq 0 ]]; then
    INSTALL_CLAUDE=1
    INSTALL_CODEX=1
    INSTALL_OPENCODE=1
  fi
fi

command -v node >/dev/null 2>&1 || die "Node.js (18+) is required."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  die "Node.js 18+ is required (found $(node -v))."
fi

export AGI_HOME
export AGY_BIN
export AGY_GEMINI_DIR
export AGY_APP_DATA_DIR
export AGY_ACP_CONFIG="$AGI_HOME/acp.json"
export CLAUDE_CONFIG_DIR
export CODEX_HOME

stop_bridges() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Would stop any running agy-claude-bridge / agy-codex-bridge processes"
    return 0
  fi
  node "$REPO_ROOT/claude-code/plugins/agi/scripts/agy-claude-bridge.mjs" stop >/dev/null 2>&1 || true
  node "$REPO_ROOT/codex/plugins/agi/scripts/agy-codex-bridge.mjs" stop >/dev/null 2>&1 || true
}

uninstall_all() {
  log "Uninstalling AGI plugins..."
  stop_bridges

  if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
    log "Removing Claude Code configuration..."
    run_cmd node "$REPO_ROOT/claude-code/plugins/agi/scripts/setup-claude.mjs" --scope user --remove >/dev/null
    if command -v claude >/dev/null 2>&1; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "[dry-run] claude plugin uninstall agi@local-agi --scope user"
        log "[dry-run] claude plugin marketplace remove local-agi"
      else
        claude plugin uninstall "agi@local-agi" --scope user </dev/null >/dev/null 2>&1 || true
        claude plugin marketplace remove "local-agi" </dev/null >/dev/null 2>&1 || true
      fi
    fi
  fi

  if [[ "$INSTALL_CODEX" -eq 1 ]]; then
    log "Removing Codex configuration..."
    run_cmd node "$REPO_ROOT/codex/plugins/agi/scripts/setup-codex.mjs" --codex-home "$CODEX_HOME" --mode profile --remove >/dev/null
    if [[ -f "$CODEX_HOME/config.toml" ]] && grep -q "agy-acp-bridge" "$CODEX_HOME/config.toml" 2>/dev/null; then
      run_cmd node "$REPO_ROOT/codex/plugins/agi/scripts/setup-codex.mjs" --codex-home "$CODEX_HOME" --mode default --remove >/dev/null
    fi
    if command -v codex >/dev/null 2>&1; then
      if [[ "$DRY_RUN" -eq 1 ]]; then
        log "[dry-run] codex plugin remove agi@local-repo"
        log "[dry-run] codex plugin marketplace remove local-repo"
      else
        codex plugin remove "agi@local-repo" </dev/null >/dev/null 2>&1 || true
        codex plugin marketplace remove "local-repo" </dev/null >/dev/null 2>&1 || true
      fi
    fi
  fi

  if [[ "$INSTALL_OPENCODE" -eq 1 ]]; then
    local oc_target="$OPENCODE_CONFIG_DIR/plugins/agi"
    if [[ -L "$oc_target" ]]; then
      log "Removing OpenCode plugin symlink: $oc_target"
      run_cmd rm -f "$oc_target"
    elif [[ -d "$oc_target" ]]; then
      if [[ -f "$oc_target/package.json" ]] && grep -q '"agi"' "$oc_target/package.json" 2>/dev/null; then
        log "Removing OpenCode plugin directory: $oc_target"
        run_cmd rm -rf "$oc_target"
      else
        warn "Leaving unrecognized directory at $oc_target intact."
      fi
    fi
  fi

  if [[ -f "$AGI_HOME/acp.json" ]]; then
    run_cmd rm -f "$AGI_HOME/acp.json"
  fi

  if [[ "$PURGE" -eq 1 ]]; then
    log "Purging isolated AGI state at $AGI_HOME"
    run_cmd rm -rf "$AGI_HOME"
  elif [[ -n "$AGY_GEMINI_DIR" && -d "$AGY_GEMINI_DIR" ]]; then
    log "Kept isolated Antigravity ACP auth dir at $AGY_GEMINI_DIR (pass --purge to delete)"
  fi

  log "Uninstall complete."
  exit 0
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_all
fi

# ---------------------------------------------------------------------------
# 1. Verify official `agy` CLI & set up T3 Code-style isolated ACP profile
# ---------------------------------------------------------------------------
if ! command -v "$AGY_BIN" >/dev/null 2>&1; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    warn "'$AGY_BIN' binary not found on PATH (continuing because --dry-run is set)."
  else
    die "Antigravity CLI ('$AGY_BIN') not found on PATH. Install the official Antigravity CLI first, or set AGY_BIN=/path/to/agy."
  fi
else
  AGY_VER="$("$AGY_BIN" --version </dev/null 2>/dev/null || echo "unknown")"
  log "Using official Antigravity CLI: $(command -v "$AGY_BIN") (version: $AGY_VER)"
fi

log "Configuring T3 Code-style isolated ACP profile:"
if [[ -n "$AGY_GEMINI_DIR" ]]; then
  log "  --gemini-dir   : $AGY_GEMINI_DIR"
else
  log "  --gemini-dir   : (default ~/.gemini)"
fi
log "  --app-data-dir : ${AGY_APP_DATA_DIR:-antigravity-cli}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "[dry-run] Would write $AGI_HOME/acp.json (chmod 700 on $AGI_HOME)"
else
  mkdir -p "$AGI_HOME"
  chmod 700 "$AGI_HOME"
  if [[ -n "$AGY_GEMINI_DIR" ]]; then
    mkdir -p "$AGY_GEMINI_DIR"
    chmod 700 "$AGY_GEMINI_DIR"
  fi
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const outPath = process.argv[1];
    const payload = {
      geminiDir: process.argv[2],
      appDataDir: process.argv[3],
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  ' "$AGI_HOME/acp.json" "$AGY_GEMINI_DIR" "$AGY_APP_DATA_DIR"
fi

export AGI_HOME
export AGY_BIN
export AGY_GEMINI_DIR
export AGY_APP_DATA_DIR
export AGY_ACP_CONFIG="$AGI_HOME/acp.json"

probe_acp_auth() {
  node -e '
    import("./claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs").then(async ({ AgyAcpClient }) => {
      const client = new AgyAcpClient({
        agyBin: process.env.AGY_BIN || "agy",
        geminiDir: process.env.AGY_GEMINI_DIR || "",
        appDataDir: process.env.AGY_APP_DATA_DIR || "",
        rpcTimeoutMs: 6000,
      });
      try {
        const res = await client.discoverModels({ forceRefresh: true, timeoutMs: 6000 });
        console.log(JSON.stringify({
          authenticated: res.authenticated,
          source: res.source,
          modelsCount: res.models.length,
          error: res.error || null,
        }));
      } finally {
        await client.dispose();
      }
    }).catch((err) => {
      console.log(JSON.stringify({ authenticated: false, source: "error", modelsCount: 0, error: err.message }));
    });
  '
}

LOGIN_CMD=("$AGY_BIN" "acp")
if [[ -n "$AGY_GEMINI_DIR" ]]; then
  LOGIN_CMD+=("--gemini-dir" "$AGY_GEMINI_DIR")
fi
if [[ -n "$AGY_APP_DATA_DIR" ]]; then
  LOGIN_CMD+=("--app-data-dir" "$AGY_APP_DATA_DIR")
fi
LOGIN_CMD+=("--login")

if [[ "$DRY_RUN" -eq 0 ]] && command -v "$AGY_BIN" >/dev/null 2>&1; then
  AUTH_JSON="$(cd "$REPO_ROOT" && probe_acp_auth)"
  IS_AUTH="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.authenticated === true ? "1" : "0");' "$AUTH_JSON")"
  MODELS_CNT="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.modelsCount || 0);' "$AUTH_JSON")"

  if [[ "$FORCE_LOGIN" -eq 1 || ( "$IS_AUTH" -ne 1 && -z "${GEMINI_API_KEY:-}" && "$SKIP_LOGIN" -eq 0 ) ]]; then
    if [[ -t 0 ]]; then
      log "Running official interactive ACP sign-in: ${LOGIN_CMD[*]}"
      "${LOGIN_CMD[@]}" || warn "Interactive login did not complete; fallback models will still be registered."
      AUTH_JSON="$(cd "$REPO_ROOT" && probe_acp_auth)"
      IS_AUTH="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.authenticated === true ? "1" : "0");' "$AUTH_JSON")"
      MODELS_CNT="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.modelsCount || 0);' "$AUTH_JSON")"
    else
      warn "Isolated Antigravity ACP profile is not authenticated yet (non-interactive shell)."
      warn "Run: ${LOGIN_CMD[*]}"
      warn "Or export GEMINI_API_KEY before starting your agent."
    fi
  fi

  if [[ "$IS_AUTH" -eq 1 ]]; then
    log "Antigravity ACP authenticated ($MODELS_CNT live models discovered)."
  else
    log "Using fallback model list until authenticated (${LOGIN_CMD[*]})."
  fi
fi

# Restart any already-running bridges so they pick up the isolated ACP profile.
stop_bridges

# ---------------------------------------------------------------------------
# 2. Claude Code
# ---------------------------------------------------------------------------
if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
  log "Setting up Claude Code plugin (agi)..."
  if command -v claude >/dev/null 2>&1; then
    run_cmd claude plugin validate "$REPO_ROOT/claude-code/plugins/agi" </dev/null >/dev/null
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[dry-run] claude plugin marketplace add $REPO_ROOT/claude-code"
      log "[dry-run] claude plugin install agi@local-agi --scope user"
    else
      if claude plugin marketplace list </dev/null 2>/dev/null | grep -q "local-agi"; then
        claude plugin marketplace update local-agi </dev/null >/dev/null 2>&1 || true
      else
        claude plugin marketplace add "$REPO_ROOT/claude-code" </dev/null >/dev/null 2>&1 || true
      fi
      claude plugin install "agi@local-agi" --scope user </dev/null >/dev/null 2>&1 || \
        warn "Could not install via 'claude plugin install'; load directly with: claude --plugin-dir \"$REPO_ROOT/claude-code/plugins/agi\""
    fi
  else
    warn "'claude' CLI not found; configuring $CLAUDE_CONFIG_DIR/settings.json only."
  fi

  CLAUDE_SETUP_ARGS=(
    "$REPO_ROOT/claude-code/plugins/agi/scripts/setup-claude.mjs"
    "--scope" "user"
    "--auth-mode" "$CLAUDE_AUTH_MODE"
    "--app-data-dir" "$AGY_APP_DATA_DIR"
  )
  if [[ -n "$AGY_GEMINI_DIR" ]]; then
    CLAUDE_SETUP_ARGS+=("--gemini-dir" "$AGY_GEMINI_DIR")
  fi
  if [[ "$START_BRIDGE" -eq 1 ]]; then
    CLAUDE_SETUP_ARGS+=("--start-bridge")
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    CLAUDE_SETUP_ARGS+=("--dry-run")
  fi
  node "${CLAUDE_SETUP_ARGS[@]}" >/dev/null
  log "Claude Code configured ($CLAUDE_CONFIG_DIR/settings.json, auth-mode=$CLAUDE_AUTH_MODE)."
fi

# ---------------------------------------------------------------------------
# 3. Codex
# ---------------------------------------------------------------------------
if [[ "$INSTALL_CODEX" -eq 1 ]]; then
  log "Setting up Codex plugin (agi)..."
  if command -v codex >/dev/null 2>&1; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[dry-run] codex plugin marketplace add $REPO_ROOT/codex"
      log "[dry-run] codex plugin add agi@local-repo"
    else
      codex plugin marketplace add "$REPO_ROOT/codex" </dev/null >/dev/null 2>&1 || true
      codex plugin add "agi@local-repo" </dev/null >/dev/null 2>&1 || true
    fi
  else
    warn "'codex' CLI not found; configuring $CODEX_HOME files only."
  fi

  CODEX_SETUP_ARGS=(
    "$REPO_ROOT/codex/plugins/agi/scripts/setup-codex.mjs"
    "--codex-home" "$CODEX_HOME"
    "--mode" "$CODEX_MODE"
  )
  if [[ "$START_BRIDGE" -eq 1 ]]; then
    CODEX_SETUP_ARGS+=("--start-bridge")
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    CODEX_SETUP_ARGS+=("--dry-run")
  fi
  node "${CODEX_SETUP_ARGS[@]}" >/dev/null
  log "Codex configured (mode=$CODEX_MODE in $CODEX_HOME)."
fi

# ---------------------------------------------------------------------------
# 4. OpenCode V2
# ---------------------------------------------------------------------------
if [[ "$INSTALL_OPENCODE" -eq 1 ]]; then
  log "Setting up OpenCode V2 plugin (agi)..."
  OC_PLUGINS_DIR="$OPENCODE_CONFIG_DIR/plugins"
  OC_TARGET="$OC_PLUGINS_DIR/agi"
  OC_SOURCE="$REPO_ROOT/opencode/plugins/agi"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ "$COPY_OPENCODE" -eq 1 ]]; then
      log "[dry-run] Copy $OC_SOURCE -> $OC_TARGET"
    else
      log "[dry-run] Symlink $OC_SOURCE -> $OC_TARGET"
    fi
  else
    mkdir -p "$OC_PLUGINS_DIR"
    if [[ -e "$OC_TARGET" && ! -L "$OC_TARGET" ]]; then
      if [[ -f "$OC_TARGET/package.json" ]] && grep -q '"agi"' "$OC_TARGET/package.json" 2>/dev/null; then
        rm -rf "$OC_TARGET"
      else
        die "Existing non-agi directory found at $OC_TARGET; remove or back it up first."
      fi
    fi
    if [[ "$COPY_OPENCODE" -eq 1 ]]; then
      rm -f "$OC_TARGET"
      cp -R "$OC_SOURCE" "$OC_TARGET"
    else
      ln -sfn "$OC_SOURCE" "$OC_TARGET"
    fi
  fi
  log "OpenCode V2 plugin linked at $OC_TARGET."
fi

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
cat <<EOF

[agi-install] Done!
  Safety model : Official \`agy acp\` stdio JSON-RPC only (no OAuth token scraping or Cloud Code HTTP proxying)
  ACP profile  : --gemini-dir ${AGY_GEMINI_DIR:-<default>} --app-data-dir ${AGY_APP_DATA_DIR:-antigravity-cli}
  Shared config: $AGI_HOME/acp.json

Next steps:
EOF

if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
  printf '  - Claude Code : Run `claude` and select `anthropic-agy/...` in `/model`\n'
  if [[ "$CLAUDE_AUTH_MODE" == "auto" ]]; then
    printf '                  (No Anthropic account? Re-run with `./install.sh --claude --local-token`)\n'
  fi
fi
if [[ "$INSTALL_CODEX" -eq 1 ]]; then
  if [[ "$CODEX_MODE" == "profile" ]]; then
    printf '  - Codex       : Run `codex -p agy` and switch models via `/model`\n'
  else
    printf '  - Codex       : Run `codex` and switch models via `/model`\n'
  fi
fi
if [[ "$INSTALL_OPENCODE" -eq 1 ]]; then
  printf '  - OpenCode V2 : Run `opencode models` or `/model` inside `opencode`\n'
fi
printf '  - Authenticate: `%s`\n' "${LOGIN_CMD[*]}"
