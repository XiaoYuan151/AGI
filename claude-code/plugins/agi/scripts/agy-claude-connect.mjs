#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseConnectArgs as parseCoreConnectArgs,
  runHarnessConnect,
} from "./lib/core/index.mjs";
import {
  DEFAULT_CLAUDE_BRIDGE_HOST,
  DEFAULT_CLAUDE_BRIDGE_PORT,
} from "./agy-claude-bridge.mjs";

export function parseConnectArgs(argv) {
  return parseCoreConnectArgs(argv, {
    host: process.env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_BRIDGE_HOST,
    port: Number(process.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT),
  });
}

export async function runClaudeConnect(options = {}) {
  return runHarnessConnect(options, {
    useBridge: true,
    defaultHost: DEFAULT_CLAUDE_BRIDGE_HOST,
    defaultPort: DEFAULT_CLAUDE_BRIDGE_PORT,
  });
}

async function main() {
  const args = parseConnectArgs(process.argv.slice(2));
  if (args.action === "help") {
    console.log(
      [
        "Usage: agy-claude-connect [--status | --login | --method <id> | --refresh | --logout] [options]",
        "",
        "Connects Claude Code's AGI plugin to Google Antigravity ACP using official `agy acp` commands only:",
        "  (default) / --login      Run official interactive `agy acp ... --login` and refresh bridge",
        "  --method <id>            Authenticate via official ACP `authenticate` (gemini-api-key | oauth-business | agent-platform)",
        "  --account <name>         Target a named AGI account profile",
        "  --data-dir <dir>         Override isolated data folder (--gemini-dir)",
        "  --status                 Inspect isolated ACP profile and authentication status",
        "  --refresh                Restart ACP subprocess and refresh bridge models",
        "  --logout                 Sign out via official ACP `logout` RPC",
      ].join("\n"),
    );
    return;
  }

  const result = await runClaudeConnect(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `[agy-claude-connect] ${result.action} OK (authenticated=${String(result.authenticated)}, models=${result.modelsCount ?? 0}, loginCommand="${result.loginCommand || result.command || ""}")`,
    );
  } else {
    console.error(`[agy-claude-connect] ${result.action} failed: ${result.error || result.message || "unknown error"}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err) => {
    console.error(`[agy-claude-connect] Error: ${err.message}`);
    process.exit(1);
  });
}
