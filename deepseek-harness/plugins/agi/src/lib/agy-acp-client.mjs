import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

export function resolveAgiHome(env = process.env) {
  if (env.AGI_HOME && String(env.AGI_HOME).trim()) {
    return path.resolve(String(env.AGI_HOME).trim());
  }
  return path.join(os.homedir(), ".agi");
}

export function expandHomePath(inputPath) {
  if (typeof inputPath !== "string") return "";
  const trimmed = inputPath.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function validateAccountName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (
    !trimmed ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/.test(trimmed) ||
    trimmed.includes("..")
  ) {
    throw new Error(
      `Invalid account name '${String(name ?? "")}': expected 1-64 characters matching [a-zA-Z0-9._@-], starting with alphanumeric, without '..'.`,
    );
  }
  return trimmed;
}

export function resolveDefaultAccountDataDir(name, env = process.env) {
  const validName = validateAccountName(name);
  const home = resolveAgiHome(env);
  return validName === "default"
    ? path.join(home, "antigravity")
    : path.join(home, "accounts", validName);
}

export function resolveAcpConfigPath(env = process.env) {
  if (env.AGY_ACP_CONFIG === "0") return "";
  if (env.AGY_ACP_CONFIG && String(env.AGY_ACP_CONFIG).trim()) {
    return path.resolve(String(env.AGY_ACP_CONFIG).trim());
  }
  return path.join(resolveAgiHome(env), "acp.json");
}

function normalizeAccountEntry(name, rawEntry = {}) {
  const geminiDir = expandHomePath(
    typeof rawEntry?.dataDir === "string" && rawEntry.dataDir.trim()
      ? rawEntry.dataDir
      : typeof rawEntry?.geminiDir === "string"
        ? rawEntry.geminiDir
        : "",
  );
  const appDataDir =
    typeof rawEntry?.appDataDir === "string" ? rawEntry.appDataDir.trim() : "";
  const authMethod =
    typeof rawEntry?.authMethod === "string" ? rawEntry.authMethod.trim() : "";
  const label = typeof rawEntry?.label === "string" ? rawEntry.label.trim() : "";
  return {
    name,
    label,
    dataDir: geminiDir,
    geminiDir,
    appDataDir,
    authMethod,
    ...(typeof rawEntry?.createdAt === "string" ? { createdAt: rawEntry.createdAt } : {}),
    ...(typeof rawEntry?.updatedAt === "string" ? { updatedAt: rawEntry.updatedAt } : {}),
  };
}

export function normalizePersistedAcpConfig(raw = {}, env = process.env) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      version: 2,
      activeAccount: "",
      geminiDir: "",
      appDataDir: "",
      authMethod: "",
      accounts: {},
    };
  }

  const accounts = {};
  const hasAccountsObj =
    raw.accounts && typeof raw.accounts === "object" && !Array.isArray(raw.accounts);

  if (hasAccountsObj) {
    for (const [rawKey, rawVal] of Object.entries(raw.accounts)) {
      if (!rawVal || typeof rawVal !== "object" || Array.isArray(rawVal)) continue;
      let validName;
      try {
        validName = validateAccountName(rawKey);
      } catch {
        continue;
      }
      accounts[validName] = normalizeAccountEntry(validName, rawVal);
    }
  } else {
    const legacyGeminiDir =
      typeof raw.geminiDir === "string" ? expandHomePath(raw.geminiDir) : "";
    const legacyAppDataDir =
      typeof raw.appDataDir === "string" ? raw.appDataDir.trim() : "";
    const legacyAuthMethod =
      typeof raw.authMethod === "string" ? raw.authMethod.trim() : "";
    if (legacyGeminiDir || legacyAppDataDir || legacyAuthMethod) {
      const legacyName =
        typeof raw.activeAccount === "string" && raw.activeAccount.trim()
          ? raw.activeAccount.trim()
          : "default";
      accounts[legacyName] = normalizeAccountEntry(legacyName, {
        geminiDir: legacyGeminiDir,
        appDataDir: legacyAppDataDir,
        authMethod: legacyAuthMethod,
      });
    }
  }

  let activeAccount =
    typeof raw.activeAccount === "string" ? raw.activeAccount.trim() : "";
  if (activeAccount && !accounts[activeAccount]) {
    activeAccount = "";
  }
  const names = Object.keys(accounts);
  if (!activeAccount && names.length > 0) {
    activeAccount = accounts.default ? "default" : names.sort()[0];
  }

  const activeEntry = activeAccount ? accounts[activeAccount] : null;
  const geminiDir = activeEntry
    ? activeEntry.geminiDir
    : typeof raw.geminiDir === "string"
      ? expandHomePath(raw.geminiDir)
      : "";
  const appDataDir = activeEntry
    ? activeEntry.appDataDir
    : typeof raw.appDataDir === "string"
      ? raw.appDataDir.trim()
      : "";
  const authMethod = activeEntry
    ? activeEntry.authMethod
    : typeof raw.authMethod === "string"
      ? raw.authMethod.trim()
      : "";

  return {
    version: 2,
    activeAccount,
    geminiDir,
    appDataDir,
    authMethod,
    accounts,
  };
}

export function readPersistedAcpConfig(env = process.env) {
  const cfgPath = resolveAcpConfigPath(env);
  if (!cfgPath) return normalizePersistedAcpConfig({}, env);
  try {
    if (!fs.existsSync(cfgPath)) return normalizePersistedAcpConfig({}, env);
    const raw = fs.readFileSync(cfgPath, "utf8").trim();
    if (!raw) return normalizePersistedAcpConfig({}, env);
    const parsed = JSON.parse(raw);
    return normalizePersistedAcpConfig(parsed, env);
  } catch {
    return normalizePersistedAcpConfig({}, env);
  }
}

export function writePersistedAcpConfig(config, env = process.env) {
  const cfgPath = resolveAcpConfigPath(env);
  if (!cfgPath) {
    throw new Error("Persisted ACP config is disabled (AGY_ACP_CONFIG=0).");
  }
  const normalized = normalizePersistedAcpConfig(config, env);
  const dir = path.dirname(cfgPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore chmod failures on restricted filesystems
  }
  const tmpPath = `${cfgPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, cfgPath);
  try {
    fs.chmodSync(cfgPath, 0o600);
  } catch {
    // ignore
  }
  return { configPath: cfgPath, config: normalized };
}

function sortAccountNames(names) {
  return [...names].sort((a, b) => {
    if (a === "default" && b !== "default") return -1;
    if (b === "default" && a !== "default") return 1;
    return a.localeCompare(b);
  });
}

export function listPersistedAccounts(env = process.env) {
  const configPath = resolveAcpConfigPath(env);
  const config = readPersistedAcpConfig(env);
  const names = sortAccountNames(Object.keys(config.accounts || {}));
  const accounts = names.map((name) => {
    const entry = config.accounts[name];
    return {
      ...entry,
      active: name === config.activeAccount,
      dirExists: Boolean(entry.geminiDir && fs.existsSync(entry.geminiDir)),
    };
  });
  return {
    configPath,
    activeAccount: config.activeAccount || "",
    accounts,
  };
}

export function upsertPersistedAccount(
  {
    name,
    dataDir,
    geminiDir,
    appDataDir,
    authMethod,
    label,
    activate = true,
    force = false,
    useDefaultGeminiDir = false,
  } = {},
  env = process.env,
) {
  const validName = validateAccountName(name);
  const config = readPersistedAcpConfig(env);
  const existing = config.accounts[validName] || null;

  const rawDirInput =
    typeof dataDir === "string" && dataDir.trim()
      ? dataDir
      : typeof geminiDir === "string" && geminiDir.trim()
        ? geminiDir
        : "";
  const targetDir = rawDirInput
    ? expandHomePath(rawDirInput)
    : useDefaultGeminiDir
      ? ""
      : existing?.geminiDir || resolveDefaultAccountDataDir(validName, env);

  const resolvedAppDataDir =
    appDataDir !== undefined
      ? String(appDataDir).trim()
      : existing?.appDataDir || "antigravity-acp";
  const resolvedAuthMethod =
    authMethod !== undefined
      ? String(authMethod).trim()
      : existing?.authMethod || "";
  const resolvedLabel =
    label !== undefined ? String(label).trim() : existing?.label || "";

  if (!force && targetDir) {
    const resolvedTarget = path.resolve(targetDir);
    for (const [otherName, other] of Object.entries(config.accounts)) {
      if (otherName === validName || !other?.geminiDir) continue;
      if (
        path.resolve(other.geminiDir) === resolvedTarget &&
        (other.appDataDir || "") === resolvedAppDataDir
      ) {
        throw new Error(
          `Data folder '${resolvedTarget}' (appDataDir='${resolvedAppDataDir}') is already used by account '${otherName}'. Pass a different --data-dir or --force to share.`,
        );
      }
    }
  }

  const nowIso = new Date().toISOString();
  const entry = {
    name: validName,
    label: resolvedLabel,
    dataDir: targetDir,
    geminiDir: targetDir,
    appDataDir: resolvedAppDataDir,
    authMethod: resolvedAuthMethod,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  if (targetDir) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(targetDir, 0o700);
    } catch {
      // ignore
    }
    const metaPath = path.join(targetDir, ".agi-account.json");
    fs.writeFileSync(metaPath, `${JSON.stringify(entry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  config.accounts[validName] = entry;
  if (activate !== false || !config.activeAccount) {
    config.activeAccount = validName;
  }

  const written = writePersistedAcpConfig(config, env);
  return {
    configPath: written.configPath,
    account: written.config.accounts[validName],
    activeAccount: written.config.activeAccount,
    config: written.config,
  };
}

export function setActivePersistedAccount(name, env = process.env) {
  const validName = validateAccountName(name);
  const config = readPersistedAcpConfig(env);
  const entry = config.accounts[validName];
  if (!entry) {
    const available = sortAccountNames(Object.keys(config.accounts || {}));
    throw new Error(
      `Account '${validName}' does not exist.${
        available.length > 0 ? ` Available accounts: ${available.join(", ")}` : ""
      }`,
    );
  }
  const previousAccount = config.activeAccount || "";
  config.activeAccount = validName;
  const written = writePersistedAcpConfig(config, env);
  return {
    configPath: written.configPath,
    previousAccount,
    activeAccount: validName,
    account: written.config.accounts[validName],
    config: written.config,
  };
}

export function removePersistedAccount(
  name,
  { purgeData = false } = {},
  env = process.env,
) {
  const validName = validateAccountName(name);
  const config = readPersistedAcpConfig(env);
  const entry = config.accounts[validName];
  if (!entry) {
    const available = sortAccountNames(Object.keys(config.accounts || {}));
    throw new Error(
      `Account '${validName}' does not exist.${
        available.length > 0 ? ` Available accounts: ${available.join(", ")}` : ""
      }`,
    );
  }

  delete config.accounts[validName];
  const remainingNames = sortAccountNames(Object.keys(config.accounts));
  if (config.activeAccount === validName) {
    config.activeAccount = remainingNames[0] || "";
  }
  if (remainingNames.length === 0) {
    config.geminiDir = "";
    config.appDataDir = "";
    config.authMethod = "";
  }

  let didPurge = false;
  if (purgeData && entry.geminiDir) {
    const resolvedTarget = path.resolve(entry.geminiDir);
    const agiHome = path.resolve(resolveAgiHome(env));
    const userHome = path.resolve(os.homedir());
    const fsRoot = path.parse(resolvedTarget).root;
    const accountsRoot = path.join(agiHome, "accounts");
    if (
      resolvedTarget === fsRoot ||
      resolvedTarget === userHome ||
      resolvedTarget === agiHome ||
      resolvedTarget === accountsRoot
    ) {
      throw new Error(
        `Refusing to purge protected directory '${resolvedTarget}' for account '${validName}'.`,
      );
    }
    const stillUsedByAnother = remainingNames.some(
      (other) =>
        config.accounts[other]?.geminiDir &&
        path.resolve(config.accounts[other].geminiDir) === resolvedTarget,
    );
    if (!stillUsedByAnother && fs.existsSync(resolvedTarget)) {
      fs.rmSync(resolvedTarget, { recursive: true, force: true });
      didPurge = true;
    }
  }

  const written = writePersistedAcpConfig(config, env);
  const activeEntry = written.config.activeAccount
    ? written.config.accounts[written.config.activeAccount] || null
    : null;
  return {
    configPath: written.configPath,
    removed: entry,
    purgedData: didPurge,
    activeAccount: written.config.activeAccount,
    activeEntry,
    config: written.config,
  };
}

export function resolveAccountProfile({
  account,
  geminiDir,
  appDataDir,
  authMethod,
  env = process.env,
  usePersistedConfig = true,
} = {}) {
  const persisted = usePersistedConfig
    ? readPersistedAcpConfig(env)
    : normalizePersistedAcpConfig({}, env);
  const requestedAccount = String(
    account ?? env.AGY_ACCOUNT ?? persisted.activeAccount ?? "",
  ).trim();
  const accountEntry =
    requestedAccount && persisted.accounts?.[requestedAccount]
      ? persisted.accounts[requestedAccount]
      : null;

  const resolvedGeminiDir = expandHomePath(
    String(
      geminiDir ??
        env.AGY_GEMINI_DIR ??
        accountEntry?.geminiDir ??
        persisted.geminiDir ??
        "",
    ),
  );
  const resolvedAppDataDir = String(
    appDataDir ??
      env.AGY_APP_DATA_DIR ??
      accountEntry?.appDataDir ??
      persisted.appDataDir ??
      "",
  ).trim();
  const resolvedAuthMethod = String(
    authMethod ??
      env.AGY_AUTH_METHOD ??
      accountEntry?.authMethod ??
      persisted.authMethod ??
      "",
  ).trim();

  return {
    account: requestedAccount,
    accountEntry,
    geminiDir: resolvedGeminiDir,
    appDataDir: resolvedAppDataDir,
    authMethod: resolvedAuthMethod,
    activeAccount: persisted.activeAccount || "",
    accounts: persisted.accounts || {},
  };
}

export function buildLoginCommandArgs({ geminiDir = "", appDataDir = "" } = {}) {
  const args = ["acp"];
  if (typeof geminiDir === "string" && geminiDir.trim()) {
    args.push("--gemini-dir", geminiDir.trim());
  }
  if (typeof appDataDir === "string" && appDataDir.trim()) {
    args.push("--app-data-dir", appDataDir.trim());
  }
  args.push("--login");
  return args;
}

export function runAgyInteractiveLogin({
  agyBin = "agy",
  geminiDir = "",
  appDataDir = "",
  env = process.env,
  cwd = process.cwd(),
  stdio = "inherit",
} = {}) {
  const args = buildLoginCommandArgs({ geminiDir, appDataDir });
  const command = [agyBin, ...args].join(" ");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ command, bin: agyBin, args, ...result });
    };
    let child;
    try {
      child = spawn(agyBin, args, { cwd, env, stdio });
    } catch (err) {
      finish({ ok: false, exitCode: null, signal: null, error: err.message });
      return;
    }
    child.once("error", (err) => {
      finish({ ok: false, exitCode: null, signal: null, error: err.message });
    });
    child.once("exit", (code, signal) => {
      finish({
        ok: code === 0,
        exitCode: code,
        signal: signal ?? null,
        ...(code === 0 ? {} : { error: `${command} exited with code ${code ?? "null"}` }),
      });
    });
  });
}

export const DEFAULT_FALLBACK_MODELS = Object.freeze([
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Antigravity ACP default reasoning and coding model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsImages: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast Antigravity ACP coding and chat model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsImages: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    description: "Lightweight high-throughput Antigravity ACP model",
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    supportsImages: true,
    efforts: ["low", "medium"],
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    description: "Balanced Antigravity ACP multimodal model",
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    supportsImages: true,
    efforts: ["low", "medium"],
  },
]);

export class AgyAuthRequiredError extends Error {
  constructor(message, authMethods = []) {
    super(message);
    this.name = "AgyAuthRequiredError";
    this.code = -32000;
    this.authMethods = authMethods;
  }
}

export class AgyPolicyCooldownError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);
    this.name = "AgyPolicyCooldownError";
    this.code = 403;
    this.retryAfterMs = retryAfterMs;
  }
}

export function normalizeModelId(rawId) {
  if (typeof rawId !== "string") return "";
  let id = rawId.trim();
  for (const prefix of ["anthropic-agy/", "antigravity/", "agy/"]) {
    if (id.toLowerCase().startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  return id.trim();
}

export function resolveModelsCachePath(env = process.env) {
  if (!resolveAcpConfigPath(env)) return "";
  return path.join(resolveAgiHome(env), "models-cache.json");
}

function readModelsCacheFile(env = process.env) {
  const cachePath = resolveModelsCachePath(env);
  if (!cachePath) return { version: 1, entries: {} };
  try {
    if (!fs.existsSync(cachePath)) return { version: 1, entries: {} };
    const raw = fs.readFileSync(cachePath, "utf8").trim();
    if (!raw) return { version: 1, entries: {} };
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.entries &&
      typeof parsed.entries === "object" &&
      !Array.isArray(parsed.entries)
    ) {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    // Ignore corrupt cache files
  }
  return { version: 1, entries: {} };
}

function writeModelsCacheFile(cache, env = process.env) {
  const cachePath = resolveModelsCachePath(env);
  if (!cachePath) return false;
  let tmpPath = "";
  try {
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
    tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, cachePath);
    tmpPath = "";
    try {
      fs.chmodSync(cachePath, 0o600);
    } catch {
      // ignore
    }
    return true;
  } catch {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
    return false;
  }
}

export function readCachedDiscovery(cacheKey, env = process.env) {
  if (!cacheKey) return null;
  const cache = readModelsCacheFile(env);
  const entry = cache.entries?.[cacheKey];
  if (!entry || typeof entry !== "object") return null;
  if (!Array.isArray(entry.models) || entry.models.length === 0) {
    return null;
  }
  const hasRealEntry = entry.models.every(
    (m) => m && typeof m === "object" && typeof m.id === "string",
  );
  if (!hasRealEntry) return null;
  const models = parseFallbackModels(entry.models);
  if (!Array.isArray(models) || models.length === 0) return null;

  return {
    models: models.map((m) => ({ ...m, efforts: [...(m.efforts || [])] })),
    source: "acp",
    authenticated: entry.authenticated === true ? true : null,
    modelConfigId: typeof entry.modelConfigId === "string" ? entry.modelConfigId : null,
    currentModelId:
      typeof entry.currentModelId === "string" ? entry.currentModelId : models[0]?.id || null,
    effortConfig:
      entry.effortConfig && typeof entry.effortConfig === "object" ? entry.effortConfig : null,
    agentInfo: entry.agentInfo && typeof entry.agentInfo === "object" ? entry.agentInfo : null,
    authMethods: Array.isArray(entry.authMethods) ? entry.authMethods : [],
  };
}

export function writeCachedDiscovery(cacheKey, discovery, env = process.env) {
  if (
    !cacheKey ||
    !discovery ||
    discovery.source !== "acp" ||
    !Array.isArray(discovery.models) ||
    discovery.models.length === 0
  ) {
    return false;
  }
  const cache = readModelsCacheFile(env);
  cache.entries[cacheKey] = {
    updatedAt: Date.now(),
    authenticated: discovery.authenticated === true,
    modelConfigId: discovery.modelConfigId || null,
    currentModelId: discovery.currentModelId || discovery.models[0]?.id || null,
    effortConfig: discovery.effortConfig || null,
    agentInfo: discovery.agentInfo || null,
    authMethods: Array.isArray(discovery.authMethods) ? discovery.authMethods : [],
    models: discovery.models.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      supportsImages: m.supportsImages,
      efforts: [...(m.efforts || [])],
    })),
  };
  return writeModelsCacheFile(cache, env);
}

export function clearCachedDiscoveryEntry(cacheKey, env = process.env) {
  if (!cacheKey) return false;
  const cachePath = resolveModelsCachePath(env);
  if (!cachePath || !fs.existsSync(cachePath)) return false;
  const cache = readModelsCacheFile(env);
  if (!cache.entries?.[cacheKey]) return false;
  delete cache.entries[cacheKey];
  return writeModelsCacheFile(cache, env);
}

export function parseFallbackModels(rawValue) {
  if (Array.isArray(rawValue) && rawValue.length > 0) {
    const mapped = rawValue
      .map((item) => {
        if (typeof item === "string") {
          const id = normalizeModelId(item);
          return id
            ? {
                id,
                name: id,
                description: "Antigravity ACP model",
                contextWindow: 1000000,
                maxOutputTokens: 65536,
                supportsImages: true,
                efforts: ["low", "medium", "high"],
              }
            : null;
        }
        if (item && typeof item === "object" && typeof item.id === "string") {
          const id = normalizeModelId(item.id);
          if (!id) return null;
          return {
            id,
            name: typeof item.name === "string" && item.name ? item.name : id,
            description:
              typeof item.description === "string"
                ? item.description
                : "Antigravity ACP model",
            contextWindow:
              typeof item.contextWindow === "number" ? item.contextWindow : 1000000,
            maxOutputTokens:
              typeof item.maxOutputTokens === "number" ? item.maxOutputTokens : 65536,
            supportsImages: item.supportsImages !== false,
            efforts: Array.isArray(item.efforts)
              ? item.efforts.map(String)
              : ["low", "medium", "high"],
          };
        }
        return null;
      })
      .filter(Boolean);
    if (mapped.length > 0) return mapped;
  }

  if (!rawValue || typeof rawValue !== "string" || !rawValue.trim()) {
    return DEFAULT_FALLBACK_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
  }
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("[")) {
    try {
      return parseFallbackModels(JSON.parse(trimmed));
    } catch {
      // Fall through to comma-separated parser
    }
  }

  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return DEFAULT_FALLBACK_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
  }

  return parts.map((entry) => {
    const colonIdx = entry.indexOf(":");
    const id = normalizeModelId(colonIdx === -1 ? entry : entry.slice(0, colonIdx));
    const name = colonIdx === -1 ? id : entry.slice(colonIdx + 1).trim() || id;
    return {
      id,
      name,
      description: "Antigravity ACP model",
      contextWindow: 1000000,
      maxOutputTokens: 65536,
      supportsImages: true,
      efforts: ["low", "medium", "high"],
    };
  });
}

function flattenSelectOptions(options) {
  if (!Array.isArray(options)) return [];
  const out = [];
  for (const item of options) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.options)) {
      for (const nested of item.options) {
        if (nested && typeof nested === "object" && nested.value != null) {
          out.push(nested);
        }
      }
    } else if (item.value != null) {
      out.push(item);
    }
  }
  return out;
}

export function extractEffortConfigFromSessionResult(result) {
  const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const opt = configOptions.find(
    (entry) =>
      entry &&
      entry.type === "select" &&
      (entry.category === "thought_level" ||
        ["thought_level", "reasoning_effort", "effort", "thinking"].includes(
          String(entry.id || "").toLowerCase(),
        )),
  );
  if (!opt) return null;
  const values = flattenSelectOptions(opt.options).map((o) => ({
    value: String(o.value),
    name: typeof o.name === "string" && o.name ? o.name : String(o.value),
    description: typeof o.description === "string" ? o.description : "",
  }));
  return {
    configId: String(opt.id),
    currentValue: opt.currentValue != null ? String(opt.currentValue) : undefined,
    options: values,
  };
}

export function extractModelsFromSessionResult(result) {
  const byId = new Map();
  let modelConfigId = null;
  let currentModelId = null;

  const effortConfig = extractEffortConfigFromSessionResult(result);
  const effortValues = effortConfig
    ? effortConfig.options.map((o) => o.value)
    : ["low", "medium", "high"];

  const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const modelOpt = configOptions.find(
    (entry) =>
      entry &&
      entry.type === "select" &&
      (entry.category === "model" || String(entry.id || "").toLowerCase() === "model"),
  );

  if (modelOpt) {
    modelConfigId = String(modelOpt.id);
    if (modelOpt.currentValue != null) {
      currentModelId = normalizeModelId(String(modelOpt.currentValue));
    }
    for (const item of flattenSelectOptions(modelOpt.options)) {
      const id = normalizeModelId(String(item.value));
      if (!id) continue;
      const meta = item._meta && typeof item._meta === "object" ? item._meta : {};
      byId.set(id, {
        id,
        name: typeof item.name === "string" && item.name ? item.name : id,
        description:
          typeof item.description === "string" && item.description
            ? item.description
            : "Antigravity ACP model",
        contextWindow:
          typeof meta.contextWindow === "number" ? meta.contextWindow : 1000000,
        maxOutputTokens:
          typeof meta.maxOutputTokens === "number" ? meta.maxOutputTokens : 65536,
        supportsImages: meta.supportsImages !== false,
        efforts: Array.isArray(meta.efforts)
          ? meta.efforts.map(String)
          : [...effortValues],
      });
    }
  }

  const hasConfigOptionModels = byId.size > 0;
  const knownEffortSuffixes = Array.from(
    new Set([
      ...effortValues.map((v) => String(v).toLowerCase()),
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
  ).sort((a, b) => b.length - a.length);
  const matchedEffortsByBase = new Map();

  const legacyModels = result?.models;
  if (legacyModels && typeof legacyModels === "object") {
    if (!currentModelId && typeof legacyModels.currentModelId === "string") {
      currentModelId = normalizeModelId(legacyModels.currentModelId);
    }
    const available = Array.isArray(legacyModels.availableModels)
      ? legacyModels.availableModels
      : [];
    for (const item of available) {
      if (!item || typeof item !== "object") continue;
      const rawId = item.modelId ?? item.id ?? item.value;
      if (typeof rawId !== "string") continue;
      const id = normalizeModelId(rawId);
      if (!id || byId.has(id)) continue;

      if (hasConfigOptionModels) {
        const lowerId = id.toLowerCase();
        let matchedBaseId = "";
        let matchedSuffix = "";
        for (const suffix of knownEffortSuffixes) {
          if (lowerId.endsWith(`-${suffix}`) && id.length > suffix.length + 1) {
            const candidateBase = id.slice(0, id.length - suffix.length - 1);
            if (byId.has(candidateBase)) {
              matchedBaseId = candidateBase;
              matchedSuffix = suffix;
              break;
            }
          }
        }
        if (matchedBaseId) {
          let set = matchedEffortsByBase.get(matchedBaseId);
          if (!set) {
            set = new Set();
            matchedEffortsByBase.set(matchedBaseId, set);
          }
          set.add(matchedSuffix);
          continue;
        }
      }

      byId.set(id, {
        id,
        name: typeof item.name === "string" && item.name ? item.name : id,
        description:
          typeof item.description === "string" && item.description
            ? item.description
            : "Antigravity ACP model",
        contextWindow:
          typeof item.contextWindow === "number" ? item.contextWindow : 1000000,
        maxOutputTokens:
          typeof item.maxOutputTokens === "number" ? item.maxOutputTokens : 65536,
        supportsImages: item.supportsImages !== false,
        efforts: [...effortValues],
      });
    }
  }

  for (const [baseId, matchedSet] of matchedEffortsByBase) {
    const model = byId.get(baseId);
    if (!model || matchedSet.size === 0) continue;
    const ordered = effortValues.filter((e) => matchedSet.has(String(e).toLowerCase()));
    const seenLower = new Set(ordered.map((e) => String(e).toLowerCase()));
    for (const extra of matchedSet) {
      if (!seenLower.has(extra)) {
        ordered.push(extra);
        seenLower.add(extra);
      }
    }
    if (ordered.length > 0) {
      model.efforts = ordered;
    }
  }

  return {
    modelConfigId,
    currentModelId,
    effortConfig,
    models: Array.from(byId.values()),
  };
}

function isAuthError(err) {
  if (!err) return false;
  if (err instanceof AgyAuthRequiredError) return true;
  if (err.code === -32000) return true;
  const msg = String(err.message || "");
  return /authentication required|not authenticated|sign in|login required/i.test(msg);
}

function isPolicyOrQuotaError(err) {
  if (!err) return false;
  if (err instanceof AgyPolicyCooldownError) return true;
  const code = Number(err.code);
  if (code === 403 || code === 429) return true;
  const msg = String(err.message || "");
  return /permission_denied|403|terms of service|account.*(?:disabled|suspended|banned)|service has been disabled|resource_exhausted|too many requests|rate.?limit/i.test(
    msg,
  );
}

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractTextFromContent).filter(Boolean).join("");
  }
  if (typeof content === "object") {
    if (content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    if (typeof content.text === "string") return content.text;
    if (content.content) return extractTextFromContent(content.content);
  }
  return "";
}

function selectPermissionOutcome(options, policy) {
  const list = Array.isArray(options) ? options : [];
  if (policy === "allow") {
    const allowOnce = list.find((o) => o?.kind === "allow_once");
    if (allowOnce) return { outcome: "selected", optionId: allowOnce.optionId };
    const allowAlways = list.find((o) => o?.kind === "allow_always");
    if (allowAlways) return { outcome: "selected", optionId: allowAlways.optionId };
    const fallbackAllow = list.find((o) =>
      String(o?.kind || o?.optionId || "").toLowerCase().includes("allow"),
    );
    if (fallbackAllow) return { outcome: "selected", optionId: fallbackAllow.optionId };
    if (list[0]?.optionId) return { outcome: "selected", optionId: list[0].optionId };
    return { outcome: "cancelled" };
  }

  const rejectOnce = list.find((o) => o?.kind === "reject_once");
  if (rejectOnce) return { outcome: "selected", optionId: rejectOnce.optionId };
  const rejectAlways = list.find((o) => o?.kind === "reject_always");
  if (rejectAlways) return { outcome: "selected", optionId: rejectAlways.optionId };
  return { outcome: "cancelled" };
}

export class AgyAcpClient {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this._usePersistedConfig = options.usePersistedConfig !== false;
    this._explicitAccount =
      options.account !== undefined ? String(options.account).trim() : "";
    this._explicitGeminiDir = options.geminiDir !== undefined;
    this._explicitAppDataDir = options.appDataDir !== undefined;
    this._explicitAuthMethod = options.authMethod !== undefined;

    const resolved = resolveAccountProfile({
      account: options.account,
      geminiDir: options.geminiDir,
      appDataDir: options.appDataDir,
      authMethod: options.authMethod,
      env: this.env,
      usePersistedConfig: this._usePersistedConfig,
    });

    this.agyBin = options.agyBin || this.env.AGY_BIN || "agy";
    this.account = resolved.account;
    this.geminiDir = resolved.geminiDir;
    this.appDataDir = resolved.appDataDir;
    this.sandbox =
      typeof options.sandbox === "boolean"
        ? options.sandbox
        : this.env.AGY_SANDBOX === "1";
    this.autoApprove =
      typeof options.autoApprove === "boolean"
        ? options.autoApprove
        : this.env.AGY_AUTO_APPROVE !== "0";
    this.authMethod = resolved.authMethod;
    this.defaultCwd = options.cwd || process.cwd();
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30000;
    this.discoveryTtlMs = options.discoveryTtlMs ?? 60000;
    this.authCooldownMs = options.authCooldownMs ?? 30000;
    this.policyCooldownMs = options.policyCooldownMs ?? 300000;
    this.maxSessions = options.maxSessions ?? 32;
    this.fallbackModels = Array.isArray(options.fallbackModels) && options.fallbackModels.length > 0
      ? options.fallbackModels
      : parseFallbackModels(this.env.AGY_FALLBACK_MODELS);

    const envExtraArgs =
      typeof this.env.AGY_ACP_ARGS === "string" && this.env.AGY_ACP_ARGS.trim()
        ? this.env.AGY_ACP_ARGS.trim().split(/\s+/)
        : [];
    this.extraArgs = Array.isArray(options.extraArgs)
      ? options.extraArgs
      : envExtraArgs;

    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pendingRequests = new Map();
    this.initPromise = null;
    this.initResult = null;
    this.authenticated = null;
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.discoveryPromise = null;
    this.lastError = null;
    this.lastPolicyError = null;
    this.authCooldownUntil = 0;
    this.policyCooldownUntil = 0;
    this.stderrTail = [];
    this.sessions = new Map();
    this.activeTurns = new Map();
    this.sessionQueues = new Map();
    this.disposed = false;
  }

  _buildArgs() {
    const args = ["acp"];
    if (this.geminiDir) {
      args.push("--gemini-dir", this.geminiDir);
    }
    if (this.appDataDir) {
      args.push("--app-data-dir", this.appDataDir);
    }
    if (this.sandbox) {
      args.push("--sandbox");
    }
    if (this.autoApprove) {
      args.push("--dangerously-skip-permissions");
    }
    if (this.extraArgs.length > 0) {
      args.push(...this.extraArgs);
    }
    return args;
  }

  getLoginCommand() {
    const args = buildLoginCommandArgs({
      geminiDir: this.geminiDir,
      appDataDir: this.appDataDir,
    });
    return {
      bin: this.agyBin,
      args,
      command: [this.agyBin, ...args].join(" "),
    };
  }

  formatLoginCommand() {
    return this.getLoginCommand().command;
  }

  _formatLoginCommand() {
    return this.formatLoginCommand();
  }

  clearCooldown() {
    this.authCooldownUntil = 0;
    this.policyCooldownUntil = 0;
    this.lastPolicyError = null;
  }

  getAuthInfo() {
    const login = this.getLoginCommand();
    return {
      authenticated: this.authenticated,
      authMethods: Array.isArray(this.initResult?.authMethods)
        ? this.initResult.authMethods
        : [],
      canLogout: Boolean(this.initResult?.agentCapabilities?.auth?.logout),
      loginCommand: login.command,
      loginBin: login.bin,
      loginArgs: login.args,
      agyBin: this.agyBin,
      account: this.account || null,
      dataDir: this.geminiDir || null,
      geminiDir: this.geminiDir || null,
      appDataDir: this.appDataDir || null,
      authMethod: this.authMethod || null,
      hasGeminiApiKey: Boolean(
        this.env.GEMINI_API_KEY && String(this.env.GEMINI_API_KEY).trim(),
      ),
    };
  }

  listAccounts() {
    const listed = listPersistedAccounts(this.env);
    return {
      ...listed,
      currentAccount: this.account || null,
      currentDataDir: this.geminiDir || null,
      accounts: listed.accounts.map((entry) => ({
        ...entry,
        isCurrent:
          Boolean(this.account && entry.name === this.account) ||
          Boolean(
            !this.account &&
              entry.geminiDir &&
              this.geminiDir &&
              path.resolve(entry.geminiDir) === path.resolve(this.geminiDir) &&
              (entry.appDataDir || "") === (this.appDataDir || ""),
          ),
      })),
    };
  }

  reloadPersistedConfig({ account } = {}) {
    if (!this._usePersistedConfig && account === undefined) {
      return {
        changed: false,
        account: this.account,
        dataDir: this.geminiDir,
        geminiDir: this.geminiDir,
        appDataDir: this.appDataDir,
        authMethod: this.authMethod,
      };
    }
    if (account !== undefined) {
      const nextAcct = String(account).trim();
      this._explicitAccount = nextAcct;
      const nextEnv = { ...this.env };
      if (nextAcct) {
        nextEnv.AGY_ACCOUNT = nextAcct;
      } else {
        delete nextEnv.AGY_ACCOUNT;
      }
      this.env = nextEnv;
    } else if (this._explicitAccount) {
      const cfg = readPersistedAcpConfig(this.env);
      if (!cfg.accounts?.[this._explicitAccount]) {
        this._explicitAccount = cfg.activeAccount || "";
        const nextEnv = { ...this.env };
        if (this._explicitAccount) {
          nextEnv.AGY_ACCOUNT = this._explicitAccount;
        } else {
          delete nextEnv.AGY_ACCOUNT;
        }
        this.env = nextEnv;
      }
    }
    const targetAccount =
      account !== undefined ? String(account).trim() : this._explicitAccount || undefined;
    const resolved = resolveAccountProfile({
      account: targetAccount,
      geminiDir: account === undefined && this._explicitGeminiDir ? this.geminiDir : undefined,
      appDataDir: account === undefined && this._explicitAppDataDir ? this.appDataDir : undefined,
      authMethod: account === undefined && this._explicitAuthMethod ? this.authMethod : undefined,
      env: this.env,
      usePersistedConfig: account !== undefined ? true : this._usePersistedConfig,
    });
    const changed =
      resolved.account !== this.account ||
      resolved.geminiDir !== this.geminiDir ||
      resolved.appDataDir !== this.appDataDir ||
      resolved.authMethod !== this.authMethod;
    this.account = resolved.account;
    this.geminiDir = resolved.geminiDir;
    this.appDataDir = resolved.appDataDir;
    this.authMethod = resolved.authMethod;
    if (changed) {
      this.authenticated = null;
      this.lastDiscovery = null;
      this.lastDiscoveryAt = 0;
      this.discoveryPromise = null;
    }
    return {
      changed,
      account: this.account,
      dataDir: this.geminiDir,
      geminiDir: this.geminiDir,
      appDataDir: this.appDataDir,
      authMethod: this.authMethod,
    };
  }

  async switchAccount(name, { persist = true } = {}) {
    const validName = validateAccountName(name);
    let entry;
    if (persist && this._usePersistedConfig) {
      entry = setActivePersistedAccount(validName, this.env).account;
    } else {
      const cfg = readPersistedAcpConfig(this.env);
      entry = cfg.accounts?.[validName];
      if (!entry) {
        throw new Error(`Account '${validName}' does not exist.`);
      }
    }

    const nextEnv = { ...this.env };
    delete nextEnv.AGY_GEMINI_DIR;
    delete nextEnv.AGY_APP_DATA_DIR;
    delete nextEnv.AGY_AUTH_METHOD;
    nextEnv.AGY_ACCOUNT = entry.name;
    this.env = nextEnv;

    this._explicitAccount = entry.name;
    this._explicitGeminiDir = false;
    this._explicitAppDataDir = false;
    this._explicitAuthMethod = false;
    this.account = entry.name;
    this.geminiDir = entry.geminiDir;
    this.appDataDir = entry.appDataDir;
    this.authMethod = entry.authMethod || "";
    this.authenticated = null;

    await this.restart();
    return {
      ok: true,
      account: entry.name,
      dataDir: entry.geminiDir,
      geminiDir: entry.geminiDir,
      appDataDir: entry.appDataDir,
      authMethod: entry.authMethod || "",
      loginCommand: this.formatLoginCommand(),
    };
  }

  async setApiKey(apiKey) {
    const nextKey = typeof apiKey === "string" ? apiKey.trim() : "";
    const prevKey =
      typeof this.env.GEMINI_API_KEY === "string" ? this.env.GEMINI_API_KEY.trim() : "";
    if (nextKey === prevKey) return false;
    const nextEnv = { ...this.env };
    if (nextKey) {
      nextEnv.GEMINI_API_KEY = nextKey;
    } else {
      delete nextEnv.GEMINI_API_KEY;
    }
    this.env = nextEnv;
    this.clearCooldown();
    await this.restart();
    return true;
  }

  async loginInteractive({ stdio = "inherit", cwd = this.defaultCwd } = {}) {
    const loginResult = await runAgyInteractiveLogin({
      agyBin: this.agyBin,
      geminiDir: this.geminiDir,
      appDataDir: this.appDataDir,
      env: this.env,
      cwd,
      stdio,
    });
    if (!loginResult.ok) {
      return { ...loginResult, discovery: null };
    }
    await this.restart();
    const discovery = await this.discoverModels({
      cwd,
      forceRefresh: true,
      timeoutMs: Math.max(8000, this.rpcTimeoutMs),
    });
    return { ...loginResult, discovery };
  }

  _ensureSpawned() {
    if (this.disposed) {
      throw new Error("AgyAcpClient has been disposed");
    }
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return;
    }

    const args = this._buildArgs();
    const child = spawn(this.agyBin, args, {
      cwd: this.defaultCwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = child;
    this.initResult = null;
    this.initPromise = null;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 40) {
          this.stderrTail.shift();
        }
      }
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.rl = rl;

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      this._handleIncoming(msg);
    });

    const onDisconnect = (reason) => {
      if (this.proc !== child) return;
      this.proc = null;
      this.initResult = null;
      this.initPromise = null;
      this.sessions.clear();
      try {
        rl.close();
      } catch {
        // ignore
      }
      this.rl = null;

      const err = reason instanceof Error ? reason : new Error(String(reason));
      this.lastError = err.message;
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingRequests.clear();
      this.activeTurns.clear();
    };

    child.on("error", (err) => {
      onDisconnect(
        new Error(`Failed to spawn '${this.agyBin} acp': ${err.message}`),
      );
    });

    child.on("exit", (code, signal) => {
      const detail = this.stderrTail.slice(-3).join(" | ");
      const msg = `agy acp exited (code=${code ?? "null"}, signal=${signal ?? "null"})${
        detail ? `: ${detail}` : ""
      }`;
      onDisconnect(new Error(msg));
    });
  }

  _writeMessage(payload) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("agy acp process is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _sendResponse(id, result) {
    this._writeMessage({ jsonrpc: "2.0", id, result });
  }

  _sendError(id, code, message) {
    this._writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  _sendNotification(method, params) {
    this._writeMessage({ jsonrpc: "2.0", method, params });
  }

  _request(method, params, timeoutMs = this.rpcTimeoutMs) {
    this._ensureSpawned();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(id);
              reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
      this.pendingRequests.set(id, { resolve, reject, timer, method });
      try {
        this._writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  _handleIncoming(msg) {
    if (!msg || typeof msg !== "object") return;

    // JSON-RPC response
    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || `ACP error (${pending.method})`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server -> Client RPC request
    if (msg.id !== undefined && msg.id !== null && typeof msg.method === "string") {
      if (msg.method === "session/request_permission") {
        const sessionId = msg.params?.sessionId;
        const turn = sessionId ? this.activeTurns.get(sessionId) : null;
        const policy = turn
          ? turn.permissionPolicy
          : this.autoApprove
            ? "allow"
            : "reject";
        const outcome = selectPermissionOutcome(msg.params?.options, policy);
        try {
          this._sendResponse(msg.id, { outcome });
        } catch {
          // ignore write failure if shutting down
        }
        return;
      }

      try {
        this._sendError(msg.id, -32601, `Unsupported client method: ${msg.method}`);
      } catch {
        // ignore
      }
      return;
    }

    // Notification
    if (typeof msg.method === "string" && msg.method === "session/update") {
      const params = msg.params || {};
      const sessionId = params.sessionId;
      const update = params.update;
      if (!update || typeof update !== "object") return;

      if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
        const extracted = extractModelsFromSessionResult({
          configOptions: update.configOptions,
        });
        if (extracted.models.length > 0 && this.lastDiscovery) {
          this.lastDiscovery = {
            ...this.lastDiscovery,
            models: extracted.models,
            modelConfigId: extracted.modelConfigId || this.lastDiscovery.modelConfigId,
            effortConfig: extracted.effortConfig || this.lastDiscovery.effortConfig,
          };
        }
      }

      const turn = sessionId ? this.activeTurns.get(sessionId) : null;
      if (turn) {
        turn.handleUpdate(update);
      }
    }
  }

  async initialize(timeoutMs = this.rpcTimeoutMs) {
    if (this.initResult) return this.initResult;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const result = await this._request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "agi-plugin-acp-bridge",
            version: "0.3.0",
          },
        },
        timeoutMs,
      );
      this.initResult = result || {};
      return this.initResult;
    })();

    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async authenticate(methodId, timeoutMs = this.rpcTimeoutMs) {
    await this.initialize(timeoutMs);
    const result = await this._request("authenticate", { methodId }, timeoutMs);
    this.authenticated = true;
    this.lastDiscoveryAt = 0;
    this.clearCooldown();
    return result;
  }

  async logout(timeoutMs = this.rpcTimeoutMs) {
    await this.initialize(timeoutMs);
    const supportsLogout = Boolean(this.initResult?.agentCapabilities?.auth?.logout);
    if (!supportsLogout) {
      return {
        ok: false,
        supported: false,
        message: "Connected agy acp server does not advertise auth.logout capability.",
      };
    }
    const sessionIds = Array.from(this.sessions.values()).map((s) => s.sessionId);
    this.sessions.clear();
    await Promise.all(sessionIds.map((id) => this._closeSessionBestEffort(id)));
    await this._request("logout", {}, timeoutMs);
    this.authenticated = false;
    this.clearCachedDiscovery();
    this.clearCooldown();
    return { ok: true, supported: true };
  }

  _resolveAutoAuthMethod() {
    if (this.authMethod) return this.authMethod;
    if (this.env.GEMINI_API_KEY && String(this.env.GEMINI_API_KEY).trim()) {
      return "gemini-api-key";
    }
    return "";
  }

  _tripPolicyCooldown(err) {
    const msg = String(err?.message || err || "Antigravity policy/quota error");
    this.lastPolicyError = msg;
    this.policyCooldownUntil = Date.now() + this.policyCooldownMs;
    return new AgyPolicyCooldownError(
      `Antigravity ACP paused for ${Math.ceil(this.policyCooldownMs / 1000)}s to prevent retry-loop abuse/bans: ${msg}`,
      this.policyCooldownMs,
    );
  }

  async _createSessionRaw(
    cwd,
    timeoutMs = this.rpcTimeoutMs,
    { bypassAuthCooldown = false } = {},
  ) {
    const now = Date.now();
    if (now < this.policyCooldownUntil) {
      const remaining = this.policyCooldownUntil - now;
      throw new AgyPolicyCooldownError(
        `Antigravity ACP is in safety cooldown (${Math.ceil(remaining / 1000)}s remaining) after: ${this.lastPolicyError || "policy/quota error"}`,
        remaining,
      );
    }

    if (!bypassAuthCooldown && now < this.authCooldownUntil && !this._resolveAutoAuthMethod()) {
      const methods = Array.isArray(this.initResult?.authMethods)
        ? this.initResult.authMethods
        : [];
      throw new AgyAuthRequiredError(
        `Antigravity ACP requires authentication. Run '${this._formatLoginCommand()}' or set GEMINI_API_KEY.`,
        methods,
      );
    }

    await this.initialize(timeoutMs);
    const tryNew = () =>
      this._request(
        "session/new",
        {
          cwd: cwd || this.defaultCwd,
          mcpServers: [],
        },
        timeoutMs,
      );

    try {
      const res = await tryNew();
      this.authenticated = true;
      this.authCooldownUntil = 0;
      return res;
    } catch (err) {
      if (isPolicyOrQuotaError(err)) {
        throw this._tripPolicyCooldown(err);
      }
      if (!isAuthError(err)) throw err;
      const methodId = this._resolveAutoAuthMethod();
      if (methodId) {
        try {
          await this.authenticate(methodId, timeoutMs);
          const retried = await tryNew();
          this.authenticated = true;
          this.authCooldownUntil = 0;
          return retried;
        } catch (retryErr) {
          if (isPolicyOrQuotaError(retryErr)) {
            throw this._tripPolicyCooldown(retryErr);
          }
          if (!isAuthError(retryErr)) throw retryErr;
        }
      }
      this.authenticated = false;
      this.authCooldownUntil = Date.now() + this.authCooldownMs;
      const methods = Array.isArray(this.initResult?.authMethods)
        ? this.initResult.authMethods
        : [];
      throw new AgyAuthRequiredError(
        `Antigravity ACP requires authentication. Run '${this._formatLoginCommand()}' or set GEMINI_API_KEY.`,
        methods,
      );
    }
  }

  async _closeSessionBestEffort(sessionId) {
    if (!sessionId || !this.proc) return;
    try {
      await this._request("session/close", { sessionId }, 2000);
    } catch {
      // Some ACP servers do not implement session/close or session already ended.
    }
  }

  _getModelsCacheKey() {
    return `${this.agyBin}::${this.geminiDir || "default"}::${this.appDataDir || "default"}`;
  }

  getCachedDiscovery() {
    if (this.lastDiscovery?.source === "acp" && this.lastDiscovery.models.length > 0) {
      return this.lastDiscovery;
    }
    if (!this._usePersistedConfig) return null;
    return readCachedDiscovery(this._getModelsCacheKey(), this.env);
  }

  clearCachedDiscovery() {
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.discoveryPromise = null;
    if (this._usePersistedConfig) {
      clearCachedDiscoveryEntry(this._getModelsCacheKey(), this.env);
    }
  }

  async discoverModels({ cwd, forceRefresh = false, timeoutMs = 20000 } = {}) {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.lastDiscovery &&
      now - this.lastDiscoveryAt < this.discoveryTtlMs
    ) {
      return this.lastDiscovery;
    }
    if (!forceRefresh && this.discoveryPromise) {
      return this.discoveryPromise;
    }

    const cacheKey = this._getModelsCacheKey();
    const run = (async () => {
      try {
        const sessionRes = await this._createSessionRaw(
          cwd || this.defaultCwd,
          timeoutMs,
          { bypassAuthCooldown: forceRefresh },
        );
        const sessionId = sessionRes?.sessionId;
        const extracted = extractModelsFromSessionResult(sessionRes);
        await this._closeSessionBestEffort(sessionId);

        const models =
          extracted.models.length > 0
            ? extracted.models
            : this.fallbackModels.map((m) => ({ ...m, efforts: [...(m.efforts || [])] }));

        this.lastError = null;
        this.lastDiscovery = {
          models,
          source: extracted.models.length > 0 ? "acp" : "fallback",
          authenticated: true,
          modelConfigId: extracted.modelConfigId,
          currentModelId: extracted.currentModelId || models[0]?.id || null,
          effortConfig: extracted.effortConfig,
          agentInfo: this.initResult?.agentInfo || null,
          authMethods: this.initResult?.authMethods || [],
        };
        this.lastDiscoveryAt = Date.now();
        if (this._usePersistedConfig && this.lastDiscovery.source === "acp") {
          writeCachedDiscovery(cacheKey, this.lastDiscovery, this.env);
        }
        return this.lastDiscovery;
      } catch (err) {
        this.lastError = err.message;

        if (isAuthError(err)) {
          if (this._usePersistedConfig) {
            clearCachedDiscoveryEntry(cacheKey, this.env);
          }
          this.authenticated = false;
          const fallback = {
            models: this.fallbackModels.map((m) => ({ ...m, efforts: [...(m.efforts || [])] })),
            source: "fallback",
            authenticated: false,
            modelConfigId: null,
            currentModelId: this.fallbackModels[0]?.id || null,
            effortConfig: null,
            agentInfo: this.initResult?.agentInfo || null,
            authMethods: this.initResult?.authMethods || [],
            error: err.message,
          };
          this.lastDiscovery = fallback;
          this.lastDiscoveryAt = Date.now();
          return fallback;
        }

        const prevAcp =
          this.lastDiscovery?.source === "acp"
            ? this.lastDiscovery
            : this._usePersistedConfig
              ? readCachedDiscovery(cacheKey, this.env)
              : null;

        if (isPolicyOrQuotaError(err)) {
          this.lastDiscovery = prevAcp
            ? {
                ...prevAcp,
                authenticated: this.authenticated,
                error: err.message,
              }
            : {
                models: this.fallbackModels.map((m) => ({ ...m, efforts: [...(m.efforts || [])] })),
                source: "fallback",
                authenticated: this.authenticated,
                modelConfigId: null,
                currentModelId: this.fallbackModels[0]?.id || null,
                effortConfig: null,
                agentInfo: this.initResult?.agentInfo || null,
                authMethods: this.initResult?.authMethods || [],
                error: err.message,
              };
          this.lastDiscoveryAt = Date.now();
          return this.lastDiscovery;
        }

        // Transient error (timeout / spawn hiccup): preserve last live ACP catalog if known
        // and keep lastDiscoveryAt = 0 so callers do not get stuck on fallback for 60s.
        this.lastDiscovery = prevAcp
          ? {
              ...prevAcp,
              authenticated: this.authenticated,
              error: err.message,
            }
          : {
              models: this.fallbackModels.map((m) => ({ ...m, efforts: [...(m.efforts || [])] })),
              source: "fallback",
              authenticated: this.authenticated,
              modelConfigId: null,
              currentModelId: this.fallbackModels[0]?.id || null,
              effortConfig: null,
              agentInfo: this.initResult?.agentInfo || null,
              authMethods: this.initResult?.authMethods || [],
              error: err.message,
            };
        this.lastDiscoveryAt = 0;
        return this.lastDiscovery;
      }
    })();

    this.discoveryPromise = run;
    try {
      return await run;
    } finally {
      if (this.discoveryPromise === run) {
        this.discoveryPromise = null;
      }
    }
  }

  async _setSessionModel(sessionState, modelId) {
    const target = normalizeModelId(modelId);
    if (!target || sessionState.currentModel === target) return;

    const configId = sessionState.modelConfigId || "model";
    try {
      await this._request("session/set_config_option", {
        sessionId: sessionState.sessionId,
        configId,
        value: target,
      });
      sessionState.currentModel = target;
      return;
    } catch (err) {
      const isMethodMissing =
        err.code === -32601 || /method not found|unsupported/i.test(String(err.message || ""));
      if (!isMethodMissing && sessionState.modelConfigId) {
        // Still try legacy session/set_model once if server expects it
        try {
          await this._request("session/set_model", {
            sessionId: sessionState.sessionId,
            modelId: target,
          });
          sessionState.currentModel = target;
          return;
        } catch {
          throw err;
        }
      }
    }

    await this._request("session/set_model", {
      sessionId: sessionState.sessionId,
      modelId: target,
    });
    sessionState.currentModel = target;
  }

  async _setSessionEffort(sessionState, effort) {
    if (!effort || sessionState.currentEffort === effort) return;
    const configId = sessionState.effortConfigId;
    if (!configId) return;
    try {
      await this._request("session/set_config_option", {
        sessionId: sessionState.sessionId,
        configId,
        value: String(effort),
      });
      sessionState.currentEffort = String(effort);
    } catch {
      // Ignore if the selected model or server rejects an effort override.
    }
  }

  _evictSessionsIfNeeded() {
    while (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (!oldestKey) break;
      const old = this.sessions.get(oldestKey);
      this.sessions.delete(oldestKey);
      if (old?.sessionId) {
        void this._closeSessionBestEffort(old.sessionId);
      }
    }
  }

  getCachedTurnCount(conversationKey) {
    if (!conversationKey) return 0;
    return this.sessions.get(conversationKey)?.sentTurnCount || 0;
  }

  async getOrCreateSession({ conversationKey, cwd, modelId, effort, auxiliary = false }) {
    const resolvedCwd = cwd || this.defaultCwd;
    let state = null;
    let isNew = true;

    if (!auxiliary && conversationKey && this.sessions.has(conversationKey)) {
      const existing = this.sessions.get(conversationKey);
      if (existing.cwd === resolvedCwd) {
        this.sessions.delete(conversationKey);
        this.sessions.set(conversationKey, existing);
        existing.updatedAt = Date.now();
        state = existing;
        isNew = false;
      } else {
        this.sessions.delete(conversationKey);
        void this._closeSessionBestEffort(existing.sessionId);
      }
    }

    if (!state) {
      const sessionRes = await this._createSessionRaw(resolvedCwd);
      const extracted = extractModelsFromSessionResult(sessionRes);
      state = {
        sessionId: sessionRes.sessionId,
        cwd: resolvedCwd,
        modelConfigId: extracted.modelConfigId,
        currentModel: extracted.currentModelId,
        effortConfigId: extracted.effortConfig?.configId || null,
        currentEffort: extracted.effortConfig?.currentValue || null,
        sentTurnCount: 0,
        updatedAt: Date.now(),
      };
      if (!auxiliary && conversationKey) {
        this._evictSessionsIfNeeded();
        this.sessions.set(conversationKey, state);
      }
    }

    if (modelId) {
      await this._setSessionModel(state, modelId);
    }
    if (effort) {
      await this._setSessionEffort(state, effort);
    }

    return { state, isNew };
  }

  async _enqueueForKey(key, fn) {
    const queueKey = key || "__ephemeral__";
    const prev = this.sessionQueues.get(queueKey) || Promise.resolve();
    const run = prev.then(fn, fn);
    const sentinel = run.then(
      () => {
        if (this.sessionQueues.get(queueKey) === sentinel) {
          this.sessionQueues.delete(queueKey);
        }
      },
      () => {
        if (this.sessionQueues.get(queueKey) === sentinel) {
          this.sessionQueues.delete(queueKey);
        }
      },
    );
    this.sessionQueues.set(queueKey, sentinel);
    return run;
  }

  async promptTurn({
    conversationKey,
    cwd,
    modelId,
    effort,
    promptBlocks,
    auxiliary = false,
    signal,
    onEvent,
  }) {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }

    return this._enqueueForKey(auxiliary ? undefined : conversationKey, async () => {
      const { state, isNew } = await this.getOrCreateSession({
        conversationKey,
        cwd,
        modelId,
        effort,
        auxiliary,
      });

      if (signal?.aborted) {
        if (auxiliary) {
          void this._closeSessionBestEffort(state.sessionId);
        }
        return {
          sessionId: state.sessionId,
          isNewSession: isNew,
          model: state.currentModel || normalizeModelId(modelId),
          effort: state.currentEffort || effort || null,
          text: "",
          thoughts: "",
          stopReason: "cancelled",
          usage: null,
        };
      }

      const sessionId = state.sessionId;
      let text = "";
      let thoughts = "";
      let usage = null;
      const permissionPolicy = auxiliary ? "reject" : this.autoApprove ? "allow" : "reject";

      const emit = (evt) => {
        if (typeof onEvent === "function") {
          onEvent(evt);
        }
      };

      this.activeTurns.set(sessionId, {
        permissionPolicy,
        handleUpdate(update) {
          const kind = update.sessionUpdate;
          if (kind === "agent_message_chunk") {
            const delta = extractTextFromContent(update.content);
            if (delta) {
              text += delta;
              emit({ type: "text", text: delta });
            }
            return;
          }
          if (kind === "agent_thought_chunk") {
            const delta = extractTextFromContent(update.content);
            if (delta) {
              thoughts += delta;
              emit({ type: "thought", text: delta });
            }
            return;
          }
          if (kind === "tool_call" || kind === "tool_call_update") {
            emit({
              type: "tool",
              toolCallId: update.toolCallId,
              title: update.title || update.name || "tool",
              name: update.name || null,
              status: update.status || null,
            });
            return;
          }
          if (kind === "usage_update") {
            usage = update.usage || update;
            emit({ type: "usage", usage });
          }
        },
      });

      const onAbort = () => {
        void this.cancel(sessionId);
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const promptRes = await this._request(
          "session/prompt",
          {
            sessionId,
            prompt: Array.isArray(promptBlocks) ? promptBlocks : [],
          },
          0,
        );

        if (!auxiliary) {
          state.sentTurnCount += 1;
          state.updatedAt = Date.now();
        }

        const mergedUsage = promptRes?.usage || usage || null;
        return {
          sessionId,
          isNewSession: isNew,
          model: state.currentModel || normalizeModelId(modelId),
          effort: state.currentEffort || effort || null,
          text,
          thoughts,
          stopReason: promptRes?.stopReason || "end_turn",
          usage: mergedUsage,
        };
      } catch (err) {
        if (isPolicyOrQuotaError(err)) {
          throw this._tripPolicyCooldown(err);
        }
        throw err;
      } finally {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        this.activeTurns.delete(sessionId);
        if (auxiliary) {
          void this._closeSessionBestEffort(sessionId);
        }
      }
    });
  }

  async cancel(sessionId) {
    if (!sessionId || !this.proc) return;
    try {
      this._sendNotification("session/cancel", { sessionId });
    } catch {
      // ignore if process already exited
    }
  }

  status() {
    return {
      running: Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null),
      pid: this.proc?.pid ?? null,
      agyBin: this.agyBin,
      account: this.account || null,
      dataDir: this.geminiDir || null,
      geminiDir: this.geminiDir || null,
      appDataDir: this.appDataDir || null,
      loginCommand: this.formatLoginCommand(),
      canLogout: Boolean(this.initResult?.agentCapabilities?.auth?.logout),
      agentInfo: this.initResult?.agentInfo ?? null,
      authMethods: this.initResult?.authMethods ?? [],
      authenticated: this.authenticated,
      activeSessions: this.sessions.size,
      modelsCount: this.lastDiscovery?.models?.length ?? this.fallbackModels.length,
      modelSource: this.lastDiscovery?.source ?? "fallback",
      authCooldownUntil: this.authCooldownUntil || null,
      policyCooldownUntil: this.policyCooldownUntil || null,
      lastPolicyError: this.lastPolicyError,
      lastError: this.lastError,
      stderrTail: [...this.stderrTail],
    };
  }

  async _shutdownProcess(reasonMessage) {
    const sessionIds = Array.from(this.sessions.values()).map((s) => s.sessionId);
    this.sessions.clear();
    await Promise.all(sessionIds.map((id) => this._closeSessionBestEffort(id)));

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reasonMessage));
    }
    this.pendingRequests.clear();
    this.activeTurns.clear();

    const child = this.proc;
    this.proc = null;
    this.initResult = null;
    this.initPromise = null;
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        // ignore
      }
      this.rl = null;
    }

    if (child && child.exitCode === null && !child.killed) {
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, 500);
        if (typeof killTimer.unref === "function") killTimer.unref();

        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        try {
          child.kill("SIGTERM");
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    }
  }

  async restart() {
    if (this.disposed) return;
    await this._shutdownProcess("AgyAcpClient restarted");
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.discoveryPromise = null;
    this.clearCooldown();
  }

  async dispose() {
    this.disposed = true;
    await this._shutdownProcess("AgyAcpClient disposed");
  }
}
