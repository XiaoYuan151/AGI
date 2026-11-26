import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgyAcpClient,
  FileAccountStore,
  expandHomePath,
  normalizeAuthMethodId,
  resolveAcpConfigPath,
  resolveAgiHome,
  resolveDefaultAccountDataDir,
  runAgyInteractiveLogin,
  validateAccountName,
} from "../core/index.mjs";

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

export class BridgeNotifier {
  constructor({ env = process.env, postJson = postBridgeJson } = {}) {
    this.env = env;
    this.postJson = postJson;
  }

  _targets(overrides = {}) {
    return {
      claudeHost: overrides.claudeHost || this.env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_HOST,
      claudePort: Number(overrides.claudePort || this.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_PORT),
      codexHost: overrides.codexHost || this.env.AGY_CODEX_HOST || DEFAULT_CODEX_HOST,
      codexPort: Number(overrides.codexPort || this.env.AGY_CODEX_PORT || DEFAULT_CODEX_PORT),
    };
  }

  async notifyAccountSwitch(name, overrides = {}) {
    const { claudeHost, claudePort, codexHost, codexPort } = this._targets(overrides);
    const [claude, codex] = await Promise.all([
      this.postJson(claudeHost, claudePort, "/v1/accounts/switch", { name }),
      this.postJson(codexHost, codexPort, "/v1/accounts/switch", { name }),
    ]);
    return { claude, codex };
  }

  async notifyRefresh(overrides = {}) {
    const { claudeHost, claudePort, codexHost, codexPort } = this._targets(overrides);
    const [claude, codex] = await Promise.all([
      this.postJson(claudeHost, claudePort, "/v1/refresh?restart=1"),
      this.postJson(codexHost, codexPort, "/v1/refresh?restart=1"),
    ]);
    return { claude, codex };
  }
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
  const resolvedKnown = new Set(knownDirs.filter(Boolean).map((d) => path.resolve(d)));
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

/**
 * Multi-account orchestration service (SRP + DIP).
 */
export class AccountService {
  constructor({
    env = process.env,
    accountStore,
    clientFactory,
    bridgeNotifier,
    claudeSettingsSync = syncClaudeSettingsAccountDir,
    loginRunner = runAgyInteractiveLogin,
  } = {}) {
    this.env = env;
    this.accountStore = accountStore || new FileAccountStore({ env });
    this.clientFactory =
      clientFactory || ((opts) => new AgyAcpClient({ env: this.env, ...opts }));
    this.bridgeNotifier = bridgeNotifier || new BridgeNotifier({ env });
    this.claudeSettingsSync = claudeSettingsSync;
    this.loginRunner = loginRunner;
  }

  _resolveTargetForAuth(name) {
    const cfg = this.accountStore.readConfig();
    const requested = name ? validateAccountName(name) : cfg.activeAccount || "";
    if (requested && cfg.accounts?.[requested]) {
      return { cfg, entry: cfg.accounts[requested], isActive: requested === cfg.activeAccount };
    }
    if (name) {
      throw new Error(
        `Account '${requested}' does not exist. Add it first with 'agi account add ${requested}'.`,
      );
    }
    return { cfg, entry: null, isActive: true };
  }

  async add({
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
    stdio = "inherit",
    claudeConfigDir,
    claudeHost,
    claudePort,
    codexHost,
    codexPort,
    dryRun = false,
  } = {}) {
    const validName = validateAccountName(name);
    const beforeCfg = this.accountStore.readConfig();
    const knownDirs = collectKnownAccountDirs(beforeCfg, this.env);

    if (dryRun) {
      const existing = beforeCfg.accounts?.[validName];
      const resolvedDir =
        expandHomePath(dataDir || geminiDir || "") ||
        existing?.geminiDir ||
        resolveDefaultAccountDataDir(validName, this.env);
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

    const res = this.accountStore.upsert({
      name: validName,
      dataDir,
      geminiDir,
      appDataDir,
      authMethod,
      label,
      activate,
      force,
    });

    let loginResult = null;
    if (login) {
      const resolvedBin = agyBin || this.env.AGY_BIN || "agy";
      const methodId = normalizeAuthMethodId(method, "");
      if (methodId && methodId !== "oauth-personal") {
        const client = this.clientFactory({
          agyBin: resolvedBin,
          account: res.account.name,
          geminiDir: res.account.geminiDir,
          appDataDir: res.account.appDataDir,
          authMethod: res.account.authMethod || undefined,
          env: this.env,
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
        loginResult = await this.loginRunner({
          agyBin: resolvedBin,
          geminiDir: res.account.geminiDir,
          appDataDir: res.account.appDataDir,
          env: this.env,
          stdio,
        });
      }
    }

    let claudeSync = null;
    let bridges = null;
    if (res.activeAccount === res.account.name) {
      claudeSync = this.claudeSettingsSync(res.account, {
        claudeConfigDir,
        knownDirs,
        env: this.env,
        dryRun: false,
      });
      bridges = await this.bridgeNotifier.notifyAccountSwitch(res.account.name, {
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
      loginCommand: `${agyBin || this.env.AGY_BIN || "agy"} acp${
        res.account.geminiDir ? ` --gemini-dir ${res.account.geminiDir}` : ""
      }${res.account.appDataDir ? ` --app-data-dir ${res.account.appDataDir}` : ""} --login`,
      login: loginResult,
      claudeSync,
      bridges,
    };
  }

  async list({ probe = false, agyBin } = {}) {
    const listed = this.accountStore.list();
    if (!probe) {
      return {
        ok: true,
        action: "list",
        ...listed,
      };
    }

    const enriched = [];
    for (const acct of listed.accounts) {
      const client = this.clientFactory({
        agyBin: agyBin || this.env.AGY_BIN || "agy",
        account: acct.name,
        geminiDir: acct.geminiDir,
        appDataDir: acct.appDataDir,
        authMethod: acct.authMethod || undefined,
        env: this.env,
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

  async use(
    name,
    { claudeConfigDir, claudeHost, claudePort, codexHost, codexPort, dryRun = false } = {},
  ) {
    const validName = validateAccountName(name);
    const beforeCfg = this.accountStore.readConfig();
    const knownDirs = collectKnownAccountDirs(beforeCfg, this.env);
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

    const switched = this.accountStore.setActive(validName);
    const claudeSync = this.claudeSettingsSync(switched.account, {
      claudeConfigDir,
      knownDirs,
      env: this.env,
      dryRun: false,
    });
    const bridges = await this.bridgeNotifier.notifyAccountSwitch(switched.activeAccount, {
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

  async remove(
    name,
    {
      purgeData = false,
      claudeConfigDir,
      claudeHost,
      claudePort,
      codexHost,
      codexPort,
      dryRun = false,
    } = {},
  ) {
    const validName = validateAccountName(name);
    const beforeCfg = this.accountStore.readConfig();
    const knownDirs = collectKnownAccountDirs(beforeCfg, this.env);
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

    const rm = this.accountStore.remove(validName, { purgeData });
    const claudeSync = rm.activeEntry
      ? this.claudeSettingsSync(rm.activeEntry, {
          claudeConfigDir,
          knownDirs,
          env: this.env,
          dryRun: false,
        })
      : null;
    const bridges = await this.bridgeNotifier.notifyRefresh({
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

  async login(
    name = "",
    { method = "", agyBin, stdio = "inherit", claudeHost, claudePort, codexHost, codexPort } = {},
  ) {
    const { entry, isActive } = this._resolveTargetForAuth(name);
    const client = this.clientFactory({
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
      env: this.env,
    });

    try {
      const methodId = normalizeAuthMethodId(method, "");
      let res;
      if (methodId && methodId !== "oauth-personal") {
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
        res.bridges = await this.bridgeNotifier.notifyRefresh({
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

  async logout(name = "", { agyBin, claudeHost, claudePort, codexHost, codexPort } = {}) {
    const { entry, isActive } = this._resolveTargetForAuth(name);
    const client = this.clientFactory({
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
      env: this.env,
    });

    try {
      const out = await client.logout(8000);
      const bridges =
        out.ok && isActive
          ? await this.bridgeNotifier.notifyRefresh({
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

  async status(name = "", { agyBin } = {}) {
    const { entry, cfg } = this._resolveTargetForAuth(name);
    const client = this.clientFactory({
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
      env: this.env,
      rpcTimeoutMs: 5000,
    });

    try {
      const discovery = await client.discoverModels({ forceRefresh: false, timeoutMs: 5000 });
      return {
        ok: true,
        action: "status",
        configPath: resolveAcpConfigPath(this.env),
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
}
