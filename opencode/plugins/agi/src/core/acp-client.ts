import path from "node:path";
import { FileAccountStore, validateAccountName } from "./account-store";
import { FileModelsCache } from "./models-cache";
import {
  type AgyDiscoveryResult,
  type AgyModelSpec,
  extractModelsFromSessionResult,
  normalizeModelId,
  parseFallbackModels,
} from "./model-catalog";
import {
  AgyAuthRequiredError,
  CooldownPolicy,
  extractTextFromContent,
  isAuthError,
  isPolicyOrQuotaError,
  selectPermissionOutcome,
} from "./acp-errors";
import { JsonRpcStdioTransport } from "./json-rpc-transport";

export function buildLoginCommandArgs(options: {
  geminiDir?: string;
  appDataDir?: string;
} = {}): string[] {
  const args = ["acp"];
  if (typeof options.geminiDir === "string" && options.geminiDir.trim()) {
    args.push("--gemini-dir", options.geminiDir.trim());
  }
  if (typeof options.appDataDir === "string" && options.appDataDir.trim()) {
    args.push("--app-data-dir", options.appDataDir.trim());
  }
  args.push("--login");
  return args;
}

export interface AgyLoginCommand {
  bin: string;
  args: string[];
  command: string;
}

export interface AgyLogoutResult {
  ok: boolean;
  supported: boolean;
  message?: string;
}

export interface AgyPromptBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export type AgyTurnEvent =
  | { type: "thought"; text: string }
  | { type: "text"; text: string }
  | {
      type: "tool";
      toolCallId?: string;
      title: string;
      name: string | null;
      status: string | null;
    }
  | { type: "usage"; usage: Record<string, unknown> };

export interface AgyTurnResult {
  sessionId: string;
  isNewSession: boolean;
  model: string;
  effort: string | null;
  text: string;
  thoughts: string;
  stopReason: string;
  usage: Record<string, unknown> | null;
}

export interface AgyClientOptions {
  account?: string;
  agyBin?: string;
  geminiDir?: string;
  appDataDir?: string;
  sandbox?: boolean;
  autoApprove?: boolean;
  authMethod?: string;
  cwd?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  usePersistedConfig?: boolean;
  fallbackModels?: AgyModelSpec[];
  rpcTimeoutMs?: number;
  discoveryTtlMs?: number;
  authCooldownMs?: number;
  policyCooldownMs?: number;
  maxSessions?: number;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  modelConfigId: string | null;
  currentModel: string | null;
  effortConfigId: string | null;
  currentEffort: string | null;
  sentTurnCount: number;
  updatedAt: number;
}

interface ActiveTurn {
  permissionPolicy: "allow" | "reject";
  handleUpdate: (update: Record<string, unknown>) => void;
}

export class AgyAcpClient {
  env: NodeJS.ProcessEnv;
  readonly agyBin: string;
  account: string;
  geminiDir: string;
  appDataDir: string;
  readonly sandbox: boolean;
  readonly autoApprove: boolean;
  authMethod: string;
  readonly defaultCwd: string;
  readonly rpcTimeoutMs: number;
  readonly discoveryTtlMs: number;
  readonly authCooldownMs: number;
  readonly policyCooldownMs: number;
  readonly maxSessions: number;
  readonly fallbackModels: AgyModelSpec[];
  readonly extraArgs: string[];

  private readonly _baseEnvApiKey: string;
  private _runtimeApiKeyOverride: string | undefined;
  private _usePersistedConfig: boolean;
  private _explicitAccount: string;
  private _explicitGeminiDir: boolean;
  private _explicitAppDataDir: boolean;
  private _explicitAuthMethod: boolean;

  private readonly accountStore: FileAccountStore;
  private readonly modelsCache: FileModelsCache;
  private readonly cooldown: CooldownPolicy;
  private readonly transport: JsonRpcStdioTransport;

  private initPromise: Promise<Record<string, unknown>> | null = null;
  private initResult: Record<string, unknown> | null = null;
  private authenticated: boolean | null = null;
  private lastDiscovery: AgyDiscoveryResult | null = null;
  private lastDiscoveryAt = 0;
  private discoveryPromise: Promise<AgyDiscoveryResult> | null = null;
  private lastError: string | null = null;
  private sessions = new Map<string, SessionState>();
  private activeTurns = new Map<string, ActiveTurn>();
  private sessionQueues = new Map<string, Promise<unknown>>();
  private disposed = false;

  constructor(options: AgyClientOptions = {}) {
    const initialEnv = { ...(options.env || process.env) };
    this._baseEnvApiKey =
      typeof initialEnv.GEMINI_API_KEY === "string"
        ? initialEnv.GEMINI_API_KEY.trim()
        : "";
    this.env = initialEnv;
    this._usePersistedConfig = options.usePersistedConfig !== false;
    this._explicitAccount =
      options.account !== undefined ? String(options.account).trim() : "";
    this._explicitGeminiDir = options.geminiDir !== undefined;
    this._explicitAppDataDir = options.appDataDir !== undefined;
    this._explicitAuthMethod = options.authMethod !== undefined;

    this.accountStore = new FileAccountStore({ env: this.env });
    this.modelsCache = new FileModelsCache({ env: this.env });
    this.cooldown = new CooldownPolicy({
      authCooldownMs: options.authCooldownMs ?? 30000,
      policyCooldownMs: options.policyCooldownMs ?? 300000,
    });

    const resolved = this.accountStore.resolveProfile({
      account: options.account,
      geminiDir: options.geminiDir,
      appDataDir: options.appDataDir,
      authMethod: options.authMethod,
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
    this.authCooldownMs = this.cooldown.authCooldownMs;
    this.policyCooldownMs = this.cooldown.policyCooldownMs;
    this.maxSessions = options.maxSessions ?? 32;
    this.fallbackModels =
      Array.isArray(options.fallbackModels) && options.fallbackModels.length > 0
        ? options.fallbackModels
        : parseFallbackModels(this.env.AGY_FALLBACK_MODELS);

    const envExtraArgs =
      typeof this.env.AGY_ACP_ARGS === "string" && this.env.AGY_ACP_ARGS.trim()
        ? this.env.AGY_ACP_ARGS.trim().split(/\s+/)
        : [];
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : envExtraArgs;

    this._syncEnvApiKey();

    this.transport = new JsonRpcStdioTransport({
      command: () => this.agyBin,
      buildArgs: () => this._buildArgs(),
      getCwd: () => this.defaultCwd,
      getEnv: () => this.env,
      defaultTimeoutMs: this.rpcTimeoutMs,
      onRequest: (msg) => this._handleIncomingRequest(msg),
      onNotification: (msg) => this._handleIncomingNotification(msg),
      onDisconnect: (err) => {
        this.initResult = null;
        this.initPromise = null;
        this.sessions.clear();
        this.lastError = err.message;
        this.activeTurns.clear();
      },
    });
  }

  private _syncStoresEnv(): void {
    this.accountStore.env = this.env;
    this.modelsCache.env = this.env;
  }

  private _syncEnvApiKey(): void {
    this._syncStoresEnv();
    const nextEnv: NodeJS.ProcessEnv = { ...this.env };
    if (this._runtimeApiKeyOverride !== undefined) {
      if (this._runtimeApiKeyOverride) {
        nextEnv.GEMINI_API_KEY = this._runtimeApiKeyOverride;
      } else {
        delete nextEnv.GEMINI_API_KEY;
      }
      this.env = nextEnv;
      this._syncStoresEnv();
      return;
    }
    if (this._baseEnvApiKey) {
      nextEnv.GEMINI_API_KEY = this._baseEnvApiKey;
      this.env = nextEnv;
      this._syncStoresEnv();
      return;
    }
    if (this._usePersistedConfig && this.geminiDir) {
      const storedKey = this.accountStore.readApiKey(this.geminiDir);
      if (storedKey) {
        nextEnv.GEMINI_API_KEY = storedKey;
        this.env = nextEnv;
        this._syncStoresEnv();
        return;
      }
    }
    delete nextEnv.GEMINI_API_KEY;
    this.env = nextEnv;
    this._syncStoresEnv();
  }

  private _buildArgs(): string[] {
    const args = ["acp"];
    if (this.geminiDir) args.push("--gemini-dir", this.geminiDir);
    if (this.appDataDir) args.push("--app-data-dir", this.appDataDir);
    if (this.sandbox) args.push("--sandbox");
    if (this.autoApprove) args.push("--dangerously-skip-permissions");
    if (this.extraArgs.length > 0) args.push(...this.extraArgs);
    return args;
  }

  getLoginCommand(): AgyLoginCommand {
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

  formatLoginCommand(): string {
    return this.getLoginCommand().command;
  }

  clearCooldown(): void {
    this.cooldown.clear();
  }

  getAuthInfo(): Record<string, unknown> {
    const login = this.getLoginCommand();
    return {
      authenticated: this.authenticated,
      authMethods: Array.isArray(this.initResult?.authMethods)
        ? this.initResult.authMethods
        : [],
      canLogout: Boolean(
        (this.initResult?.agentCapabilities as { auth?: { logout?: unknown } } | undefined)
          ?.auth?.logout,
      ),
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
    this._syncStoresEnv();
    const listed = this.accountStore.list();
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

  reloadPersistedConfig({ account }: { account?: string } = {}) {
    this._syncStoresEnv();
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
      const nextEnv: NodeJS.ProcessEnv = { ...this.env };
      if (nextAcct) nextEnv.AGY_ACCOUNT = nextAcct;
      else delete nextEnv.AGY_ACCOUNT;
      this.env = nextEnv;
      this._syncStoresEnv();
    } else if (this._explicitAccount) {
      const cfg = this.accountStore.readConfig();
      if (!cfg.accounts?.[this._explicitAccount]) {
        this._explicitAccount = cfg.activeAccount || "";
        const nextEnv: NodeJS.ProcessEnv = { ...this.env };
        if (this._explicitAccount) nextEnv.AGY_ACCOUNT = this._explicitAccount;
        else delete nextEnv.AGY_ACCOUNT;
        this.env = nextEnv;
        this._syncStoresEnv();
      }
    }
    const targetAccount =
      account !== undefined ? String(account).trim() : this._explicitAccount || undefined;
    const resolved = this.accountStore.resolveProfile({
      account: targetAccount,
      geminiDir: account === undefined && this._explicitGeminiDir ? this.geminiDir : undefined,
      appDataDir: account === undefined && this._explicitAppDataDir ? this.appDataDir : undefined,
      authMethod: account === undefined && this._explicitAuthMethod ? this.authMethod : undefined,
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
    this._syncEnvApiKey();
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

  async switchAccount(name: string, { persist = true }: { persist?: boolean } = {}) {
    this._syncStoresEnv();
    const validName = validateAccountName(name);
    const entry =
      persist && this._usePersistedConfig
        ? this.accountStore.setActive(validName).account
        : this.accountStore.readConfig().accounts?.[validName];
    if (!entry) {
      throw new Error(`Account '${validName}' does not exist.`);
    }

    const nextEnv: NodeJS.ProcessEnv = { ...this.env };
    delete nextEnv.AGY_GEMINI_DIR;
    delete nextEnv.AGY_APP_DATA_DIR;
    delete nextEnv.AGY_AUTH_METHOD;
    nextEnv.AGY_ACCOUNT = entry.name;
    this.env = nextEnv;

    this._explicitAccount = entry.name;
    this._explicitGeminiDir = false;
    this._explicitAppDataDir = false;
    this._explicitAuthMethod = false;
    this._runtimeApiKeyOverride = undefined;
    this.account = entry.name;
    this.geminiDir = entry.geminiDir;
    this.appDataDir = entry.appDataDir;
    this.authMethod = entry.authMethod || "";
    this.authenticated = null;
    this._syncEnvApiKey();

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

  async setApiKey(apiKey: string | null | undefined): Promise<boolean> {
    const nextKey = typeof apiKey === "string" ? apiKey.trim() : "";
    const prevKey =
      typeof this.env.GEMINI_API_KEY === "string" ? this.env.GEMINI_API_KEY.trim() : "";
    if (nextKey === prevKey) return false;
    this._runtimeApiKeyOverride = nextKey;
    this._syncEnvApiKey();
    this.clearCooldown();
    await this.restart();
    return true;
  }

  private _handleIncomingRequest(msg: Record<string, unknown>): void {
    if (msg.method === "session/request_permission") {
      const params = (msg.params || {}) as { sessionId?: string; options?: unknown };
      const sessionId = params.sessionId;
      const turn = sessionId ? this.activeTurns.get(sessionId) : null;
      const policy: "allow" | "reject" = turn
        ? turn.permissionPolicy
        : this.autoApprove
          ? "allow"
          : "reject";
      const outcome = selectPermissionOutcome(params.options, policy);
      try {
        this.transport.sendResponse(msg.id, { outcome });
      } catch {
        // ignore
      }
      return;
    }

    try {
      this.transport.sendError(msg.id, -32601, `Unsupported client method: ${String(msg.method)}`);
    } catch {
      // ignore
    }
  }

  private _handleIncomingNotification(msg: Record<string, unknown>): void {
    if (msg.method !== "session/update") return;
    const params = (msg.params || {}) as {
      sessionId?: string;
      update?: Record<string, unknown>;
    };
    const sessionId = params.sessionId;
    const update = params.update;
    if (!update || typeof update !== "object") return;

    if (
      update.sessionUpdate === "config_option_update" &&
      Array.isArray(update.configOptions)
    ) {
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

  async initialize(timeoutMs = this.rpcTimeoutMs): Promise<Record<string, unknown>> {
    if (this.initResult) return this.initResult;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const result = await this.transport.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "agi-opencode-acp",
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

  async authenticate(methodId: string, timeoutMs = this.rpcTimeoutMs): Promise<unknown> {
    await this.initialize(timeoutMs);
    const result = await this.transport.request("authenticate", { methodId }, timeoutMs);
    this.authenticated = true;
    this.lastDiscoveryAt = 0;
    this.clearCooldown();
    return result;
  }

  async logout(timeoutMs = this.rpcTimeoutMs): Promise<AgyLogoutResult> {
    await this.initialize(timeoutMs);
    const caps = this.initResult?.agentCapabilities as Record<string, unknown> | undefined;
    const authCaps = caps?.auth as Record<string, unknown> | undefined;
    const supportsLogout = Boolean(authCaps && "logout" in authCaps);
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
    await this.transport.request("logout", {}, timeoutMs);
    if (this._usePersistedConfig && this.geminiDir) {
      this.accountStore.clearApiKey(this.geminiDir);
    }
    this.authenticated = false;
    this.clearCachedDiscovery();
    this.clearCooldown();
    return { ok: true, supported: true };
  }

  private _resolveAutoAuthMethod(): string {
    if (this.authMethod) return this.authMethod;
    if (this.env.GEMINI_API_KEY && String(this.env.GEMINI_API_KEY).trim()) {
      return "gemini-api-key";
    }
    return "";
  }

  private async _createSessionRaw(
    cwd: string,
    timeoutMs = this.rpcTimeoutMs,
    { bypassAuthCooldown = false }: { bypassAuthCooldown?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    this.cooldown.checkPolicy();

    if (
      !bypassAuthCooldown &&
      this.cooldown.isAuthCoolingDown() &&
      !this._resolveAutoAuthMethod()
    ) {
      const methods = Array.isArray(this.initResult?.authMethods)
        ? (this.initResult.authMethods as Array<Record<string, unknown>>)
        : [];
      throw new AgyAuthRequiredError(
        `Antigravity ACP requires authentication. Run '${this.formatLoginCommand()}' or set GEMINI_API_KEY.`,
        methods,
      );
    }

    await this.initialize(timeoutMs);
    const tryNew = () =>
      this.transport.request(
        "session/new",
        { cwd: cwd || this.defaultCwd, mcpServers: [] },
        timeoutMs,
      );

    try {
      const res = await tryNew();
      this.authenticated = true;
      this.cooldown.clearAuth();
      return res;
    } catch (err) {
      if (isPolicyOrQuotaError(err)) {
        throw this.cooldown.tripPolicy(err);
      }
      if (!isAuthError(err)) throw err;
      const methodId = this._resolveAutoAuthMethod();
      if (methodId) {
        try {
          await this.authenticate(methodId, timeoutMs);
          const retried = await tryNew();
          this.authenticated = true;
          this.cooldown.clearAuth();
          return retried;
        } catch (retryErr) {
          if (isPolicyOrQuotaError(retryErr)) {
            throw this.cooldown.tripPolicy(retryErr);
          }
          if (!isAuthError(retryErr)) throw retryErr;
        }
      }
      this.authenticated = false;
      this.cooldown.tripAuth();
      const methods = Array.isArray(this.initResult?.authMethods)
        ? (this.initResult.authMethods as Array<Record<string, unknown>>)
        : [];
      throw new AgyAuthRequiredError(
        `Antigravity ACP requires authentication. Run '${this.formatLoginCommand()}' or set GEMINI_API_KEY.`,
        methods,
      );
    }
  }

  private async _closeSessionBestEffort(sessionId?: string): Promise<void> {
    if (!sessionId || !this.transport.proc) return;
    try {
      await this.transport.request("session/close", { sessionId }, 2000);
    } catch {
      // ignore
    }
  }

  private _getModelsCacheKey(): string {
    return `${this.agyBin}::${this.geminiDir || "default"}::${this.appDataDir || "default"}`;
  }

  getCachedDiscovery(): AgyDiscoveryResult | null {
    if (this.lastDiscovery?.source === "acp" && this.lastDiscovery.models.length > 0) {
      return this.lastDiscovery;
    }
    if (!this._usePersistedConfig) return null;
    this._syncStoresEnv();
    return this.modelsCache.read(this._getModelsCacheKey());
  }

  clearCachedDiscovery(): void {
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.discoveryPromise = null;
    if (this._usePersistedConfig) {
      this._syncStoresEnv();
      this.modelsCache.clear(this._getModelsCacheKey());
    }
  }

  async discoverModels({
    cwd,
    forceRefresh = false,
    timeoutMs = 20000,
  }: { cwd?: string; forceRefresh?: boolean; timeoutMs?: number } = {}): Promise<AgyDiscoveryResult> {
    const now = Date.now();
    if (!forceRefresh && this.lastDiscovery && now - this.lastDiscoveryAt < this.discoveryTtlMs) {
      return this.lastDiscovery;
    }
    if (!forceRefresh && this.discoveryPromise) {
      return this.discoveryPromise;
    }

    const cacheKey = this._getModelsCacheKey();
    const run = (async (): Promise<AgyDiscoveryResult> => {
      try {
        const sessionRes = await this._createSessionRaw(cwd || this.defaultCwd, timeoutMs, {
          bypassAuthCooldown: forceRefresh,
        });
        const sessionId =
          typeof sessionRes?.sessionId === "string" ? sessionRes.sessionId : undefined;
        const extracted = extractModelsFromSessionResult(sessionRes);
        await this._closeSessionBestEffort(sessionId);

        const models =
          extracted.models.length > 0
            ? extracted.models
            : this.fallbackModels.map((m) => ({ ...m, efforts: [...m.efforts] }));

        this.lastError = null;
        this.lastDiscovery = {
          models,
          source: extracted.models.length > 0 ? "acp" : "fallback",
          authenticated: true,
          modelConfigId: extracted.modelConfigId,
          currentModelId: extracted.currentModelId || models[0]?.id || null,
          effortConfig: extracted.effortConfig,
          agentInfo: (this.initResult?.agentInfo as Record<string, unknown>) || null,
          authMethods: Array.isArray(this.initResult?.authMethods)
            ? (this.initResult.authMethods as Array<Record<string, unknown>>)
            : [],
        };
        this.lastDiscoveryAt = Date.now();
        if (this._usePersistedConfig && this.lastDiscovery.source === "acp") {
          this._syncStoresEnv();
          this.modelsCache.write(cacheKey, this.lastDiscovery);
        }
        return this.lastDiscovery;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;

        if (isAuthError(err)) {
          if (this._usePersistedConfig) {
            this._syncStoresEnv();
            this.modelsCache.clear(cacheKey);
          }
          this.authenticated = false;
          const fallback: AgyDiscoveryResult = {
            models: this.fallbackModels.map((m) => ({ ...m, efforts: [...m.efforts] })),
            source: "fallback",
            authenticated: false,
            modelConfigId: null,
            currentModelId: this.fallbackModels[0]?.id || null,
            effortConfig: null,
            agentInfo: (this.initResult?.agentInfo as Record<string, unknown>) || null,
            authMethods: Array.isArray(this.initResult?.authMethods)
              ? (this.initResult.authMethods as Array<Record<string, unknown>>)
              : [],
            error: msg,
          };
          this.lastDiscovery = fallback;
          this.lastDiscoveryAt = Date.now();
          return fallback;
        }

        const prevAcp =
          this.lastDiscovery?.source === "acp"
            ? this.lastDiscovery
            : this._usePersistedConfig
              ? this.modelsCache.read(cacheKey)
              : null;

        this.lastDiscovery = prevAcp
          ? { ...prevAcp, authenticated: this.authenticated, error: msg }
          : {
              models: this.fallbackModels.map((m) => ({ ...m, efforts: [...m.efforts] })),
              source: "fallback",
              authenticated: this.authenticated,
              modelConfigId: null,
              currentModelId: this.fallbackModels[0]?.id || null,
              effortConfig: null,
              agentInfo: (this.initResult?.agentInfo as Record<string, unknown>) || null,
              authMethods: Array.isArray(this.initResult?.authMethods)
                ? (this.initResult.authMethods as Array<Record<string, unknown>>)
                : [],
              error: msg,
            };
        this.lastDiscoveryAt = isPolicyOrQuotaError(err) ? Date.now() : 0;
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

  private async _setSessionModel(sessionState: SessionState, modelId: string): Promise<void> {
    const target = normalizeModelId(modelId);
    if (!target || sessionState.currentModel === target) return;

    const configId = sessionState.modelConfigId || "model";
    try {
      await this.transport.request("session/set_config_option", {
        sessionId: sessionState.sessionId,
        configId,
        value: target,
      });
      sessionState.currentModel = target;
      return;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const msg = err instanceof Error ? err.message : String(err);
      const isMethodMissing = code === -32601 || /method not found|unsupported/i.test(msg);
      if (!isMethodMissing && sessionState.modelConfigId) {
        try {
          await this.transport.request("session/set_model", {
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

    await this.transport.request("session/set_model", {
      sessionId: sessionState.sessionId,
      modelId: target,
    });
    sessionState.currentModel = target;
  }

  private async _setSessionEffort(sessionState: SessionState, effort: string): Promise<void> {
    if (!effort || sessionState.currentEffort === effort) return;
    const configId = sessionState.effortConfigId;
    if (!configId) return;
    try {
      await this.transport.request("session/set_config_option", {
        sessionId: sessionState.sessionId,
        configId,
        value: effort,
      });
      sessionState.currentEffort = effort;
    } catch {
      // ignore
    }
  }

  private _evictSessionsIfNeeded(): void {
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

  getCachedTurnCount(conversationKey?: string): number {
    if (!conversationKey) return 0;
    return this.sessions.get(conversationKey)?.sentTurnCount || 0;
  }

  async getOrCreateSession({
    conversationKey,
    cwd,
    modelId,
    effort,
    auxiliary = false,
  }: {
    conversationKey?: string;
    cwd?: string;
    modelId?: string;
    effort?: string;
    auxiliary?: boolean;
  }): Promise<{ state: SessionState; isNew: boolean }> {
    const resolvedCwd = cwd || this.defaultCwd;
    let state: SessionState | null = null;
    let isNew = true;

    if (!auxiliary && conversationKey && this.sessions.has(conversationKey)) {
      const existing = this.sessions.get(conversationKey)!;
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
        sessionId: String(sessionRes.sessionId),
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

    if (modelId) await this._setSessionModel(state, modelId);
    if (effort) await this._setSessionEffort(state, effort);

    return { state, isNew };
  }

  private _enqueueForKey<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
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
  }: {
    conversationKey?: string;
    cwd?: string;
    modelId?: string;
    effort?: string;
    promptBlocks: AgyPromptBlock[];
    auxiliary?: boolean;
    signal?: AbortSignal;
    onEvent?: (evt: AgyTurnEvent) => void;
  }): Promise<AgyTurnResult> {
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
        if (auxiliary) void this._closeSessionBestEffort(state.sessionId);
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
      let usage: Record<string, unknown> | null = null;
      const permissionPolicy: "allow" | "reject" = auxiliary
        ? "reject"
        : this.autoApprove
          ? "allow"
          : "reject";

      this.activeTurns.set(sessionId, {
        permissionPolicy,
        handleUpdate(update) {
          const kind = update.sessionUpdate;
          if (kind === "agent_message_chunk") {
            const delta = extractTextFromContent(update.content);
            if (delta) {
              text += delta;
              onEvent?.({ type: "text", text: delta });
            }
            return;
          }
          if (kind === "agent_thought_chunk") {
            const delta = extractTextFromContent(update.content);
            if (delta) {
              thoughts += delta;
              onEvent?.({ type: "thought", text: delta });
            }
            return;
          }
          if (kind === "tool_call" || kind === "tool_call_update") {
            onEvent?.({
              type: "tool",
              toolCallId:
                typeof update.toolCallId === "string" ? update.toolCallId : undefined,
              title: String(update.title || update.name || "tool"),
              name: typeof update.name === "string" ? update.name : null,
              status: typeof update.status === "string" ? update.status : null,
            });
            return;
          }
          if (kind === "usage_update") {
            usage = (update.usage as Record<string, unknown>) || update;
            onEvent?.({ type: "usage", usage });
          }
        },
      });

      const onAbort = () => {
        void this.cancel(sessionId);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const promptRes = await this.transport.request(
          "session/prompt",
          { sessionId, prompt: Array.isArray(promptBlocks) ? promptBlocks : [] },
          0,
        );

        if (!auxiliary) {
          state.sentTurnCount += 1;
          state.updatedAt = Date.now();
        }

        const mergedUsage =
          (promptRes.usage as Record<string, unknown> | undefined) || usage || null;
        return {
          sessionId,
          isNewSession: isNew,
          model: state.currentModel || normalizeModelId(modelId),
          effort: state.currentEffort || effort || null,
          text,
          thoughts,
          stopReason: String(promptRes.stopReason || "end_turn"),
          usage: mergedUsage,
        };
      } catch (err) {
        if (isPolicyOrQuotaError(err)) {
          throw this.cooldown.tripPolicy(err);
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        this.activeTurns.delete(sessionId);
        if (auxiliary) void this._closeSessionBestEffort(sessionId);
      }
    });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!sessionId || !this.transport.proc) return;
    try {
      this.transport.sendNotification("session/cancel", { sessionId });
    } catch {
      // ignore
    }
  }

  status(): Record<string, unknown> {
    const caps = this.initResult?.agentCapabilities as Record<string, unknown> | undefined;
    const authCaps = caps?.auth as Record<string, unknown> | undefined;
    return {
      running: this.transport.isRunning(),
      pid: this.transport.pid,
      agyBin: this.agyBin,
      account: this.account || null,
      dataDir: this.geminiDir || null,
      geminiDir: this.geminiDir || null,
      appDataDir: this.appDataDir || null,
      loginCommand: this.formatLoginCommand(),
      canLogout: Boolean(authCaps && "logout" in authCaps),
      agentInfo: this.initResult?.agentInfo ?? null,
      authMethods: this.initResult?.authMethods ?? [],
      authenticated: this.authenticated,
      activeSessions: this.sessions.size,
      modelsCount: this.lastDiscovery?.models?.length ?? this.fallbackModels.length,
      modelSource: this.lastDiscovery?.source ?? "fallback",
      authCooldownUntil: this.cooldown.authCooldownUntil || null,
      policyCooldownUntil: this.cooldown.policyCooldownUntil || null,
      lastPolicyError: this.cooldown.lastPolicyError,
      lastError: this.lastError,
      stderrTail: [...this.transport.stderrTail],
    };
  }

  private async _shutdownProcess(reasonMessage: string): Promise<void> {
    const sessionIds = Array.from(this.sessions.values()).map((s) => s.sessionId);
    this.sessions.clear();
    await Promise.all(sessionIds.map((id) => this._closeSessionBestEffort(id)));

    this.activeTurns.clear();
    this.initResult = null;
    this.initPromise = null;
    await this.transport.shutdown(reasonMessage);
  }

  async restart(): Promise<void> {
    if (this.disposed) return;
    await this._shutdownProcess("AgyAcpClient restarted");
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.discoveryPromise = null;
    this.clearCooldown();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.transport.disposed = true;
    await this._shutdownProcess("AgyAcpClient disposed");
  }
}
