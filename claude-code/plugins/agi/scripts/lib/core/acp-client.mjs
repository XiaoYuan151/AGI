import path from "node:path";
import {
  FileAccountStore,
  validateAccountName,
} from "./account-store.mjs";
import { FileModelsCache } from "./models-cache.mjs";
import {
  extractModelsFromSessionResult,
  normalizeModelId,
  parseFallbackModels,
} from "./model-catalog.mjs";
import {
  AgyAuthRequiredError,
  CooldownPolicy,
  extractTextFromContent,
  isAuthError,
  isPolicyOrQuotaError,
  selectPermissionOutcome,
} from "./acp-errors.mjs";
import { buildLoginCommandArgs, runAgyInteractiveLogin } from "./login-runner.mjs";
import { JsonRpcStdioTransport } from "./json-rpc-transport.mjs";

export class AgyAcpClient {
  constructor(options = {}) {
    this._initialEnv = { ...(options.env || process.env) };
    this._baseEnvApiKey =
      typeof this._initialEnv.GEMINI_API_KEY === "string"
        ? this._initialEnv.GEMINI_API_KEY.trim()
        : "";
    this.env = { ...this._initialEnv };
    this._usePersistedConfig = options.usePersistedConfig !== false;
    this._explicitAccount =
      options.account !== undefined ? String(options.account).trim() : "";
    this._explicitGeminiDir = options.geminiDir !== undefined;
    this._explicitAppDataDir = options.appDataDir !== undefined;
    this._explicitAuthMethod = options.authMethod !== undefined;
    this._runtimeApiKeyOverride = undefined;
    this.apiKeySource = this._baseEnvApiKey ? "env" : "none";

    this.accountStore =
      options.accountStore || new FileAccountStore({ env: this.env });
    this.modelsCache =
      options.modelsCache || new FileModelsCache({ env: this.env });
    this.cooldown =
      options.cooldown ||
      new CooldownPolicy({
        authCooldownMs: options.authCooldownMs ?? 30000,
        policyCooldownMs: options.policyCooldownMs ?? 300000,
      });
    this.loginRunner = options.loginRunner || runAgyInteractiveLogin;

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
    this.extraArgs = Array.isArray(options.extraArgs)
      ? options.extraArgs
      : envExtraArgs;

    this.initPromise = null;
    this.initResult = null;
    this.authenticated = null;
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.discoveryPromise = null;
    this.lastError = null;
    this.sessions = new Map();
    this.activeTurns = new Map();
    this.sessionQueues = new Map();
    this.disposed = false;

    this._syncEnvApiKey();

    this.transport =
      options.transport ||
      new JsonRpcStdioTransport({
        command: () => this.agyBin,
        buildArgs: () => this._buildArgs(),
        getCwd: () => this.defaultCwd,
        getEnv: () => this.env,
        defaultTimeoutMs: this.rpcTimeoutMs,
        onRequest: (msg) => this._handleIncomingRequest(msg),
        onNotification: (msg) => this._handleIncomingNotification(msg),
        onDisconnect: (err) => this._handleTransportDisconnect(err),
      });
  }

  get proc() {
    return this.transport.proc;
  }

  get stderrTail() {
    return this.transport.stderrTail;
  }

  get authCooldownUntil() {
    return this.cooldown.authCooldownUntil;
  }

  get policyCooldownUntil() {
    return this.cooldown.policyCooldownUntil;
  }

  get lastPolicyError() {
    return this.cooldown.lastPolicyError;
  }

  _syncStoresEnv() {
    this.accountStore.env = this.env;
    this.modelsCache.env = this.env;
  }

  _syncEnvApiKey() {
    this._syncStoresEnv();
    const nextEnv = { ...this.env };
    if (this._runtimeApiKeyOverride !== undefined) {
      if (this._runtimeApiKeyOverride) {
        nextEnv.GEMINI_API_KEY = this._runtimeApiKeyOverride;
        this.apiKeySource = "runtime";
      } else {
        delete nextEnv.GEMINI_API_KEY;
        this.apiKeySource = "none";
      }
      this.env = nextEnv;
      this._syncStoresEnv();
      return;
    }

    if (this._baseEnvApiKey) {
      nextEnv.GEMINI_API_KEY = this._baseEnvApiKey;
      this.apiKeySource = "env";
      this.env = nextEnv;
      this._syncStoresEnv();
      return;
    }

    if (this._usePersistedConfig && this.geminiDir) {
      const storedKey = this.accountStore.readApiKey(this.geminiDir);
      if (storedKey) {
        nextEnv.GEMINI_API_KEY = storedKey;
        this.apiKeySource = "account";
        this.env = nextEnv;
        this._syncStoresEnv();
        return;
      }
    }

    delete nextEnv.GEMINI_API_KEY;
    this.apiKeySource = "none";
    this.env = nextEnv;
    this._syncStoresEnv();
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
    this.cooldown.clear();
  }

  getAuthInfo() {
    const login = this.getLoginCommand();
    const hasKey = Boolean(
      this.env.GEMINI_API_KEY && String(this.env.GEMINI_API_KEY).trim(),
    );
    const hasStoredAccountKey = Boolean(
      this._usePersistedConfig &&
        this.geminiDir &&
        this.accountStore.readApiKey(this.geminiDir),
    );
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
      hasGeminiApiKey: hasKey,
      hasStoredAccountKey,
      apiKeySource: hasKey ? this.apiKeySource : "none",
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

  reloadPersistedConfig({ account } = {}) {
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
      const nextEnv = { ...this.env };
      if (nextAcct) {
        nextEnv.AGY_ACCOUNT = nextAcct;
      } else {
        delete nextEnv.AGY_ACCOUNT;
      }
      this.env = nextEnv;
      this._syncStoresEnv();
    } else if (this._explicitAccount) {
      const cfg = this.accountStore.readConfig();
      if (!cfg.accounts?.[this._explicitAccount]) {
        this._explicitAccount = cfg.activeAccount || "";
        const nextEnv = { ...this.env };
        if (this._explicitAccount) {
          nextEnv.AGY_ACCOUNT = this._explicitAccount;
        } else {
          delete nextEnv.AGY_ACCOUNT;
        }
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

  async switchAccount(name, { persist = true } = {}) {
    this._syncStoresEnv();
    const validName = validateAccountName(name);
    let entry;
    if (persist && this._usePersistedConfig) {
      entry = this.accountStore.setActive(validName).account;
    } else {
      const cfg = this.accountStore.readConfig();
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

  async setApiKey(apiKey, { persist = false } = {}) {
    const nextKey = typeof apiKey === "string" ? apiKey.trim() : "";
    const prevKey =
      typeof this.env.GEMINI_API_KEY === "string" ? this.env.GEMINI_API_KEY.trim() : "";
    let persistedChanged = false;
    if (persist && this._usePersistedConfig && this.geminiDir) {
      const storedPrev = this.accountStore.readApiKey(this.geminiDir);
      if (nextKey) {
        if (storedPrev !== nextKey) {
          this.accountStore.writeApiKey(this.geminiDir, nextKey);
          persistedChanged = true;
        }
      } else if (storedPrev) {
        this.accountStore.clearApiKey(this.geminiDir);
        persistedChanged = true;
      }
    }
    if (nextKey === prevKey && !persistedChanged) return false;
    this._runtimeApiKeyOverride = nextKey;
    this._syncEnvApiKey();
    this.clearCooldown();
    await this.restart();
    return true;
  }

  async loginInteractive({ stdio = "inherit", cwd = this.defaultCwd } = {}) {
    const loginResult = await this.loginRunner({
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

  _handleTransportDisconnect(err) {
    this.initResult = null;
    this.initPromise = null;
    this.sessions.clear();
    this.lastError = err.message;
    this.activeTurns.clear();
  }

  _handleIncomingRequest(msg) {
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
        this.transport.sendResponse(msg.id, { outcome });
      } catch {
        // ignore write failure if shutting down
      }
      return;
    }

    try {
      this.transport.sendError(msg.id, -32601, `Unsupported client method: ${msg.method}`);
    } catch {
      // ignore
    }
  }

  _handleIncomingNotification(msg) {
    if (msg.method !== "session/update") return;
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

  _request(method, params, timeoutMs = this.rpcTimeoutMs) {
    return this.transport.request(method, params, timeoutMs);
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
    if (this._usePersistedConfig && this.geminiDir) {
      this.accountStore.clearApiKey(this.geminiDir);
    }
    if (this.apiKeySource === "account" || this.apiKeySource === "runtime") {
      this._runtimeApiKeyOverride = "";
      this._syncEnvApiKey();
    }
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
    return this.cooldown.tripPolicy(err);
  }

  async _createSessionRaw(
    cwd,
    timeoutMs = this.rpcTimeoutMs,
    { bypassAuthCooldown = false } = {},
  ) {
    this.cooldown.checkPolicy();

    if (
      !bypassAuthCooldown &&
      this.cooldown.isAuthCoolingDown() &&
      !this._resolveAutoAuthMethod()
    ) {
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
      this.cooldown.clearAuth();
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
          this.cooldown.clearAuth();
          return retried;
        } catch (retryErr) {
          if (isPolicyOrQuotaError(retryErr)) {
            throw this._tripPolicyCooldown(retryErr);
          }
          if (!isAuthError(retryErr)) throw retryErr;
        }
      }
      this.authenticated = false;
      this.cooldown.tripAuth();
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
    if (!sessionId || !this.transport.proc) return;
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
    this._syncStoresEnv();
    return this.modelsCache.read(this._getModelsCacheKey());
  }

  clearCachedDiscovery() {
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.discoveryPromise = null;
    if (this._usePersistedConfig) {
      this._syncStoresEnv();
      this.modelsCache.clear(this._getModelsCacheKey());
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
          this._syncStoresEnv();
          this.modelsCache.write(cacheKey, this.lastDiscovery);
        }
        return this.lastDiscovery;
      } catch (err) {
        this.lastError = err.message;

        if (isAuthError(err)) {
          if (this._usePersistedConfig) {
            this._syncStoresEnv();
            this.modelsCache.clear(cacheKey);
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
              ? this.modelsCache.read(cacheKey)
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
    if (!sessionId || !this.transport.proc) return;
    try {
      this.transport.sendNotification("session/cancel", { sessionId });
    } catch {
      // ignore if process already exited
    }
  }

  status() {
    return {
      running: this.transport.isRunning(),
      pid: this.transport.pid,
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
      authCooldownUntil: this.cooldown.authCooldownUntil || null,
      policyCooldownUntil: this.cooldown.policyCooldownUntil || null,
      lastPolicyError: this.cooldown.lastPolicyError,
      lastError: this.lastError,
      stderrTail: [...this.transport.stderrTail],
      apiKeySource: this.apiKeySource,
    };
  }

  async _shutdownProcess(reasonMessage) {
    const sessionIds = Array.from(this.sessions.values()).map((s) => s.sessionId);
    this.sessions.clear();
    await Promise.all(sessionIds.map((id) => this._closeSessionBestEffort(id)));

    this.activeTurns.clear();
    this.initResult = null;
    this.initPromise = null;
    await this.transport.shutdown(reasonMessage);
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
    this.transport.disposed = true;
    await this._shutdownProcess("AgyAcpClient disposed");
  }
}
