#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseConnectArgs as parseCoreConnectArgs,
  runHarnessConnect,
} from "../src/lib/core/index.mjs";

export function parseConnectArgs(argv) {
  return parseCoreConnectArgs(argv);
}

export async function runDshConnect(options = {}) {
  return runHarnessConnect(options, { useBridge: false });
}

async function main() {
  const args = parseConnectArgs(process.argv.slice(2));
  if (args.action === "help") {
    console.log(
      [
        "Usage: node agy-dsh-connect.mjs [--status | --login | --method <id> | --logout] [--json]",
        "",
        "Connects DeepSeek Harness's AGI plugin to Google Antigravity ACP using official `agy acp` commands only.",
      ].join("\n"),
    );
    return;
  }

  const result = await runDshConnect(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `[agy-dsh-connect] ${result.action} OK (authenticated=${String(result.authenticated)}, models=${result.modelsCount ?? 0})`,
    );
  } else {
    console.error(`[agy-dsh-connect] ${result.action} failed: ${result.error || result.message || "unknown error"}`);
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
    console.error(`[agy-dsh-connect] Error: ${err.message}`);
    process.exit(1);
  });
}
