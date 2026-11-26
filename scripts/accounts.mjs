#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { listPersistedAccounts } from "../src/core/index.mjs";
import {
  AccountService,
  BridgeNotifier,
  syncClaudeSettingsAccountDir,
} from "../src/services/account-service.mjs";

export { syncClaudeSettingsAccountDir };

export async function notifyBridgesAccountSwitch(name, options = {}) {
  return new BridgeNotifier().notifyAccountSwitch(name, options);
}

export async function notifyBridgesRefresh(options = {}) {
  return new BridgeNotifier().notifyRefresh(options);
}

export async function addAccount(options = {}) {
  return new AccountService({ env: options.env || process.env }).add(options);
}

export async function listAccounts(options = {}) {
  return new AccountService({ env: options.env || process.env }).list(options);
}

export async function useAccount(name, options = {}) {
  return new AccountService({ env: options.env || process.env }).use(name, options);
}

export async function removeAccount(name, options = {}) {
  return new AccountService({ env: options.env || process.env }).remove(name, options);
}

export async function loginAccount(name = "", options = {}) {
  return new AccountService({ env: options.env || process.env }).login(name, options);
}

export async function logoutAccount(name = "", options = {}) {
  return new AccountService({ env: options.env || process.env }).logout(name, options);
}

export async function accountStatus(name = "", options = {}) {
  return new AccountService({ env: options.env || process.env }).status(name, options);
}

export function parseAccountCliArgs(argv) {
  const tokens = [...argv];
  let command = "list";
  const subCommands = new Set([
    "list",
    "ls",
    "add",
    "create",
    "use",
    "switch",
    "select",
    "current",
    "login",
    "logout",
    "status",
    "remove",
    "rm",
    "delete",
    "help",
  ]);
  if (tokens[0] && !tokens[0].startsWith("-") && subCommands.has(tokens[0].toLowerCase())) {
    const rawCmd = tokens.shift().toLowerCase();
    if (rawCmd === "ls") command = "list";
    else if (rawCmd === "create") command = "add";
    else if (rawCmd === "switch" || rawCmd === "select") command = "use";
    else if (rawCmd === "rm" || rawCmd === "delete") command = "remove";
    else command = rawCmd;
  }

  const opts = {
    command,
    name: "",
    dataDir: undefined,
    appDataDir: undefined,
    authMethod: undefined,
    method: "",
    label: undefined,
    activate: true,
    login: false,
    purgeData: false,
    force: false,
    probe: false,
    json: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-h" || t === "--help") opts.help = true;
    else if (t === "--json") opts.json = true;
    else if (t === "--dry-run") opts.dryRun = true;
    else if (t === "--probe") opts.probe = true;
    else if (t === "--login") opts.login = true;
    else if (t === "--skip-login") opts.login = false;
    else if (t === "--no-activate") opts.activate = false;
    else if (t === "--activate") opts.activate = true;
    else if (t === "--purge") opts.purgeData = true;
    else if (t === "--force") opts.force = true;
    else if ((t === "--data-dir" || t === "--gemini-dir") && tokens[i + 1] !== undefined) {
      opts.dataDir = tokens[++i];
    } else if (t === "--app-data-dir" && tokens[i + 1] !== undefined) {
      opts.appDataDir = tokens[++i];
    } else if (t === "--auth-method" && tokens[i + 1] !== undefined) {
      opts.authMethod = tokens[++i];
    } else if (t === "--method" && tokens[i + 1] !== undefined) {
      opts.method = tokens[++i];
      if (!opts.authMethod) opts.authMethod = opts.method;
    } else if (t === "--label" && tokens[i + 1] !== undefined) {
      opts.label = tokens[++i];
    } else if (!t.startsWith("-") && !opts.name) {
      opts.name = t;
    } else {
      throw new Error(`Unknown option or unexpected argument: ${t}`);
    }
  }

  if (opts.help) opts.command = "help";
  return opts;
}

function formatAccountsListText(res) {
  if (!res.accounts || res.accounts.length === 0) {
    return [
      `No named accounts configured yet (${res.configPath || "~/.agi/acp.json"}).`,
      "Run `agi account add <name> --data-dir <dir> --login` to add your first isolated account.",
    ].join("\n");
  }
  const lines = [`Configured AGI accounts (active: ${res.activeAccount || "none"}, config: ${res.configPath}):`];
  for (const a of res.accounts) {
    const marker = a.active ? "*" : " ";
    const authPart =
      typeof a.authenticated === "boolean"
        ? ` auth=${a.authenticated ? "yes" : "no"} models=${a.modelsCount ?? 0}`
        : "";
    lines.push(
      `  ${marker} ${a.name}  dataDir=${a.geminiDir || "(default ~/.gemini)"}  appDataDir=${a.appDataDir || "default"}${authPart}`,
    );
  }
  return lines.join("\n");
}

export async function runAccountCli(argv, { env = process.env } = {}) {
  const opts = parseAccountCliArgs(argv);
  if (opts.command === "help") {
    console.log(
      [
        "Usage: agi account <command> [options]",
        "",
        "Commands:",
        "  list [--probe] [--json]               List configured accounts and data folders",
        "  add <name> [options]                  Add/update an account in its own data folder",
        "  use <name>                            Switch active account and update running bridges",
        "  current [--json]                      Show currently active account",
        "  status [name] [--json]                Inspect auth & model discovery for an account",
        "  login [name] [--method <id>]          Sign in to an account via official agy acp --login",
        "  logout [name]                         Sign out an account via official ACP logout",
        "  remove <name> [--purge]               Remove an account (optionally delete its data folder)",
        "",
        "Options for add:",
        "  --data-dir <dir>                      Custom folder for this account (default: ~/.agi/accounts/<name>)",
        "  --app-data-dir <name>                 --app-data-dir name (default: antigravity-acp)",
        "  --auth-method <id>                    Default auth method (gemini-api-key | oauth-business | agent-platform)",
        "  --label <text>                        Optional label",
        "  --no-activate                         Keep the current active account unchanged",
        "  --login                               Run interactive login (or --method auth) immediately",
        "  --force                               Allow sharing an existing data folder across accounts",
        "  --dry-run                             Preview without writing disk",
        "  --json                                Machine-readable JSON output",
      ].join("\n"),
    );
    return 0;
  }

  let result;
  if (opts.command === "list") {
    result = await listAccounts({ probe: opts.probe, env });
  } else if (opts.command === "current") {
    const listed = listPersistedAccounts(env);
    const active = listed.accounts.find((a) => a.active) || null;
    result = {
      ok: true,
      action: "current",
      configPath: listed.configPath,
      activeAccount: listed.activeAccount || null,
      account: active,
    };
  } else if (opts.command === "add") {
    if (!opts.name) {
      throw new Error("Missing account name. Usage: agi account add <name> [--data-dir <dir>]");
    }
    result = await addAccount({
      name: opts.name,
      dataDir: opts.dataDir,
      appDataDir: opts.appDataDir,
      authMethod: opts.authMethod,
      label: opts.label,
      activate: opts.activate,
      login: opts.login,
      method: opts.method,
      force: opts.force,
      dryRun: opts.dryRun,
      env,
    });
  } else if (opts.command === "use") {
    if (!opts.name) {
      throw new Error("Missing account name. Usage: agi account use <name>");
    }
    result = await useAccount(opts.name, { dryRun: opts.dryRun, env });
  } else if (opts.command === "remove") {
    if (!opts.name) {
      throw new Error("Missing account name. Usage: agi account remove <name> [--purge]");
    }
    result = await removeAccount(opts.name, {
      purgeData: opts.purgeData,
      dryRun: opts.dryRun,
      env,
    });
  } else if (opts.command === "login") {
    result = await loginAccount(opts.name, { method: opts.method, env });
  } else if (opts.command === "logout") {
    result = await logoutAccount(opts.name, { env });
  } else if (opts.command === "status") {
    result = await accountStatus(opts.name, { env });
  } else {
    throw new Error(`Unknown account command '${opts.command}'. Run with --help.`);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.action === "list") {
    console.log(formatAccountsListText(result));
  } else if (result.action === "current") {
    if (result.account) {
      console.log(
        `Active account: ${result.account.name} (dataDir=${result.account.geminiDir || "(default)"}, appDataDir=${result.account.appDataDir || "default"})`,
      );
    } else {
      console.log("No active named account configured.");
    }
  } else if (result.action === "add") {
    console.log(
      `[agi-account] Added '${result.account.name}' -> ${result.account.geminiDir} (active=${result.activeAccount === result.account.name})`,
    );
    if (!opts.login && !result.dryRun) {
      console.log(`[agi-account] Sign in for '${result.account.name}': ${result.loginCommand}`);
    }
  } else if (result.action === "use") {
    console.log(
      `[agi-account] Switched active account to '${result.activeAccount}' (dataDir=${result.account.geminiDir})`,
    );
  } else if (result.action === "remove") {
    console.log(
      `[agi-account] Removed '${result.removed?.name || opts.name}' (purgedData=${Boolean(result.purgedData)}, activeAccount=${result.activeAccount || "none"})`,
    );
  } else if (result.action === "status") {
    console.log(
      `[agi-account] account=${result.account || "(default)"} authenticated=${String(result.authenticated)} models=${result.modelsCount} (${result.modelSource}) dataDir=${result.dataDir || "(default)"}`,
    );
  } else if (result.action === "login") {
    console.log(
      result.ok
        ? `[agi-account] Login OK for '${result.account || "default"}' (authenticated=${String(result.authenticated)}, models=${result.modelsCount ?? 0})`
        : `[agi-account] Login failed: ${result.error || "unknown error"}`,
    );
  } else if (result.action === "logout") {
    console.log(
      result.ok
        ? `[agi-account] Signed out '${result.account || "default"}'.`
        : `[agi-account] Logout failed: ${result.message || "unsupported"}`,
    );
  }

  return result.ok === false ? 1 : 0;
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
  runAccountCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(`[agi-account] Error: ${err.message}`);
      process.exit(1);
    });
}
