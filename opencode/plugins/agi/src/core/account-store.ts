import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgyAccountEntry {
  name: string;
  label: string;
  dataDir: string;
  geminiDir: string;
  appDataDir: string;
  authMethod: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgyPersistedAcpConfig {
  version: number;
  activeAccount: string;
  geminiDir: string;
  appDataDir: string;
  authMethod: string;
  accounts: Record<string, AgyAccountEntry>;
}

export function resolveAgiHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGI_HOME && String(env.AGI_HOME).trim()) {
    return path.resolve(String(env.AGI_HOME).trim());
  }
  return path.join(os.homedir(), ".agi");
}

export function expandHomePath(inputPath: unknown): string {
  if (typeof inputPath !== "string") return "";
  const trimmed = inputPath.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function validateAccountName(name: unknown): string {
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

export function resolveDefaultAccountDataDir(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const validName = validateAccountName(name);
  const home = resolveAgiHome(env);
  return validName === "default"
    ? path.join(home, "antigravity")
    : path.join(home, "accounts", validName);
}

export function resolveAcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGY_ACP_CONFIG === "0") return "";
  if (env.AGY_ACP_CONFIG && String(env.AGY_ACP_CONFIG).trim()) {
    return path.resolve(String(env.AGY_ACP_CONFIG).trim());
  }
  return path.join(resolveAgiHome(env), "acp.json");
}

function normalizeAccountEntry(
  name: string,
  rawEntry: Record<string, unknown> = {},
): AgyAccountEntry {
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

export function normalizePersistedAcpConfig(
  raw: Record<string, unknown> = {},
  _env: NodeJS.ProcessEnv = process.env,
): AgyPersistedAcpConfig {
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

  const accounts: Record<string, AgyAccountEntry> = {};
  const hasAccountsObj =
    raw.accounts && typeof raw.accounts === "object" && !Array.isArray(raw.accounts);

  if (hasAccountsObj) {
    for (const [rawKey, rawVal] of Object.entries(
      raw.accounts as Record<string, unknown>,
    )) {
      if (!rawVal || typeof rawVal !== "object" || Array.isArray(rawVal)) continue;
      let validName: string;
      try {
        validName = validateAccountName(rawKey);
      } catch {
        continue;
      }
      accounts[validName] = normalizeAccountEntry(
        validName,
        rawVal as Record<string, unknown>,
      );
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

function sortAccountNames(names: string[]): string[] {
  return [...names].sort((a, b) => {
    if (a === "default" && b !== "default") return -1;
    if (b === "default" && a !== "default") return 1;
    return a.localeCompare(b);
  });
}

function atomicWriteJsonSecure(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

export class FileAccountStore {
  env: NodeJS.ProcessEnv;

  constructor({ env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
    this.env = env;
  }

  resolveHome(): string {
    return resolveAgiHome(this.env);
  }

  resolveConfigPath(): string {
    return resolveAcpConfigPath(this.env);
  }

  readConfig(): AgyPersistedAcpConfig {
    const cfgPath = this.resolveConfigPath();
    if (!cfgPath) return normalizePersistedAcpConfig({}, this.env);
    try {
      if (!fs.existsSync(cfgPath)) return normalizePersistedAcpConfig({}, this.env);
      const raw = fs.readFileSync(cfgPath, "utf8").trim();
      if (!raw) return normalizePersistedAcpConfig({}, this.env);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return normalizePersistedAcpConfig(parsed, this.env);
    } catch {
      return normalizePersistedAcpConfig({}, this.env);
    }
  }

  writeConfig(config: AgyPersistedAcpConfig | Record<string, unknown>): {
    configPath: string;
    config: AgyPersistedAcpConfig;
  } {
    const cfgPath = this.resolveConfigPath();
    if (!cfgPath) {
      throw new Error("Persisted ACP config is disabled (AGY_ACP_CONFIG=0).");
    }
    const normalized = normalizePersistedAcpConfig(
      config as Record<string, unknown>,
      this.env,
    );
    atomicWriteJsonSecure(cfgPath, normalized);
    return { configPath: cfgPath, config: normalized };
  }

  resolveCredentialsPath(geminiDir?: string): string {
    const expanded = expandHomePath(geminiDir || "");
    if (!expanded) return "";
    return path.join(expanded, ".agi-credentials.json");
  }

  readApiKey(geminiDir?: string): string {
    const credPath = this.resolveCredentialsPath(geminiDir);
    if (!credPath) return "";
    try {
      if (!fs.existsSync(credPath)) return "";
      const raw = fs.readFileSync(credPath, "utf8").trim();
      if (!raw) return "";
      const parsed = JSON.parse(raw) as { geminiApiKey?: unknown };
      return typeof parsed?.geminiApiKey === "string" ? parsed.geminiApiKey.trim() : "";
    } catch {
      return "";
    }
  }

  writeApiKey(geminiDir: string, apiKey: string): boolean {
    const credPath = this.resolveCredentialsPath(geminiDir);
    if (!credPath) return false;
    const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!trimmed) {
      return this.clearApiKey(geminiDir);
    }
    atomicWriteJsonSecure(credPath, {
      version: 1,
      geminiApiKey: trimmed,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  clearApiKey(geminiDir?: string): boolean {
    const credPath = this.resolveCredentialsPath(geminiDir);
    if (!credPath) return false;
    try {
      if (fs.existsSync(credPath)) {
        fs.unlinkSync(credPath);
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  list() {
    const configPath = this.resolveConfigPath();
    const config = this.readConfig();
    const names = sortAccountNames(Object.keys(config.accounts || {}));
    const accounts = names.map((name) => {
      const entry = config.accounts[name];
      return {
        ...entry,
        active: name === config.activeAccount,
        dirExists: Boolean(entry.geminiDir && fs.existsSync(entry.geminiDir)),
        hasStoredApiKey: Boolean(this.readApiKey(entry.geminiDir)),
      };
    });
    return {
      configPath,
      activeAccount: config.activeAccount || "",
      accounts,
    };
  }

  upsert({
    name,
    dataDir,
    geminiDir,
    appDataDir,
    authMethod,
    label,
    activate = true,
    force = false,
    useDefaultGeminiDir = false,
  }: {
    name: string;
    dataDir?: string;
    geminiDir?: string;
    appDataDir?: string;
    authMethod?: string;
    label?: string;
    activate?: boolean;
    force?: boolean;
    useDefaultGeminiDir?: boolean;
  }) {
    const validName = validateAccountName(name);
    const config = this.readConfig();
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
        : existing?.geminiDir || resolveDefaultAccountDataDir(validName, this.env);

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
    const entry: AgyAccountEntry = {
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

    const written = this.writeConfig(config);
    return {
      configPath: written.configPath,
      account: written.config.accounts[validName],
      activeAccount: written.config.activeAccount,
      config: written.config,
    };
  }

  setActive(name: string) {
    const validName = validateAccountName(name);
    const config = this.readConfig();
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
    const written = this.writeConfig(config);
    return {
      configPath: written.configPath,
      previousAccount,
      activeAccount: validName,
      account: written.config.accounts[validName],
      config: written.config,
    };
  }

  remove(name: string, { purgeData = false }: { purgeData?: boolean } = {}) {
    const validName = validateAccountName(name);
    const config = this.readConfig();
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
      const agiHome = path.resolve(this.resolveHome());
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

    const written = this.writeConfig(config);
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

  resolveProfile({
    account,
    geminiDir,
    appDataDir,
    authMethod,
    usePersistedConfig = true,
  }: {
    account?: string;
    geminiDir?: string;
    appDataDir?: string;
    authMethod?: string;
    usePersistedConfig?: boolean;
  } = {}) {
    const persisted = usePersistedConfig
      ? this.readConfig()
      : normalizePersistedAcpConfig({}, this.env);
    const requestedAccount = String(
      account ?? this.env.AGY_ACCOUNT ?? persisted.activeAccount ?? "",
    ).trim();
    const accountEntry =
      requestedAccount && persisted.accounts?.[requestedAccount]
        ? persisted.accounts[requestedAccount]
        : null;

    const resolvedGeminiDir = expandHomePath(
      String(
        geminiDir ??
          this.env.AGY_GEMINI_DIR ??
          accountEntry?.geminiDir ??
          persisted.geminiDir ??
          "",
      ),
    );
    const resolvedAppDataDir = String(
      appDataDir ??
        this.env.AGY_APP_DATA_DIR ??
        accountEntry?.appDataDir ??
        persisted.appDataDir ??
        "",
    ).trim();
    const resolvedAuthMethod = String(
      authMethod ??
        this.env.AGY_AUTH_METHOD ??
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
}

export function readPersistedAcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgyPersistedAcpConfig {
  return new FileAccountStore({ env }).readConfig();
}

export function writePersistedAcpConfig(
  config: AgyPersistedAcpConfig | Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
) {
  return new FileAccountStore({ env }).writeConfig(config);
}

export function listPersistedAccounts(env: NodeJS.ProcessEnv = process.env) {
  return new FileAccountStore({ env }).list();
}

export function upsertPersistedAccount(
  opts: Parameters<FileAccountStore["upsert"]>[0],
  env: NodeJS.ProcessEnv = process.env,
) {
  return new FileAccountStore({ env }).upsert(opts);
}

export function setActivePersistedAccount(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return new FileAccountStore({ env }).setActive(name);
}

export function removePersistedAccount(
  name: string,
  opts: { purgeData?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  return new FileAccountStore({ env }).remove(name, opts);
}

export function resolveAccountProfile(
  opts: Parameters<FileAccountStore["resolveProfile"]>[0] & {
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return new FileAccountStore({ env: opts.env || process.env }).resolveProfile(opts);
}
