#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgyAcpClient,
  expandHomePath,
  listPersistedAccounts,
  readPersistedAcpConfig,
  removePersistedAccount,
  resolveAcpConfigPath,
  resolveAgiHome,
  resolveDefaultAccountDataDir,
  runAgyInteractiveLogin,
  setActivePersistedAccount,
  upsertPersistedAccount,
  validateAccountName,
} from "../claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs";

const DEFAULT_CLAUDE_HOST = "127.0.0.1";
const DEFAULT_CLAUDE_PORT = 43110;
const DEFAULT_CODEX_HOST = "127.0.0.1";
const DEFAULT_CODEX_PORT = 43111;

async function postBridgeJson(host, port, pathname, body, timeoutMs = 2500) {
  try {
    const res = await fetch(`http://${host}:${port}${pathname}`, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    return {
      reachable: true,
      updated: res.ok,
      status: res.status,
      data,
    };
  } catch (err) {
    return {
      reachable: false,
      updated: false,
      error: err.message,
    };
  }
}

export async function notifyBridgesAccountSwitch(
  name,
  {
    claudeHost = process.env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_HOST,
    claudePort = Number(process.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_PORT),
    codexHost = process.env.AGY_CODEX_HOST || DEFAULT_CODEX_HOST,
    codexPort = Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_PORT),
  } = {},
) {
  const [claude, codex] = await Promise.all([
    postBridgeJson(claudeHost, claudePort, "/v1/accounts/switch", { name }),
    postBridgeJson(codexHost, codexPort, "/v1/accounts/switch", { name }),
  ]);
  return { claude, codex };
}

export async function notifyBridgesRefresh({
  claudeHost = process.env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_HOST,
  claudePort = Number(process.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_PORT),
  codexHost = process.env.AGY_CODEX_HOST || DEFAULT_CODEX_HOST,
  codexPort = Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_PORT),
} = {}) {
  const [claude, codex] = await Promise.all([
    postBridgeJson(claudeHost, claudePort, "/v1/refresh?restart=1"),
    postBridgeJson(codexHost, codexPort, "/v1/refresh?restart=1"),
  ]);
  return { claude, codex };
}

export function syncClaudeSettingsAccountDir(
  entry,
  {
    claudeConfigDir,
    knownDirs = [],
    env = process.env,
    dryRun = false,
  } = {},
) {
  if (!entry) return { updated: false, reason: "no-entry" };
  const baseDir = path.resolve(
    claudeConfigDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  );
  const settingsPath = path.join(baseDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return { updated: false, settingsPath, reason: "missing-settings" };
  }
  let parsed;
  try {
    const raw = fs.readFileSync(settingsPath, "utf8").trim();
    if (!raw) return { updated: false, settingsPath, reason: "empty-settings" };
    parsed = JSON.parse(raw);
  } catch {
    return { updated: false, settingsPath, reason: "invalid-json" };
  }
  if (!parsed?.env || typeof parsed.env !== "object" || Array.isArray(parsed.env)) {
    return { updated: false, settingsPath, reason: "no-env" };
  }

  let changed = false;
  const currentPinned =
    typeof parsed.env.AGY_GEMINI_DIR === "string" ? parsed.env.AGY_GEMINI_DIR.trim() : "";
  const resolvedKnown = new Set(
    knownDirs.filter(Boolean).map((d) => path.resolve(d)),
  );
  resolvedKnown.add(path.resolve(resolveAgiHome(env), "antigravity"));

  if (currentPinned && resolvedKnown.has(path.resolve(currentPinned))) {
    if (entry.geminiDir) {
      if (parsed.env.AGY_GEMINI_DIR !== entry.geminiDir) {
        parsed.env.AGY_GEMINI_DIR = entry.geminiDir;
        changed = true;
      }
    } else {
      delete parsed.env.AGY_GEMINI_DIR;
      changed = true;
    }
    if (entry.appDataDir && parsed.env.AGY_APP_DATA_DIR !== entry.appDataDir) {
      parsed.env.AGY_APP_DATA_DIR = entry.appDataDir;
      changed = true;
    }
  }

  if (typeof parsed.env.AGY_ACCOUNT === "string" && parsed.env.AGY_ACCOUNT !== entry.name) {
    parsed.env.AGY_ACCOUNT = entry.name;
    changed = true;
  }

  if (changed && !dryRun) {
    fs.writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  return { updated: changed, settingsPath };
}

function collectKnownAccountDirs(cfg, env) {
  const dirs = [path.join(resolveAgiHome(env), "antigravity")];
  if (cfg?.geminiDir) dirs.push(cfg.geminiDir);
  for (const entry of Object.values(cfg?.accounts || {})) {
    if (entry?.geminiDir) dirs.push(entry.geminiDir);
  }
  return dirs;
}

export async function addAccount({
  name,
  dataDir,
  geminiDir,
  appDataDir,
  authMethod,
  label,
  activate = true,
  login = false,
  method = "",
  force = false,
  agyBin,
  env = process.env,
  stdio = "inherit",
  claudeConfigDir,
  claudeHost,
  claudePort,
  codexHost,
  codexPort,
  dryRun = false,
} = {}) {
  const validName = validateAccountName(name);
  const beforeCfg = readPersistedAcpConfig(env);
  const knownDirs = collectKnownAccountDirs(beforeCfg, env);

  if (dryRun) {
    const existing = beforeCfg.accounts?.[validName];
    const resolvedDir =
      expandHomePath(dataDir || geminiDir || "") ||
      existing?.geminiDir ||
      resolveDefaultAccountDataDir(validName, env);
    return {
      ok: true,
      dryRun: true,
      action: "add",
      account: {
        name: validName,
        label: label ?? existing?.label ?? "",
        dataDir: resolvedDir,
        geminiDir: resolvedDir,
        appDataDir: appDataDir ?? existing?.appDataDir ?? "antigravity-acp",
        authMethod: authMethod ?? existing?.authMethod ?? "",
      },
      activate,
      login,
    };
  }

  const res = upsertPersistedAccount(
    {
      name: validName,
      dataDir,
      geminiDir,
      appDataDir,
      authMethod,
      label,
      activate,
      force,
    },
    env,
  );

  let loginResult = null;
  if (login) {
    const resolvedBin = agyBin || env.AGY_BIN || "agy";
    const normalizedMethod = String(method || "").trim();
    const methodMap = {
      "api-key": "gemini-api-key",
      enterprise: "oauth-business",
      vertex: "agent-platform",
    };
    const methodId = methodMap[normalizedMethod] || normalizedMethod;
    if (methodId && methodId !== "oauth-personal" && methodId !== "google") {
      const client = new AgyAcpClient({
        agyBin: resolvedBin,
        account: res.account.name,
        geminiDir: res.account.geminiDir,
        appDataDir: res.account.appDataDir,
        authMethod: res.account.authMethod || undefined,
        env,
        usePersistedConfig: false,
      });
      try {
        await client.authenticate(methodId, 10000);
        const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
        loginResult = {
          ok: true,
          methodId,
          authenticated: discovery.authenticated,
          source: discovery.source,
          modelsCount: discovery.models.length,
        };
      } finally {
        await client.dispose();
      }
    } else {
      loginResult = await runAgyInteractiveLogin({
        agyBin: resolvedBin,
        geminiDir: res.account.geminiDir,
        appDataDir: res.account.appDataDir,
        env,
        stdio,
      });
    }
  }

  let claudeSync = null;
  let bridges = null;
  if (res.activeAccount === res.account.name) {
    claudeSync = syncClaudeSettingsAccountDir(res.account, {
      claudeConfigDir,
      knownDirs,
      env,
      dryRun: false,
    });
    bridges = await notifyBridgesAccountSwitch(res.account.name, {
      claudeHost,
      claudePort,
      codexHost,
      codexPort,
    });
  }

  return {
    ok: loginResult ? Boolean(loginResult.ok) : true,
    action: "add",
    configPath: res.configPath,
    account: res.account,
    activeAccount: res.activeAccount,
    loginCommand: `${agyBin || env.AGY_BIN || "agy"} acp${
      res.account.geminiDir ? ` --gemini-dir ${res.account.geminiDir}` : ""
    }${res.account.appDataDir ? ` --app-data-dir ${res.account.appDataDir}` : ""} --login`,
    login: loginResult,
    claudeSync,
    bridges,
  };
}

export async function listAccounts({
  probe = false,
  agyBin,
  env = process.env,
} = {}) {
  const listed = listPersistedAccounts(env);
  if (!probe) {
    return {
      ok: true,
      action: "list",
      ...listed,
    };
  }

  const enriched = [];
  for (const acct of listed.accounts) {
    const client = new AgyAcpClient({
      agyBin: agyBin || env.AGY_BIN || "agy",
      account: acct.name,
      geminiDir: acct.geminiDir,
      appDataDir: acct.appDataDir,
      authMethod: acct.authMethod || undefined,
      env,
      usePersistedConfig: false,
      rpcTimeoutMs: 4000,
    });
    try {
      const discovery = await client.discoverModels({ forceRefresh: false, timeoutMs: 4000 });
      enriched.push({
        ...acct,
        authenticated: discovery.authenticated,
        modelSource: discovery.source,
        modelsCount: discovery.models.length,
        error: discovery.error || null,
      });
    } finally {
      await client.dispose();
    }
  }

  return {
    ok: true,
    action: "list",
    configPath: listed.configPath,
    activeAccount: listed.activeAccount,
    accounts: enriched,
  };
}

export async function useAccount(
  name,
  {
    env = process.env,
    claudeConfigDir,
    claudeHost,
    claudePort,
    codexHost,
    codexPort,
    dryRun = false,
  } = {},
) {
  const validName = validateAccountName(name);
  const beforeCfg = readPersistedAcpConfig(env);
  const knownDirs = collectKnownAccountDirs(beforeCfg, env);
  if (dryRun) {
    const target = beforeCfg.accounts?.[validName];
    if (!target) {
      throw new Error(`Account '${validName}' does not exist.`);
    }
    return {
      ok: true,
      dryRun: true,
      action: "use",
      activeAccount: validName,
      account: target,
    };
  }

  const switched = setActivePersistedAccount(validName, env);
  const claudeSync = syncClaudeSettingsAccountDir(switched.account, {
    claudeConfigDir,
    knownDirs,
    env,
    dryRun: false,
  });
  const bridges = await notifyBridgesAccountSwitch(switched.activeAccount, {
    claudeHost,
    claudePort,
    codexHost,
    codexPort,
  });

  return {
    ok: true,
    action: "use",
    configPath: switched.configPath,
    previousAccount: switched.previousAccount,
    activeAccount: switched.activeAccount,
    account: switched.account,
    claudeSync,
    bridges,
  };
}

export async function removeAccount(
  name,
  {
    purgeData = false,
    env = process.env,
    claudeConfigDir,
    claudeHost,
    claudePort,
    codexHost,
    codexPort,
    dryRun = false,
  } = {},
) {
  const validName = validateAccountName(name);
  const beforeCfg = readPersistedAcpConfig(env);
  const knownDirs = collectKnownAccountDirs(beforeCfg, env);
  if (dryRun) {
    if (!beforeCfg.accounts?.[validName]) {
      throw new Error(`Account '${validName}' does not exist.`);
    }
    return {
      ok: true,
      dryRun: true,
      action: "remove",
      name: validName,
      purgeData,
    };
  }

  const rm = removePersistedAccount(validName, { purgeData }, env);
  const claudeSync = rm.activeEntry
    ? syncClaudeSettingsAccountDir(rm.activeEntry, {
        claudeConfigDir,
        knownDirs,
        env,
        dryRun: false,
      })
    : null;
  const bridges = await notifyBridgesRefresh({
    claudeHost,
    claudePort,
    codexHost,
    codexPort,
  });

  return {
    ok: true,
    action: "remove",
    ...rm,
    claudeSync,
    bridges,
  };
}

function resolveTargetAccountForAuth(name, env) {
  const cfg = readPersistedAcpConfig(env);
  const requested = name ? validateAccountName(name) : cfg.activeAccount || "";
  if (requested && cfg.accounts?.[requested]) {
    return { cfg, entry: cfg.accounts[requested], isActive: requested === cfg.activeAccount };
  }
  if (name) {
    throw new Error(`Account '${requested}' does not exist. Add it first with 'agi account add ${requested}'.`);
  }
  return { cfg, entry: null, isActive: true };
}

export async function loginAccount(
  name = "",
  {
    method = "",
    agyBin,
    env = process.env,
    stdio = "inherit",
    claudeHost,
    claudePort,
    codexHost,
    codexPort,
  } = {},
) {
  const { entry, isActive } = resolveTargetAccountForAuth(name, env);
  const client = new AgyAcpClient({
    ...(agyBin ? { agyBin } : {}),
    ...(entry
      ? {
          account: entry.name,
          geminiDir: entry.geminiDir,
          appDataDir: entry.appDataDir,
          authMethod: entry.authMethod || undefined,
          usePersistedConfig: false,
        }
      : {}),
    env,
  });

  try {
    const normalizedMethod = String(method || "").trim();
    const methodMap = {
      "api-key": "gemini-api-key",
      enterprise: "oauth-business",
      vertex: "agent-platform",
    };
    const methodId = methodMap[normalizedMethod] || normalizedMethod;
    let res;
    if (methodId && methodId !== "oauth-personal" && methodId !== "google") {
      await client.authenticate(methodId, 10000);
      const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
      res = {
        ok: true,
        action: "login",
        account: entry?.name || client.account || null,
        dataDir: client.geminiDir || null,
        methodId,
        authenticated: discovery.authenticated,
        source: discovery.source,
        modelsCount: discovery.models.length,
      };
    } else {
      const loginRes = await client.loginInteractive({ stdio });
      res = {
        ok: loginRes.ok,
        action: "login",
        account: entry?.name || client.account || null,
        dataDir: client.geminiDir || null,
        command: loginRes.command,
        exitCode: loginRes.exitCode ?? null,
        authenticated: loginRes.discovery?.authenticated ?? null,
        source: loginRes.discovery?.source ?? null,
        modelsCount: loginRes.discovery?.models?.length ?? 0,
        error: loginRes.error || loginRes.discovery?.error || null,
      };
    }

    if (res.ok && isActive) {
      res.bridges = await notifyBridgesRefresh({
        claudeHost,
        claudePort,
        codexHost,
        codexPort,
      });
    }
    return res;
  } finally {
    await client.dispose();
  }
}

export async function logoutAccount(
  name = "",
  {
    agyBin,
    env = process.env,
    claudeHost,
    claudePort,
    codexHost,
    codexPort,
  } = {},
) {
  const { entry, isActive } = resolveTargetAccountForAuth(name, env);
  const client = new AgyAcpClient({
    ...(agyBin ? { agyBin } : {}),
    ...(entry
      ? {
          account: entry.name,
          geminiDir: entry.geminiDir,
          appDataDir: entry.appDataDir,
          authMethod: entry.authMethod || undefined,
          usePersistedConfig: false,
        }
      : {}),
    env,
  });

  try {
    const out = await client.logout(8000);
    const bridges =
      out.ok && isActive
        ? await notifyBridgesRefresh({
            claudeHost,
            claudePort,
            codexHost,
            codexPort,
          })
        : null;
    return {
      action: "logout",
      account: entry?.name || client.account || null,
      dataDir: client.geminiDir || null,
      loginCommand: client.formatLoginCommand(),
      ...out,
      ...(bridges ? { bridges } : {}),
    };
  } finally {
    await client.dispose();
  }
}

export async function accountStatus(
  name = "",
  { agyBin, env = process.env } = {},
) {
  const { entry, cfg } = resolveTargetAccountForAuth(name, env);
  const client = new AgyAcpClient({
    ...(agyBin ? { agyBin } : {}),
    ...(entry
      ? {
          account: entry.name,
          geminiDir: entry.geminiDir,
          appDataDir: entry.appDataDir,
          authMethod: entry.authMethod || undefined,
          usePersistedConfig: false,
        }
      : {}),
    env,
    rpcTimeoutMs: 5000,
  });

  try {
    const discovery = await client.discoverModels({ forceRefresh: false, timeoutMs: 5000 });
    return {
      ok: true,
      action: "status",
      configPath: resolveAcpConfigPath(env),
      activeAccount: cfg.activeAccount || null,
      ...client.getAuthInfo(),
      authenticated: discovery.authenticated,
      modelSource: discovery.source,
      modelsCount: discovery.models.length,
      error: discovery.error || null,
    };
  } finally {
    await client.dispose();
  }
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
