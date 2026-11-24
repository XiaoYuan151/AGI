#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAgentCsv } from "../scripts/select-agents.mjs";
import { runAccountCli } from "../scripts/accounts.mjs";
import {
  PACKAGE_NAME,
  PACKAGE_ROOT,
  PACKAGE_VERSION,
  getAgiStatus,
  installHarnesses,
  stopBridges,
  uninstallAgi,
  updateAgi,
} from "../src/installer.mjs";

function printHelp() {
  console.log(
    [
      `${PACKAGE_NAME} v${PACKAGE_VERSION} — Anti-Gravity Integration CLI`,
      "",
      "Usage:",
      "  npx xiaoyuan151/agi install [options]   Run straight from GitHub without global install",
      "  npx @xiaoyuan151/agi install [options]  Run straight from npm without global install",
      "  agi [install] [options]                 Install/configure selected agent harnesses",
      "  agi update [options]                    Update plugins, packages, and bridges (preserves accounts & choices)",
      "  agi uninstall [options]                 Remove plugin configurations (--purge also deletes ~/.agi)",
      "  agi account <cmd> [options]             Manage multi-account profiles & isolated data folders",
      "  agi connect [harness] [options]         Run official sign-in / auth flow for claude | codex | dsh",
      "  agi bridge <claude|codex> <cmd>         Manage local bridges (start | ensure | status | stop | restart | models)",
      "  agi status [--json]                     Inspect installed version, accounts, and running bridges",
      "  agi --version                           Show package version",
      "",
      "Install / Update options:",
      "  -a, --agent <list>               Target harnesses (claude,codex,opencode,dsh,all)",
      "  --all                            Select all 4 harnesses",
      "  --claude | --codex | --opencode | --dsh",
      "  -y, --yes, --no-interactive      Skip interactive agent picker",
      "  -u, --update                     Same as 'agi update' (install.sh-compatible flag)",
      "  --uninstall, --remove            Same as 'agi uninstall' (install.sh-compatible flag)",
      "  --account <name>                 Target/create named account profile (default: active or 'default')",
      "  --data-dir, --gemini-dir <dir>   Data folder for the target account",
      "  --app-data-dir <name>            --app-data-dir passed to agy acp (default: antigravity-acp)",
      "  --use-default-gemini-dir         Share ~/.gemini instead of an isolated data folder",
      "  --pin-gemini-dir                 Pin AGY_GEMINI_DIR in Claude settings",
      "  --add-account <name>             Add account into its own data folder (install.sh-compatible)",
      "  --use-account <name>             Switch active account (install.sh-compatible)",
      "  --list-accounts                  List configured accounts (install.sh-compatible)",
      "  --remove-account <name>          Remove account (add --purge to delete folder)",
      "  --label <text>                   Optional account display label",
      "  --no-activate                    With --add-account, keep current active account unchanged",
      "  --force                          Allow sharing an existing data folder across accounts",
      "  --auth-method <id>               Default auth method (gemini-api-key | oauth-business | agent-platform)",
      "  --claude-auth-mode <mode>        auto (default) | preserve | local-token",
      "  --local-token                    Shorthand for --claude-auth-mode local-token",
      "  --codex-mode <mode>              profile (default) | default",
      "  --dsh-profile <name>             Target DeepSeek Harness profile(s)",
      "  --copy                           Copy OpenCode plugin instead of symlinking",
      "  --login                          Force interactive `agy acp ... --login`",
      "  --skip-login                     Skip interactive login if unauthenticated",
      "  --no-start-bridge                Do not start background Claude/Codex bridge daemons",
      "  --install-dir <dir>              Custom directory for materialized runtime assets",
      "  --repo-url <url>                 Repository URL metadata recorded in install state",
      "  --check                          (update) Check for updates without modifying files",
      "  --self                           (update) Also run `npm install -g @xiaoyuan151/agi@latest`",
      "  --ref <branch|tag>               (update) Git branch or tag for git-based installs",
      "  --purge                          (uninstall / --remove-account) Also delete isolated state",
      "  --dry-run                        Preview actions without modifying files",
      "  --json                           Print machine-readable JSON",
      "",
      "Account subcommands (`agi account --help` for full details):",
      "  agi account list [--probe]",
      "  agi account add <name> [--data-dir <dir>] [--login]",
      "  agi account use <name>",
      "  agi account remove <name> [--purge]",
    ].join("\n"),
  );
}

function parseInstallLikeArgs(argv) {
  const opts = {
    agents: [],
    all: false,
    interactive: true,
    update: false,
    uninstall: false,
    addAccount: undefined,
    useAccount: undefined,
    listAccounts: false,
    removeAccount: undefined,
    probe: false,
    account: undefined,
    dataDir: undefined,
    appDataDir: undefined,
    useDefaultGeminiDir: false,
    pinGeminiDir: false,
    label: undefined,
    noActivate: false,
    force: false,
    authMethod: undefined,
    claudeAuthMode: undefined,
    codexMode: undefined,
    dshProfile: undefined,
    copyOpencode: undefined,
    startBridge: true,
    forceLogin: false,
    skipLogin: undefined,
    installDir: undefined,
    repoUrl: undefined,
    purge: false,
    dryRun: false,
    check: false,
    self: false,
    tag: undefined,
    repoRef: undefined,
    noGitPull: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "-h" || t === "--help") opts.help = true;
    else if (t === "--all") opts.all = true;
    else if (t === "--claude") opts.agents.push("claude");
    else if (t === "--codex") opts.agents.push("codex");
    else if (t === "--opencode") opts.agents.push("opencode");
    else if (t === "--dsh" || t === "--deepseek-harness") opts.agents.push("dsh");
    else if ((t === "-a" || t === "--agent") && argv[i + 1] !== undefined) {
      const parsed = parseAgentCsv(argv[++i]);
      for (const a of parsed) {
        if (!opts.agents.includes(a)) opts.agents.push(a);
      }
    } else if (t === "-y" || t === "--yes" || t === "--no-interactive") {
      opts.interactive = false;
    } else if (t === "-u" || t === "--update") {
      opts.update = true;
    } else if (t === "--uninstall" || t === "--remove") {
      opts.uninstall = true;
    } else if (t === "--add-account" && argv[i + 1] !== undefined) {
      opts.addAccount = argv[++i];
    } else if ((t === "--use-account" || t === "--switch-account") && argv[i + 1] !== undefined) {
      opts.useAccount = argv[++i];
    } else if (t === "--list-accounts") {
      opts.listAccounts = true;
    } else if (t === "--remove-account" && argv[i + 1] !== undefined) {
      opts.removeAccount = argv[++i];
    } else if (t === "--probe") {
      opts.probe = true;
    } else if (t === "--account" && argv[i + 1] !== undefined) {
      opts.account = argv[++i];
    } else if ((t === "--data-dir" || t === "--gemini-dir") && argv[i + 1] !== undefined) {
      opts.dataDir = argv[++i];
    } else if (t === "--app-data-dir" && argv[i + 1] !== undefined) {
      opts.appDataDir = argv[++i];
    } else if (t === "--use-default-gemini-dir") {
      opts.useDefaultGeminiDir = true;
    } else if (t === "--pin-gemini-dir") {
      opts.pinGeminiDir = true;
    } else if (t === "--label" && argv[i + 1] !== undefined) {
      opts.label = argv[++i];
    } else if (t === "--no-activate") {
      opts.noActivate = true;
    } else if (t === "--force") {
      opts.force = true;
    } else if ((t === "--auth-method" || t === "--method") && argv[i + 1] !== undefined) {
      opts.authMethod = argv[++i];
    } else if (t === "--claude-auth-mode" && argv[i + 1] !== undefined) {
      opts.claudeAuthMode = argv[++i];
    } else if (t === "--local-token") {
      opts.claudeAuthMode = "local-token";
    } else if (t === "--codex-mode" && argv[i + 1] !== undefined) {
      opts.codexMode = argv[++i];
    } else if (t === "--dsh-profile" && argv[i + 1] !== undefined) {
      opts.dshProfile = argv[++i];
    } else if (t === "--copy") {
      opts.copyOpencode = true;
    } else if (t === "--no-start-bridge") {
      opts.startBridge = false;
    } else if (t === "--login") {
      opts.forceLogin = true;
    } else if (t === "--skip-login") {
      opts.skipLogin = true;
    } else if (t === "--install-dir" && argv[i + 1] !== undefined) {
      opts.installDir = argv[++i];
    } else if (t === "--repo-url" && argv[i + 1] !== undefined) {
      opts.repoUrl = argv[++i];
    } else if (t === "--purge") {
      opts.purge = true;
    } else if (t === "--dry-run") {
      opts.dryRun = true;
    } else if (t === "--check") {
      opts.check = true;
    } else if (t === "--self") {
      opts.self = true;
    } else if (t === "--tag" && argv[i + 1] !== undefined) {
      opts.tag = argv[++i];
    } else if (t === "--ref" && argv[i + 1] !== undefined) {
      opts.repoRef = argv[++i];
    } else if (t === "--no-git-pull") {
      opts.noGitPull = true;
    } else if (t === "--json") {
      opts.json = true;
    } else {
      throw new Error(`Unknown option '${t}' (run 'agi --help').`);
    }
  }
  return opts;
}

function runBridgeCommand(argv) {
  const target = (argv[0] || "").toLowerCase();
  const rest = argv.slice(1);
  if (target === "stop-all") {
    const res = stopBridges();
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  let scriptPath;
  if (target === "claude" || target === "claude-code") {
    scriptPath = path.join(PACKAGE_ROOT, "claude-code", "plugins", "agi", "scripts", "agy-claude-bridge.mjs");
  } else if (target === "codex") {
    scriptPath = path.join(PACKAGE_ROOT, "codex", "plugins", "agi", "scripts", "agy-codex-bridge.mjs");
  } else {
    throw new Error("Usage: agi bridge <claude|codex> <start|ensure|status|stop|models> [options]");
  }

  if (rest[0] === "restart") {
    spawnSync(process.execPath, [scriptPath, "stop"], { stdio: "inherit" });
    const ensureRes = spawnSync(
      process.execPath,
      [scriptPath, "ensure", ...rest.slice(1)],
      { stdio: "inherit" },
    );
    return ensureRes.status ?? 0;
  }

  const res = spawnSync(process.execPath, [scriptPath, ...rest], { stdio: "inherit" });
  return res.status ?? 0;
}

function runConnectCommand(argv) {
  const rest = [...argv];
  let target = "claude";
  if (rest[0] && !rest[0].startsWith("-")) {
    const first = rest[0].toLowerCase();
    if (["claude", "claude-code", "codex", "dsh", "deepseek", "deepseek-harness"].includes(first)) {
      target = rest.shift().toLowerCase();
    }
  }

  let scriptPath;
  if (target === "claude" || target === "claude-code") {
    scriptPath = path.join(PACKAGE_ROOT, "claude-code", "plugins", "agi", "scripts", "agy-claude-connect.mjs");
  } else if (target === "codex") {
    scriptPath = path.join(PACKAGE_ROOT, "codex", "plugins", "agi", "scripts", "agy-codex-connect.mjs");
  } else {
    scriptPath = path.join(PACKAGE_ROOT, "deepseek-harness", "plugins", "agi", "scripts", "agy-dsh-connect.mjs");
  }

  const res = spawnSync(process.execPath, [scriptPath, ...rest], { stdio: "inherit" });
  return res.status ?? 0;
}

export async function runCli(argv = process.argv.slice(2)) {
  const tokens = [...argv];
  let sub = "install";

  if (tokens[0] === "--version" || tokens[0] === "-v" || tokens[0] === "version") {
    console.log(PACKAGE_VERSION);
    return 0;
  }
  if (tokens[0] === "--help" || tokens[0] === "-h" || tokens[0] === "help") {
    printHelp();
    return 0;
  }

  if (tokens[0] && !tokens[0].startsWith("-")) {
    const candidate = tokens[0].toLowerCase();
    if (["install", "setup"].includes(candidate)) {
      sub = "install";
      tokens.shift();
    } else if (["update", "upgrade"].includes(candidate)) {
      sub = "update";
      tokens.shift();
    } else if (["uninstall", "remove"].includes(candidate)) {
      sub = "uninstall";
      tokens.shift();
    } else if (["account", "accounts"].includes(candidate)) {
      return runAccountCli(tokens.slice(1));
    } else if (candidate === "bridge") {
      return runBridgeCommand(tokens.slice(1));
    } else if (candidate === "connect") {
      return runConnectCommand(tokens.slice(1));
    } else if (candidate === "status") {
      sub = "status";
      tokens.shift();
    } else {
      throw new Error(`Unknown command '${tokens[0]}' (run 'agi --help').`);
    }
  }

  if (sub === "status") {
    const json = tokens.includes("--json");
    const status = await getAgiStatus();
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(
        [
          `${status.packageName} v${status.version}`,
          `  AGI home       : ${status.agiHome}`,
          `  Installed ver  : ${status.installState?.version || "(not installed via CLI yet)"}`,
          `  Method         : ${status.installState?.installMethod || "(none)"}`,
          `  Agents         : ${(status.installState?.agents || status.detectedAgents).join(", ") || "(none)"}`,
          `  Active account : ${status.accounts.activeAccount || "(none)"}`,
          `  Accounts count : ${status.accounts.accounts.length}`,
          `  Claude bridge  : ${status.bridges.claude.running ? `running (${status.bridges.claude.url})` : "stopped"}`,
          `  Codex bridge   : ${status.bridges.codex.running ? `running (${status.bridges.codex.url})` : "stopped"}`,
        ].join("\n"),
      );
    }
    return 0;
  }

  const opts = parseInstallLikeArgs(tokens);
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.addAccount) {
    const accountArgs = ["add", opts.addAccount];
    if (opts.dataDir !== undefined) accountArgs.push("--data-dir", opts.dataDir);
    if (opts.appDataDir !== undefined) accountArgs.push("--app-data-dir", opts.appDataDir);
    if (opts.authMethod !== undefined) accountArgs.push("--auth-method", opts.authMethod);
    if (opts.label !== undefined) accountArgs.push("--label", opts.label);
    if (opts.noActivate) accountArgs.push("--no-activate");
    if (opts.force) accountArgs.push("--force");
    if (opts.forceLogin) accountArgs.push("--login");
    if (opts.dryRun) accountArgs.push("--dry-run");
    if (opts.json) accountArgs.push("--json");
    return runAccountCli(accountArgs);
  }
  if (opts.useAccount) {
    const accountArgs = ["use", opts.useAccount];
    if (opts.dryRun) accountArgs.push("--dry-run");
    if (opts.json) accountArgs.push("--json");
    return runAccountCli(accountArgs);
  }
  if (opts.listAccounts) {
    const accountArgs = ["list"];
    if (opts.probe) accountArgs.push("--probe");
    if (opts.json) accountArgs.push("--json");
    return runAccountCli(accountArgs);
  }
  if (opts.removeAccount) {
    const accountArgs = ["remove", opts.removeAccount];
    if (opts.purge) accountArgs.push("--purge");
    if (opts.dryRun) accountArgs.push("--dry-run");
    if (opts.json) accountArgs.push("--json");
    return runAccountCli(accountArgs);
  }

  if (opts.uninstall) sub = "uninstall";
  else if (opts.update) sub = "update";

  const onLog = opts.json ? undefined : (msg) => console.log(msg);

  if (sub === "uninstall") {
    const res = await uninstallAgi(opts);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(
        `[agi] Uninstall complete (agents: ${res.agents.join(", ") || "none"}, purge=${res.purge}).`,
      );
    }
    return 0;
  }

  if (sub === "update") {
    const res = await updateAgi({ ...opts, onLog, rawArgs: tokens });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.action === "check") {
      console.log(
        [
          `Installed version : ${res.installedVersion || "(unknown)"}`,
          `Package version   : ${res.packageVersion}`,
          `Method            : ${res.installMethod}`,
          ...(res.localCommit ? [`Local commit      : ${res.localCommit.slice(0, 8)}`] : []),
          ...(res.remoteCommit ? [`Remote commit     : ${res.remoteCommit.slice(0, 8)}`] : []),
          `Update available  : ${res.updateAvailable ? "yes" : "no"}`,
        ].join("\n"),
      );
    } else if (!res.delegatedToNewBinary) {
      console.log(
        `[agi] Updated to v${res.version} (agents: ${res.agents.join(", ")}, activeAccount: ${res.activeAccount || "default"}).`,
      );
    }
    return res.exitCode ?? 0;
  }

  const res = await installHarnesses({ ...opts, onLog });
  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const tips = [];
    if (res.agents.includes("claude")) {
      tips.push("  Claude Code     : restart Claude Code -> /agi:connect -> pick anthropic-agy/* in /model");
    }
    if (res.agents.includes("codex")) {
      tips.push("  Codex           : run 'codex -p agy' -> $agy-connect -> pick agy/* in /model");
    }
    if (res.agents.includes("opencode")) {
      tips.push("  OpenCode        : run /connect -> Antigravity (ACP) -> pick agy/* in /model");
    }
    if (res.agents.includes("dsh")) {
      tips.push("  DeepSeek Harness: run /agy-connect -> pick agy/* in /model");
    }
    console.log(
      [
        `[agi] Done! (v${res.version})`,
        `  Agents        : ${res.agents.join(", ")}`,
        `  Active account: ${res.activeAccount || "(default)"}`,
        `  Data folder   : ${res.account?.geminiDir || "(default ~/.gemini)"}`,
        `  Shared config : ${res.acpConfigPath}`,
        ...(tips.length > 0 ? ["  Next steps    :", ...tips] : []),
      ].join("\n"),
    );
  }
  return 0;
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
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      if (err?.code === "CANCELLED") {
        process.exit(130);
      }
      console.error(`[agi] Error: ${err.message}`);
      process.exit(1);
    });
}
