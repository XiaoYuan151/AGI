#!/usr/bin/env bash
set -euo pipefail

# AGI plugin installer, updater, and multi-account manager for
# Claude Code, Codex, OpenCode V2, and DeepSeek Harness.
# Uses T3 Code's Antigravity safety model:
#   1. Official unmodified `agy acp` subprocess over stdio JSON-RPC 2.0 only
#      (no OAuth token extraction, no Cloud Code HTTP proxying, no UA spoofing).
#   2. Isolated ACP profile via `--gemini-dir` + `--app-data-dir antigravity-acp`
#      so ACP sessions never collide with interactive `agy` CLI or Antigravity IDE.
#   3. Built-in auth/policy cooldowns to prevent ban-triggering retry loops.

ORIG_ARGS=("$@")

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
fi

AGI_HOME="${AGI_HOME:-$HOME/.agi}"
AGI_INSTALL_DIR="${AGI_INSTALL_DIR:-$AGI_HOME/repo}"
AGI_REPO_URL="${AGI_REPO_URL:-https://github.com/XiaoYuan151/AGI.git}"
AGI_REPO_REF="${AGI_REPO_REF:-main}"
AGY_BIN="${AGY_BIN:-agy}"
AGY_GEMINI_DIR="${AGY_GEMINI_DIR:-$AGI_HOME/antigravity}"
AGY_APP_DATA_DIR="${AGY_APP_DATA_DIR:-antigravity-acp}"
USE_DEFAULT_GEMINI_DIR=0

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_PROFILE=""

INSTALL_CLAUDE=0
INSTALL_CODEX=0
INSTALL_OPENCODE=0
INSTALL_DSH=0
FORCE_ALL=0
EXPLICIT_TARGETS=0
ASSUME_YES=0

CLAUDE_AUTH_MODE="auto"
CODEX_MODE="profile"
FORCE_LOGIN=0
SKIP_LOGIN=0
START_BRIDGE=1
COPY_OPENCODE=0
UPDATE=0
UPDATE_CHECK=0
UNINSTALL=0
PURGE=0
DRY_RUN=0

EXPLICIT_CLAUDE_AUTH_MODE=0
EXPLICIT_CODEX_MODE=0
EXPLICIT_DSH_PROFILE=0
EXPLICIT_COPY_OPENCODE=0
EXPLICIT_GEMINI_DIR=0
EXPLICIT_APP_DATA_DIR=0
EXPLICIT_PIN_GEMINI_DIR=0
EXPLICIT_SKIP_LOGIN=0

ACCOUNT_NAME=""
ACCOUNT_DATA_DIR=""
ACCOUNT_AUTH_METHOD=""
ACCOUNT_LABEL=""
ADD_ACCOUNT=""
USE_ACCOUNT=""
REMOVE_ACCOUNT=""
LIST_ACCOUNTS=0
NO_ACTIVATE=0
FORCE_ACCOUNT=0
ACCOUNT_SUBCOMMAND_MODE=0
ACCOUNT_SUBCOMMAND_ARGS=()

AGI_UPDATE_REEXECED="${AGI_UPDATE_REEXECED:-0}"

usage() {
  cat <<'EOF'
Usage: ./install.sh [command] [options]
   or: curl -fsSL https://raw.githubusercontent.com/XiaoYuan151/AGI/main/install.sh | bash -s -- [options]

Commands:
  install                       Install/configure plugins (default)
  update                        Update AGI checkout/plugins and restart bridges (keeps accounts & choices)
  account <cmd> [options]       Manage multi-account profiles (`list`, `add`, `use`, `login`, `logout`, `remove`)
  uninstall                     Remove plugin registrations and configs

Targets (interactive multi-select picker in TTY, or auto-detect with -y / non-TTY):
  -a, --agent <name>            Select target agent(s) (repeatable or comma-separated:
                                claude | codex | opencode | dsh | all)
  --all                         Configure all four harnesses
  --claude                      Configure Claude Code plugin + bridge
  --codex                       Configure Codex plugin + bridge
  --opencode                    Configure OpenCode V2 plugin (native /connect + /model)
  --dsh, --deepseek-harness     Configure DeepSeek Harness plugin (Cordis LlmAdapter + /agy-connect)
  -y, --yes, --no-interactive   Skip interactive agent picker and use saved/detected agents

Update & remote bootstrap:
  -u, --update                  Update repo checkout, refresh plugins & configs, restart bridges
  --check                       With --update, check for updates without modifying files
  --install-dir <dir>           Directory to clone/update the repo (default: ~/.agi/repo)
  --repo-url <url>              Git repository URL (default: https://github.com/XiaoYuan151/AGI.git)
  --ref <branch|tag>            Git branch or tag to install/update (default: main)

Multi-account & ACP isolation (T3 Code safe mode):
  --account <name>              Target or create a named account profile (default: active or 'default')
  --data-dir <dir>              Isolated data folder for the account (default: ~/.agi/accounts/<name>)
  --add-account <name>          Add an account into its own data folder (combine with --data-dir / --login)
  --use-account <name>          Switch active account and notify running bridges
  --list-accounts               List configured accounts and their data folders
  --remove-account <name>       Remove an account (add --purge to delete its data folder)
  --auth-method <id>            Default ACP auth method for this account (gemini-api-key | oauth-business | agent-platform)
  --label <text>                Optional display label when adding an account
  --no-activate                 With --add-account, do not switch active account
  --force                       Allow sharing a data folder already assigned to another account
  --gemini-dir <dir>            Isolated --gemini-dir for agy acp (default: ~/.agi/antigravity)
  --app-data-dir <name>         --app-data-dir for agy acp (default: antigravity-acp)
  --use-default-gemini-dir      Do not pass --gemini-dir (share ~/.gemini, keep antigravity-acp)
  --pin-gemini-dir              Pin AGY_GEMINI_DIR in Claude settings (disables dynamic account switching)
  --login                       Force interactive `agy acp ... --login`
  --skip-login                  Skip interactive login if unauthenticated

Harness options:
  --claude-auth-mode <mode>     auto (default) | preserve | local-token
  --local-token                 Shorthand for --claude-auth-mode local-token
  --codex-mode <mode>           profile (default: `codex -p agy`) | default (merge ~/.codex/config.toml)
  --dsh-profile <name>          Target DeepSeek Harness profile (default: all existing profiles or desktop)
  --no-start-bridge             Configure without starting background bridge daemons
  --copy                        Copy OpenCode plugin instead of symlinking

Lifecycle:
  --uninstall, --remove         Remove plugin registrations, configs, and stop bridges
  --purge                       With --uninstall or --remove-account, delete isolated state/data folder
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

select_agent_token() {
  local raw="$1"
  local item
  IFS=',' read -r -a items <<< "$raw"
  for item in "${items[@]}"; do
    local lower
    lower="$(printf '%s' "$item" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$lower" in
      claude|claude-code|claudecode)
        INSTALL_CLAUDE=1
        EXPLICIT_TARGETS=1
        ;;
      codex|openai-codex)
        INSTALL_CODEX=1
        EXPLICIT_TARGETS=1
        ;;
      opencode|opencode-v2)
        INSTALL_OPENCODE=1
        EXPLICIT_TARGETS=1
        ;;
      dsh|deepseek|deepseek-harness)
        INSTALL_DSH=1
        EXPLICIT_TARGETS=1
        ;;
      all)
        FORCE_ALL=1
        EXPLICIT_TARGETS=1
        ;;
      "") ;;
      *)
        die "Unknown agent '$item' (expected: claude, codex, opencode, dsh, all)"
        ;;
    esac
  done
}

# Handle optional subcommand at $1
if [[ $# -gt 0 ]]; then
  case "$1" in
    install|setup)
      shift
      ;;
    update|upgrade)
      UPDATE=1
      shift
      ;;
    uninstall|remove)
      UNINSTALL=1
      shift
      ;;
    account|accounts)
      shift
      ACCOUNT_SUBCOMMAND_MODE=1
      ACCOUNT_SUBCOMMAND_ARGS=("$@")
      set --
      ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--update)
      UPDATE=1
      ;;
    --check)
      UPDATE_CHECK=1
      ;;
    --all)
      FORCE_ALL=1
      EXPLICIT_TARGETS=1
      ;;
    -a|--agent)
      [[ $# -ge 2 ]] || die "$1 requires an agent name (claude|codex|opencode|dsh|all)"
      select_agent_token "$2"
      shift
      ;;
    --claude)
      INSTALL_CLAUDE=1
      EXPLICIT_TARGETS=1
      ;;
    --codex)
      INSTALL_CODEX=1
      EXPLICIT_TARGETS=1
      ;;
    --opencode)
      INSTALL_OPENCODE=1
      EXPLICIT_TARGETS=1
      ;;
    --dsh|--deepseek-harness)
      INSTALL_DSH=1
      EXPLICIT_TARGETS=1
      ;;
    --dsh-profile)
      [[ $# -ge 2 ]] || die "--dsh-profile requires a profile name"
      DSH_PROFILE="$2"
      EXPLICIT_DSH_PROFILE=1
      shift
      ;;
    -y|--yes|--no-interactive)
      ASSUME_YES=1
      ;;
    --install-dir)
      [[ $# -ge 2 ]] || die "--install-dir requires a path"
      AGI_INSTALL_DIR="$2"
      shift
      ;;
    --repo-url)
      [[ $# -ge 2 ]] || die "--repo-url requires a URL"
      AGI_REPO_URL="$2"
      shift
      ;;
    --ref)
      [[ $# -ge 2 ]] || die "--ref requires a branch or tag"
      AGI_REPO_REF="$2"
      shift
      ;;
    --account)
      [[ $# -ge 2 ]] || die "--account requires an account name"
      ACCOUNT_NAME="$2"
      shift
      ;;
    --data-dir)
      [[ $# -ge 2 ]] || die "--data-dir requires a path"
      ACCOUNT_DATA_DIR="$2"
      AGY_GEMINI_DIR="$2"
      EXPLICIT_GEMINI_DIR=1
      shift
      ;;
    --auth-method)
      [[ $# -ge 2 ]] || die "--auth-method requires a method ID"
      ACCOUNT_AUTH_METHOD="$2"
      shift
      ;;
    --label)
      [[ $# -ge 2 ]] || die "--label requires a value"
      ACCOUNT_LABEL="$2"
      shift
      ;;
    --add-account)
      [[ $# -ge 2 ]] || die "--add-account requires an account name"
      ADD_ACCOUNT="$2"
      shift
      ;;
    --use-account|--switch-account)
      [[ $# -ge 2 ]] || die "$1 requires an account name"
      USE_ACCOUNT="$2"
      shift
      ;;
    --list-accounts)
      LIST_ACCOUNTS=1
      ;;
    --remove-account)
      [[ $# -ge 2 ]] || die "--remove-account requires an account name"
      REMOVE_ACCOUNT="$2"
      shift
      ;;
    --no-activate)
      NO_ACTIVATE=1
      ;;
    --force)
      FORCE_ACCOUNT=1
      ;;
    --gemini-dir)
      [[ $# -ge 2 ]] || die "--gemini-dir requires a path"
      AGY_GEMINI_DIR="$2"
      EXPLICIT_GEMINI_DIR=1
      shift
      ;;
    --app-data-dir)
      [[ $# -ge 2 ]] || die "--app-data-dir requires a value"
      AGY_APP_DATA_DIR="$2"
      EXPLICIT_APP_DATA_DIR=1
      shift
      ;;
    --use-default-gemini-dir)
      USE_DEFAULT_GEMINI_DIR=1
      EXPLICIT_GEMINI_DIR=1
      ;;
    --pin-gemini-dir)
      EXPLICIT_PIN_GEMINI_DIR=1
      ;;
    --claude-auth-mode)
      [[ $# -ge 2 ]] || die "--claude-auth-mode requires auto|preserve|local-token"
      CLAUDE_AUTH_MODE="$2"
      EXPLICIT_CLAUDE_AUTH_MODE=1
      shift
      ;;
    --local-token)
      CLAUDE_AUTH_MODE="local-token"
      EXPLICIT_CLAUDE_AUTH_MODE=1
      ;;
    --codex-mode)
      [[ $# -ge 2 ]] || die "--codex-mode requires profile|default"
      CODEX_MODE="$2"
      EXPLICIT_CODEX_MODE=1
      shift
      ;;
    --login) FORCE_LOGIN=1 ;;
    --skip-login)
      SKIP_LOGIN=1
      EXPLICIT_SKIP_LOGIN=1
      ;;
    --no-start-bridge) START_BRIDGE=0 ;;
    --copy)
      COPY_OPENCODE=1
      EXPLICIT_COPY_OPENCODE=1
      ;;
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

command -v node >/dev/null 2>&1 || die "Node.js (18+) is required."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  die "Node.js 18+ is required (found $(node -v))."
fi

is_agi_repo() {
  local dir="$1"
  [[ -n "$dir" \
    && -f "$dir/claude-code/plugins/agi/.claude-plugin/plugin.json" \
    && -f "$dir/codex/plugins/agi/plugin.json" \
    && -f "$dir/opencode/plugins/agi/package.json" \
    && -f "$dir/deepseek-harness/plugins/agi/package.json" ]]
}

download_github_tarball() {
  local dest="$1"
  local clean_repo="${AGI_REPO_URL%.git}"
  local tarball_url=""
  if [[ "$clean_repo" =~ ^https://github\.com/([^/]+/[^/]+)$ ]]; then
    tarball_url="https://codeload.github.com/${BASH_REMATCH[1]}/tar.gz/${AGI_REPO_REF}"
  else
    die "git is required to clone non-GitHub URL: $AGI_REPO_URL"
  fi
  log "Downloading $tarball_url into $dest..."
  local tmp_archive
  tmp_archive="$(mktemp -d)"
  curl -fsSL "$tarball_url" | tar -xz -C "$tmp_archive" --strip-components=1
  rm -rf "$dest"
  mv "$tmp_archive" "$dest"
}

resolve_repo_root() {
  if is_agi_repo "$SCRIPT_DIR"; then
    REPO_ROOT="$SCRIPT_DIR"
    return 0
  fi
  if is_agi_repo "$PWD"; then
    REPO_ROOT="$PWD"
    return 0
  fi

  REPO_ROOT="$AGI_INSTALL_DIR"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    if is_agi_repo "$REPO_ROOT"; then
      log "[dry-run] Would use/update existing checkout at $REPO_ROOT"
      return 0
    fi
    log "[dry-run] Would download $AGI_REPO_URL ($AGI_REPO_REF) into $REPO_ROOT"
    exit 0
  fi

  mkdir -p "$(dirname "$REPO_ROOT")"
  if [[ "$UPDATE" -eq 0 && -d "$REPO_ROOT/.git" ]] && command -v git >/dev/null 2>&1; then
    log "Updating AGI checkout at $REPO_ROOT ($AGI_REPO_REF)..."
    if ! git -C "$REPO_ROOT" fetch --depth 1 origin "$AGI_REPO_REF" </dev/null >/dev/null 2>&1 || \
       ! git -C "$REPO_ROOT" checkout -B "$AGI_REPO_REF" FETCH_HEAD </dev/null >/dev/null 2>&1; then
      warn "Could not update $REPO_ROOT from remote; continuing with existing files."
    fi
  elif ! is_agi_repo "$REPO_ROOT"; then
    if command -v git >/dev/null 2>&1; then
      log "Cloning $AGI_REPO_URL ($AGI_REPO_REF) into $REPO_ROOT..."
      rm -rf "$REPO_ROOT"
      git clone --depth 1 --branch "$AGI_REPO_REF" "$AGI_REPO_URL" "$REPO_ROOT" </dev/null >/dev/null
    elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
      download_github_tarball "$REPO_ROOT"
    else
      die "git (or curl + tar) is required when running install.sh outside a cloned repo."
    fi
  fi

  is_agi_repo "$REPO_ROOT" || die "Downloaded repository at $REPO_ROOT is missing expected plugin files."
}

resolve_repo_root

export AGI_HOME
export AGY_BIN
export AGY_GEMINI_DIR
export AGY_APP_DATA_DIR
export AGY_ACP_CONFIG="$AGI_HOME/acp.json"
export CLAUDE_CONFIG_DIR
export CODEX_HOME
export DSH_HOME

# ---------------------------------------------------------------------------
# Multi-account subcommands & standalone flags
# ---------------------------------------------------------------------------
if [[ "$ACCOUNT_SUBCOMMAND_MODE" -eq 1 ]]; then
  exec node "$REPO_ROOT/scripts/accounts.mjs" "${ACCOUNT_SUBCOMMAND_ARGS[@]}"
fi

if [[ "$LIST_ACCOUNTS" -eq 1 ]]; then
  node "$REPO_ROOT/scripts/accounts.mjs" list
  exit 0
fi

if [[ -n "$ADD_ACCOUNT" ]]; then
  ADD_ARGS=("add" "$ADD_ACCOUNT")
  if [[ -n "$ACCOUNT_DATA_DIR" ]]; then
    ADD_ARGS+=("--data-dir" "$ACCOUNT_DATA_DIR")
  elif [[ "$EXPLICIT_GEMINI_DIR" -eq 1 && -n "$AGY_GEMINI_DIR" ]]; then
    ADD_ARGS+=("--data-dir" "$AGY_GEMINI_DIR")
  fi
  if [[ "$EXPLICIT_APP_DATA_DIR" -eq 1 ]]; then
    ADD_ARGS+=("--app-data-dir" "$AGY_APP_DATA_DIR")
  fi
  if [[ -n "$ACCOUNT_AUTH_METHOD" ]]; then
    ADD_ARGS+=("--auth-method" "$ACCOUNT_AUTH_METHOD")
  fi
  if [[ -n "$ACCOUNT_LABEL" ]]; then
    ADD_ARGS+=("--label" "$ACCOUNT_LABEL")
  fi
  if [[ "$NO_ACTIVATE" -eq 1 ]]; then
    ADD_ARGS+=("--no-activate")
  fi
  if [[ "$FORCE_ACCOUNT" -eq 1 ]]; then
    ADD_ARGS+=("--force")
  fi
  if [[ "$FORCE_LOGIN" -eq 1 ]]; then
    ADD_ARGS+=("--login")
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    ADD_ARGS+=("--dry-run")
  fi
  node "$REPO_ROOT/scripts/accounts.mjs" "${ADD_ARGS[@]}"
  exit 0
fi

if [[ -n "$USE_ACCOUNT" ]]; then
  USE_ARGS=("use" "$USE_ACCOUNT")
  if [[ "$DRY_RUN" -eq 1 ]]; then
    USE_ARGS+=("--dry-run")
  fi
  node "$REPO_ROOT/scripts/accounts.mjs" "${USE_ARGS[@]}"
  exit 0
fi

if [[ -n "$REMOVE_ACCOUNT" ]]; then
  RM_ARGS=("remove" "$REMOVE_ACCOUNT")
  if [[ "$PURGE" -eq 1 ]]; then
    RM_ARGS+=("--purge")
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    RM_ARGS+=("--dry-run")
  fi
  node "$REPO_ROOT/scripts/accounts.mjs" "${RM_ARGS[@]}"
  exit 0
fi

# ---------------------------------------------------------------------------
# Update checkout before configuring harnesses when --update is requested
# ---------------------------------------------------------------------------
update_repo_checkout() {
  local abs_repo abs_managed
  abs_repo="$(cd "$REPO_ROOT" && pwd -P)"
  abs_managed=""
  if [[ -d "$AGI_INSTALL_DIR" ]]; then
    abs_managed="$(cd "$AGI_INSTALL_DIR" && pwd -P)"
  fi

  if [[ "$UPDATE_CHECK" -eq 1 ]]; then
    local local_rev="" remote_rev="" installed_ver="" pkg_ver=""
    if [[ -f "$AGI_HOME/install.json" ]]; then
      installed_ver="$(node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.version||"");}catch{}' "$AGI_HOME/install.json")"
    fi
    if [[ -f "$REPO_ROOT/package.json" ]]; then
      pkg_ver="$(node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(d.version||"");}catch{}' "$REPO_ROOT/package.json")"
    fi
    if [[ -d "$REPO_ROOT/.git" ]] && command -v git >/dev/null 2>&1; then
      local_rev="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
      remote_rev="$(git -C "$REPO_ROOT" ls-remote origin "$AGI_REPO_REF" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
    fi
    log "Update check ($REPO_ROOT):"
    log "  Installed version : ${installed_ver:-unknown}"
    log "  Checkout version  : ${pkg_ver:-unknown}"
    if [[ -n "$local_rev" ]]; then
      log "  Local commit      : ${local_rev:0:8}"
    fi
    if [[ -n "$remote_rev" ]]; then
      log "  Remote commit     : ${remote_rev:0:8}"
      if [[ "$local_rev" == "$remote_rev" ]]; then
        log "  Status            : up to date"
      else
        log "  Status            : update available"
      fi
    fi
    exit 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Would update AGI checkout at $REPO_ROOT (ref: $AGI_REPO_REF)"
    return 0
  fi

  if [[ -d "$REPO_ROOT/.git" ]] && command -v git >/dev/null 2>&1; then
    local old_rev new_rev
    old_rev="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
    if [[ -n "$abs_managed" && "$abs_repo" == "$abs_managed" ]]; then
      log "Updating managed AGI checkout at $REPO_ROOT ($AGI_REPO_REF)..."
      if git -C "$REPO_ROOT" fetch --depth 1 origin "$AGI_REPO_REF" </dev/null >/dev/null 2>&1 && \
         git -C "$REPO_ROOT" checkout -B "$AGI_REPO_REF" FETCH_HEAD </dev/null >/dev/null 2>&1; then
        new_rev="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
      else
        warn "Could not fetch remote updates for $REPO_ROOT; continuing with existing files."
        new_rev="$old_rev"
      fi
    else
      if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
        warn "Local checkout at $REPO_ROOT has uncommitted changes; skipping git pull and refreshing from current working tree."
        new_rev="$old_rev"
      else
        log "Pulling latest updates in $REPO_ROOT ($AGI_REPO_REF)..."
        if git -C "$REPO_ROOT" fetch origin "$AGI_REPO_REF" </dev/null >/dev/null 2>&1 && \
           git -C "$REPO_ROOT" merge --ff-only FETCH_HEAD </dev/null >/dev/null 2>&1; then
          new_rev="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
        else
          warn "Could not fast-forward $REPO_ROOT from remote; continuing with existing files."
          new_rev="$old_rev"
        fi
      fi
    fi

    if [[ -n "$old_rev" && -n "$new_rev" && "$old_rev" != "$new_rev" ]]; then
      log "Updated AGI checkout: ${old_rev:0:8} -> ${new_rev:0:8}"
      if [[ "$AGI_UPDATE_REEXECED" != "1" && -f "$REPO_ROOT/install.sh" ]]; then
        export AGI_UPDATE_REEXECED=1
        if [[ ${#ORIG_ARGS[@]} -gt 0 ]]; then
          exec bash "$REPO_ROOT/install.sh" "${ORIG_ARGS[@]}"
        else
          exec bash "$REPO_ROOT/install.sh"
        fi
      fi
    else
      log "AGI source at $REPO_ROOT is up to date (${new_rev:0:8})."
    fi
  elif [[ -n "$abs_managed" && "$abs_repo" == "$abs_managed" ]] && command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    download_github_tarball "$REPO_ROOT"
    is_agi_repo "$REPO_ROOT" || die "Updated archive at $REPO_ROOT is missing expected plugin files."
    if [[ "$AGI_UPDATE_REEXECED" != "1" && -f "$REPO_ROOT/install.sh" ]]; then
      export AGI_UPDATE_REEXECED=1
      if [[ ${#ORIG_ARGS[@]} -gt 0 ]]; then
        exec bash "$REPO_ROOT/install.sh" "${ORIG_ARGS[@]}"
      else
        exec bash "$REPO_ROOT/install.sh"
      fi
    fi
  fi
}

SAVED_AGENTS_CSV=""
load_saved_install_state() {
  local state_file="$AGI_HOME/install.json"
  [[ -f "$state_file" ]] || return 0
  local parsed
  parsed="$(node -e '
    const fs = require("node:fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const opts = s.options || {};
      const row = [
        Array.isArray(s.agents) ? s.agents.join(",") : "",
        opts.claudeAuthMode || "",
        opts.codexMode || "",
        opts.dshProfile || "",
        opts.copyOpencode ? "1" : "0",
      ];
      console.log(row.join("\t"));
    } catch {}
  ' "$state_file" 2>/dev/null || true)"
  [[ -n "$parsed" ]] || return 0

  local s_agents s_claude s_codex s_dsh s_copy
  IFS=$'\t' read -r s_agents s_claude s_codex s_dsh s_copy <<< "$parsed"
  SAVED_AGENTS_CSV="$s_agents"
  if [[ "$EXPLICIT_CLAUDE_AUTH_MODE" -eq 0 && -n "$s_claude" ]]; then
    CLAUDE_AUTH_MODE="$s_claude"
  fi
  if [[ "$EXPLICIT_CODEX_MODE" -eq 0 && -n "$s_codex" ]]; then
    CODEX_MODE="$s_codex"
  fi
  if [[ "$EXPLICIT_DSH_PROFILE" -eq 0 && -n "$s_dsh" ]]; then
    DSH_PROFILE="$s_dsh"
  fi
  if [[ "$EXPLICIT_COPY_OPENCODE" -eq 0 && "$s_copy" == "1" ]]; then
    COPY_OPENCODE=1
  fi
}

if [[ "$UPDATE" -eq 1 ]]; then
  update_repo_checkout
  load_saved_install_state
  if [[ "$FORCE_LOGIN" -eq 0 && "$EXPLICIT_SKIP_LOGIN" -eq 0 ]]; then
    SKIP_LOGIN=1
  fi
fi

detect_agents_csv() {
  local detected=()
  if command -v claude >/dev/null 2>&1 || [[ -d "$CLAUDE_CONFIG_DIR" ]]; then
    detected+=("claude")
  fi
  if command -v codex >/dev/null 2>&1 || [[ -d "$CODEX_HOME" ]]; then
    detected+=("codex")
  fi
  if command -v opencode >/dev/null 2>&1 || [[ -d "$OPENCODE_CONFIG_DIR" ]]; then
    detected+=("opencode")
  fi
  if command -v dsh >/dev/null 2>&1 || [[ -d "$DSH_HOME" ]] || [[ -d "/Applications/DeepSeek Harness.app" ]]; then
    detected+=("dsh")
  fi
  local IFS=","
  printf '%s' "${detected[*]}"
}

resolve_target_agents() {
  if [[ "$FORCE_ALL" -eq 1 ]]; then
    INSTALL_CLAUDE=1
    INSTALL_CODEX=1
    INSTALL_OPENCODE=1
    INSTALL_DSH=1
    return 0
  fi

  if [[ "$EXPLICIT_TARGETS" -eq 1 ]]; then
    return 0
  fi

  if [[ "$UPDATE" -eq 1 && -n "$SAVED_AGENTS_CSV" && ( "$ASSUME_YES" -eq 1 || "$DRY_RUN" -eq 1 ) ]]; then
    select_agent_token "$SAVED_AGENTS_CSV"
    return 0
  fi

  local detected_csv
  detected_csv="$(detect_agents_csv)"
  local picker_seed="$detected_csv"
  if [[ "$UPDATE" -eq 1 && -n "$SAVED_AGENTS_CSV" ]]; then
    picker_seed="$SAVED_AGENTS_CSV"
  fi

  if [[ "$ASSUME_YES" -eq 0 && "$DRY_RUN" -eq 0 && -f "$REPO_ROOT/scripts/select-agents.mjs" ]]; then
    if [[ -t 1 && -r /dev/tty && -w /dev/tty ]]; then
      local action_name="install"
      if [[ "$UNINSTALL" -eq 1 ]]; then
        action_name="uninstall"
      elif [[ "$UPDATE" -eq 1 ]]; then
        action_name="update"
      fi
      local selected_csv=""
      local picker_rc=0
      selected_csv="$(node "$REPO_ROOT/scripts/select-agents.mjs" --action "$action_name" --detected "$picker_seed")" || picker_rc=$?
      if [[ "$picker_rc" -eq 130 ]]; then
        log "Cancelled by user."
        exit 130
      elif [[ "$picker_rc" -eq 0 && -n "$selected_csv" ]]; then
        select_agent_token "$selected_csv"
        return 0
      fi
    fi
  fi

  if [[ -n "$picker_seed" ]]; then
    select_agent_token "$picker_seed"
  else
    INSTALL_CLAUDE=1
    INSTALL_CODEX=1
    INSTALL_OPENCODE=1
    INSTALL_DSH=1
  fi
}

resolve_target_agents

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

  if [[ "$INSTALL_DSH" -eq 1 ]]; then
    log "Removing DeepSeek Harness configuration..."
    local dsh_rm_args=(
      "$REPO_ROOT/deepseek-harness/plugins/agi/scripts/setup-dsh.mjs"
      "--dsh-home" "$DSH_HOME"
      "--remove"
    )
    if [[ -n "$DSH_PROFILE" ]]; then
      dsh_rm_args+=("--profile" "$DSH_PROFILE")
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
      dsh_rm_args+=("--dry-run")
    fi
    node "${dsh_rm_args[@]}" >/dev/null
  fi

  if [[ -f "$AGI_HOME/acp.json" ]]; then
    run_cmd rm -f "$AGI_HOME/acp.json"
  fi
  if [[ -f "$AGI_HOME/install.json" ]]; then
    run_cmd rm -f "$AGI_HOME/install.json"
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
# 1. Verify official `agy` CLI & set up multi-account isolated ACP profile
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

HAS_EXPLICIT_ACCOUNT_ARGS=0
if [[ -n "$ACCOUNT_NAME" || -n "$ACCOUNT_DATA_DIR" || "$EXPLICIT_GEMINI_DIR" -eq 1 || "$EXPLICIT_APP_DATA_DIR" -eq 1 || "$USE_DEFAULT_GEMINI_DIR" -eq 1 ]]; then
  HAS_EXPLICIT_ACCOUNT_ARGS=1
fi

ACTIVE_ACCOUNT_NAME=""
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Configuring T3 Code-style isolated ACP profile:"
  if [[ -n "$AGY_GEMINI_DIR" ]]; then
    log "  --gemini-dir   : $AGY_GEMINI_DIR"
  else
    log "  --gemini-dir   : (default ~/.gemini)"
  fi
  log "  --app-data-dir : ${AGY_APP_DATA_DIR:-antigravity-cli}"
  log "[dry-run] Would write/update $AGI_HOME/acp.json (chmod 700 on $AGI_HOME)"
else
  mkdir -p "$AGI_HOME"
  chmod 700 "$AGI_HOME"

  if [[ "$UPDATE" -eq 1 && "$HAS_EXPLICIT_ACCOUNT_ARGS" -eq 0 && -f "$AGI_HOME/acp.json" ]]; then
    # Preserve existing multi-account configuration on update
    RESOLVED_PROFILE_JSON="$(cd "$REPO_ROOT" && node -e '
      import("./claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs").then(({ readPersistedAcpConfig, resolveAccountProfile }) => {
        const cfg = readPersistedAcpConfig(process.env);
        const prof = resolveAccountProfile({ env: process.env, usePersistedConfig: true });
        console.log(JSON.stringify({
          activeAccount: cfg.activeAccount || "",
          geminiDir: prof.geminiDir || "",
          appDataDir: prof.appDataDir || "",
        }));
      });
    ')"
    ACTIVE_ACCOUNT_NAME="$(node -e 'console.log(JSON.parse(process.argv[1]).activeAccount || "")' "$RESOLVED_PROFILE_JSON")"
    AGY_GEMINI_DIR="$(node -e 'console.log(JSON.parse(process.argv[1]).geminiDir || "")' "$RESOLVED_PROFILE_JSON")"
    AGY_APP_DATA_DIR="$(node -e 'console.log(JSON.parse(process.argv[1]).appDataDir || "")' "$RESOLVED_PROFILE_JSON")"
  else
    UPSERT_TARGET_NAME="${ACCOUNT_NAME:-}"
    UPSERT_JSON="$(cd "$REPO_ROOT" && node -e '
      import("./claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs").then(({ readPersistedAcpConfig, upsertPersistedAccount }) => {
        const prev = readPersistedAcpConfig(process.env);
        const targetName = process.argv[1] || prev.activeAccount || "default";
        const useDefaultDir = process.argv[2] === "1";
        const explicitDir = process.argv[3];
        const explicitAppData = process.argv[4];
        const explicitMethod = process.argv[5];
        const explicitLabel = process.argv[6];
        const force = process.argv[7] === "1";
        const res = upsertPersistedAccount({
          name: targetName,
          ...(explicitDir ? { dataDir: explicitDir } : {}),
          ...(explicitAppData !== "__UNSET__" ? { appDataDir: explicitAppData } : {}),
          ...(explicitMethod ? { authMethod: explicitMethod } : {}),
          ...(explicitLabel ? { label: explicitLabel } : {}),
          useDefaultGeminiDir: useDefaultDir,
          activate: true,
          force,
        }, process.env);
        console.log(JSON.stringify({
          activeAccount: res.activeAccount,
          geminiDir: res.account.geminiDir,
          appDataDir: res.account.appDataDir,
        }));
      });
    ' \
      "$UPSERT_TARGET_NAME" \
      "$USE_DEFAULT_GEMINI_DIR" \
      "${ACCOUNT_DATA_DIR:-$([[ "$EXPLICIT_GEMINI_DIR" -eq 1 ]] && echo "$AGY_GEMINI_DIR" || echo "")}" \
      "$([[ "$EXPLICIT_APP_DATA_DIR" -eq 1 ]] && echo "$AGY_APP_DATA_DIR" || echo "__UNSET__")" \
      "$ACCOUNT_AUTH_METHOD" \
      "$ACCOUNT_LABEL" \
      "$FORCE_ACCOUNT")"
    ACTIVE_ACCOUNT_NAME="$(node -e 'console.log(JSON.parse(process.argv[1]).activeAccount || "")' "$UPSERT_JSON")"
    AGY_GEMINI_DIR="$(node -e 'console.log(JSON.parse(process.argv[1]).geminiDir || "")' "$UPSERT_JSON")"
    AGY_APP_DATA_DIR="$(node -e 'console.log(JSON.parse(process.argv[1]).appDataDir || "")' "$UPSERT_JSON")"
  fi

  log "Configuring T3 Code-style isolated ACP profile:"
  if [[ -n "$ACTIVE_ACCOUNT_NAME" ]]; then
    log "  account        : $ACTIVE_ACCOUNT_NAME"
  fi
  if [[ -n "$AGY_GEMINI_DIR" ]]; then
    log "  --gemini-dir   : $AGY_GEMINI_DIR"
  else
    log "  --gemini-dir   : (default ~/.gemini)"
  fi
  log "  --app-data-dir : ${AGY_APP_DATA_DIR:-antigravity-cli}"
fi

probe_acp_auth() {
  node -e '
    import("./claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs").then(async ({ AgyAcpClient }) => {
      const client = new AgyAcpClient({
        agyBin: process.env.AGY_BIN || "agy",
        geminiDir: process.env.AGY_GEMINI_DIR || "",
        appDataDir: process.env.AGY_APP_DATA_DIR || "",
        usePersistedConfig: false,
        rpcTimeoutMs: 15000,
      });
      try {
        const res = await client.discoverModels({ forceRefresh: true, timeoutMs: 15000 });
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
  AUTH_JSON="$(cd "$REPO_ROOT" && AGY_GEMINI_DIR="$AGY_GEMINI_DIR" AGY_APP_DATA_DIR="$AGY_APP_DATA_DIR" probe_acp_auth)"
  IS_AUTH="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.authenticated === true ? "1" : "0");' "$AUTH_JSON")"
  MODELS_CNT="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.modelsCount || 0);' "$AUTH_JSON")"

  if [[ "$FORCE_LOGIN" -eq 1 || ( "$IS_AUTH" -ne 1 && -z "${GEMINI_API_KEY:-}" && "$SKIP_LOGIN" -eq 0 ) ]]; then
    if [[ -t 0 ]]; then
      log "Running official interactive ACP sign-in: ${LOGIN_CMD[*]}"
      "${LOGIN_CMD[@]}" || warn "Interactive login did not complete; fallback models will still be registered."
      AUTH_JSON="$(cd "$REPO_ROOT" && AGY_GEMINI_DIR="$AGY_GEMINI_DIR" AGY_APP_DATA_DIR="$AGY_APP_DATA_DIR" probe_acp_auth)"
      IS_AUTH="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.authenticated === true ? "1" : "0");' "$AUTH_JSON")"
      MODELS_CNT="$(node -e 'const d = JSON.parse(process.argv[1]); console.log(d.modelsCount || 0);' "$AUTH_JSON")"
    elif [[ -t 1 && -r /dev/tty && -w /dev/tty ]]; then
      log "Running official interactive ACP sign-in via /dev/tty: ${LOGIN_CMD[*]}"
      "${LOGIN_CMD[@]}" </dev/tty || warn "Interactive login did not complete; fallback models will still be registered."
      AUTH_JSON="$(cd "$REPO_ROOT" && AGY_GEMINI_DIR="$AGY_GEMINI_DIR" AGY_APP_DATA_DIR="$AGY_APP_DATA_DIR" probe_acp_auth)"
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

# Stop any already-running bridges so they reload updated scripts and ACP profile.
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
      if [[ "$UPDATE" -eq 1 ]]; then
        log "[dry-run] claude plugin update agi@local-agi --scope user"
      else
        log "[dry-run] claude plugin install agi@local-agi --scope user"
      fi
    else
      if claude plugin marketplace list </dev/null 2>/dev/null | grep -q "local-agi"; then
        claude plugin marketplace update local-agi </dev/null >/dev/null 2>&1 || true
      else
        claude plugin marketplace add "$REPO_ROOT/claude-code" </dev/null >/dev/null 2>&1 || true
      fi
      if [[ "$UPDATE" -eq 1 ]]; then
        claude plugin update "agi@local-agi" --scope user </dev/null >/dev/null 2>&1 || \
          claude plugin install "agi@local-agi" --scope user </dev/null >/dev/null 2>&1 || \
          warn "Could not update via 'claude plugin update'; load directly with: claude --plugin-dir \"$REPO_ROOT/claude-code/plugins/agi\""
      else
        claude plugin install "agi@local-agi" --scope user </dev/null >/dev/null 2>&1 || \
          warn "Could not install via 'claude plugin install'; load directly with: claude --plugin-dir \"$REPO_ROOT/claude-code/plugins/agi\""
      fi
    fi
  else
    warn "'claude' CLI not found; configuring $CLAUDE_CONFIG_DIR/settings.json only."
  fi

  CLAUDE_SETUP_ARGS=(
    "$REPO_ROOT/claude-code/plugins/agi/scripts/setup-claude.mjs"
    "--scope" "user"
    "--auth-mode" "$CLAUDE_AUTH_MODE"
  )
  DEFAULT_AGI_HOME="$HOME/.agi"
  if [[ "$AGI_HOME" != "$DEFAULT_AGI_HOME" ]]; then
    CLAUDE_SETUP_ARGS+=("--acp-config" "$AGI_HOME/acp.json")
  fi
  if [[ "$EXPLICIT_PIN_GEMINI_DIR" -eq 1 ]]; then
    if [[ -n "$AGY_GEMINI_DIR" ]]; then
      CLAUDE_SETUP_ARGS+=("--gemini-dir" "$AGY_GEMINI_DIR")
    fi
    if [[ -n "$AGY_APP_DATA_DIR" ]]; then
      CLAUDE_SETUP_ARGS+=("--app-data-dir" "$AGY_APP_DATA_DIR")
    fi
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
      rm -rf "$OC_TARGET"
      cp -R "$OC_SOURCE" "$OC_TARGET"
    else
      ln -sfn "$OC_SOURCE" "$OC_TARGET"
    fi
  fi
  log "OpenCode V2 plugin linked at $OC_TARGET."
fi

# ---------------------------------------------------------------------------
# 5. DeepSeek Harness (dsh)
# ---------------------------------------------------------------------------
if [[ "$INSTALL_DSH" -eq 1 ]]; then
  log "Setting up DeepSeek Harness plugin (@local/dsh-agi)..."
  DSH_SETUP_ARGS=(
    "$REPO_ROOT/deepseek-harness/plugins/agi/scripts/setup-dsh.mjs"
    "--dsh-home" "$DSH_HOME"
  )
  if [[ -n "$DSH_PROFILE" ]]; then
    DSH_SETUP_ARGS+=("--profile" "$DSH_PROFILE")
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    DSH_SETUP_ARGS+=("--dry-run")
  fi
  node "${DSH_SETUP_ARGS[@]}" >/dev/null
  log "DeepSeek Harness configured in $DSH_HOME/profiles (${DSH_PROFILE:-auto-detected profiles})."
fi

# ---------------------------------------------------------------------------
# 6. Persist install state (used by --update and `agi status`)
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" -eq 0 ]]; then
  SELECTED_AGENTS=()
  [[ "$INSTALL_CLAUDE" -eq 1 ]] && SELECTED_AGENTS+=("claude")
  [[ "$INSTALL_CODEX" -eq 1 ]] && SELECTED_AGENTS+=("codex")
  [[ "$INSTALL_OPENCODE" -eq 1 ]] && SELECTED_AGENTS+=("opencode")
  [[ "$INSTALL_DSH" -eq 1 ]] && SELECTED_AGENTS+=("dsh")
  AGENTS_CSV_FINAL="$(IFS=,; echo "${SELECTED_AGENTS[*]}")"
  GIT_COMMIT_NOW=""
  if [[ -d "$REPO_ROOT/.git" ]] && command -v git >/dev/null 2>&1; then
    GIT_COMMIT_NOW="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  fi

  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const statePath = process.argv[1];
    const repoRoot = process.argv[2];
    const repoUrl = process.argv[3];
    const repoRef = process.argv[4];
    const gitCommit = process.argv[5] || null;
    const agentsCsv = process.argv[6];
    const claudeAuthMode = process.argv[7];
    const codexMode = process.argv[8];
    const dshProfile = process.argv[9];
    const copyOpencode = process.argv[10] === "1";

    let prev = {};
    try {
      if (fs.existsSync(statePath)) prev = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {}
    let pkgMeta = { name: "@xiaoyuan151/agi", version: "0.3.0" };
    try {
      const p = path.join(repoRoot, "package.json");
      if (fs.existsSync(p)) pkgMeta = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {}

    const now = new Date().toISOString();
    const next = {
      packageName: pkgMeta.name || "@xiaoyuan151/agi",
      version: pkgMeta.version || "0.3.0",
      installMethod: prev.installMethod || (gitCommit ? "git" : "local"),
      repoRoot,
      repoUrl,
      repoRef,
      gitCommit,
      agents: agentsCsv ? agentsCsv.split(",").filter(Boolean) : [],
      options: {
        claudeAuthMode,
        codexMode,
        dshProfile,
        copyOpencode,
      },
      installedAt: prev.installedAt || now,
      updatedAt: now,
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  ' \
    "$AGI_HOME/install.json" \
    "$REPO_ROOT" \
    "$AGI_REPO_URL" \
    "$AGI_REPO_REF" \
    "$GIT_COMMIT_NOW" \
    "$AGENTS_CSV_FINAL" \
    "$CLAUDE_AUTH_MODE" \
    "$CODEX_MODE" \
    "$DSH_PROFILE" \
    "$COPY_OPENCODE"
fi

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
cat <<EOF

[agi-install] Done!
  Safety model : Official \`agy acp\` stdio JSON-RPC only (no OAuth token scraping or Cloud Code HTTP proxying)
  Active acct  : ${ACTIVE_ACCOUNT_NAME:-default}
  ACP profile  : --gemini-dir ${AGY_GEMINI_DIR:-<default>} --app-data-dir ${AGY_APP_DATA_DIR:-antigravity-cli}
  Shared config: $AGI_HOME/acp.json

Next steps:
EOF

if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
  printf '  - Claude Code      : Run `claude`, sign in with `/agi:connect`, and pick `anthropic-agy/...` in `/model`\n'
  if [[ "$CLAUDE_AUTH_MODE" == "auto" ]]; then
    printf '                       (No Anthropic account? Re-run with `./install.sh --claude --local-token`)\n'
  fi
fi
if [[ "$INSTALL_CODEX" -eq 1 ]]; then
  if [[ "$CODEX_MODE" == "profile" ]]; then
    printf '  - Codex            : Run `codex -p agy`, sign in with `$agy-connect`, and switch models via `/model`\n'
  else
    printf '  - Codex            : Run `codex`, sign in with `$agy-connect`, and switch models via `/model`\n'
  fi
fi
if [[ "$INSTALL_OPENCODE" -eq 1 ]]; then
  printf '  - OpenCode V2      : Run `opencode`, sign in natively with `/connect` -> Antigravity (ACP), and pick `agy/*` in `/model`\n'
fi
if [[ "$INSTALL_DSH" -eq 1 ]]; then
  printf '  - DeepSeek Harness : Restart DeepSeek Harness, use `/agy-connect` or `/agy-models`, and select `Antigravity (ACP)`\n'
fi
printf '  - Authenticate CLI : `%s` (or export `GEMINI_API_KEY` for ToS-recommended API-key auth)\n' "${LOGIN_CMD[*]}"
printf '  - Multi-account    : `./install.sh account add work --data-dir ~/agy-work --login` | `./install.sh account use work`\n'
printf '  - Update later     : `./install.sh --update` (or `agi update` if installed via npm)\n'
