import {
  AgyAcpClient,
  InteractiveLoginManager,
  normalizeAuthMethodId,
  validateAccountName,
} from "./lib/core/index.mjs";

/**
 * Application service backing both the native DeepSeek Harness Settings GUI
 * and the standalone local web GUI (SRP + DIP).
 */
export class AgyDshGuiService {
  constructor({
    client,
    providerId = "agy",
    providerName = "Antigravity (ACP)",
    loginManager,
    onModelsUpdated,
    clientFactory,
  }) {
    if (!client) {
      throw new Error("AgyDshGuiService requires an AgyAcpClient instance.");
    }
    this.client = client;
    this.providerId = providerId;
    this.providerName = providerName;
    this.loginManager = loginManager || new InteractiveLoginManager();
    this.onModelsUpdated = typeof onModelsUpdated === "function" ? onModelsUpdated : () => {};
    this.clientFactory =
      clientFactory ||
      ((opts) =>
        new AgyAcpClient({
          agyBin: this.client.agyBin,
          env: this.client.env,
          cwd: this.client.defaultCwd,
          ...opts,
        }));
    this._probedByAccount = new Map();
    this._actionHandlers = new Map([
      ["state", (p) => this.getState({ probe: Boolean(p?.probe) })],
      ["refresh", () => this.refresh()],
      ["probe-accounts", (p) => this.probeAccounts(p?.names)],
      ["account-add", (p) => this.addAccount(p)],
      ["account-update", (p) => this.updateAccount(p)],
      ["account-use", (p) => this.useAccount(p?.name)],
      ["account-remove", (p) => this.removeAccount(p)],
      ["login-google-start", (p) => this.startGoogleLogin(p?.account)],
      ["login-google-status", () => this.getGoogleLoginStatus()],
      ["login-google-cancel", () => this.cancelGoogleLogin()],
      ["auth-api-key", (p) => this.authenticateApiKey(p)],
      ["auth-api-key-clear", (p) => this.clearApiKey(p)],
      ["auth-method", (p) => this.authenticateMethod(p)],
      ["logout", (p) => this.logout(p?.account)],
    ]);
  }

  _resolveTargetEntry(accountName) {
    const trimmed = typeof accountName === "string" ? accountName.trim() : "";
    if (!trimmed) {
      return {
        isActiveTarget: true,
        account: this.client.account || "",
        geminiDir: this.client.geminiDir || "",
        appDataDir: this.client.appDataDir || "antigravity-acp",
        authMethod: this.client.authMethod || "",
      };
    }
    const validName = validateAccountName(trimmed);
    const cfg = this.client.accountStore.readConfig();
    const entry = cfg.accounts?.[validName];
    if (!entry) {
      throw new Error(`Account '${validName}' does not exist.`);
    }
    return {
      isActiveTarget: validName === this.client.account,
      account: entry.name,
      geminiDir: entry.geminiDir || "",
      appDataDir: entry.appDataDir || "antigravity-acp",
      authMethod: entry.authMethod || "",
    };
  }

  async _probeSingleAccount(entry) {
    const tmpClient = this.clientFactory({
      account: entry.name,
      geminiDir: entry.geminiDir,
      appDataDir: entry.appDataDir,
      authMethod: entry.authMethod || undefined,
      usePersistedConfig: false,
      rpcTimeoutMs: 5000,
    });
    try {
      const discovery = await tmpClient.discoverModels({
        forceRefresh: true,
        timeoutMs: 5000,
      });
      const summary = {
        authenticated: discovery.authenticated,
        modelSource: discovery.source,
        modelsCount: discovery.models.length,
        error: discovery.error || null,
        probedAt: new Date().toISOString(),
      };
      this._probedByAccount.set(entry.name, summary);
      return summary;
    } finally {
      await tmpClient.dispose();
    }
  }

  async getState({ probe = false } = {}) {
    if (probe) {
      await this.probeAccounts();
    }

    const loginSession = this.loginManager.getState();
    let discovery = this.client.lastDiscovery || this.client.getCachedDiscovery();
    if (!discovery && loginSession.status !== "running") {
      discovery = await this.client
        .discoverModels({ forceRefresh: false, timeoutMs: 4000 })
        .catch(() => null);
    }

    const listed = this.client.listAccounts();
    const effectiveModels = discovery?.models || this.client.fallbackModels;

    if (this.client.account && discovery) {
      this._probedByAccount.set(this.client.account, {
        authenticated: discovery.authenticated,
        modelSource: discovery.source,
        modelsCount: discovery.models.length,
        error: discovery.error || null,
        probedAt: new Date().toISOString(),
      });
    }

    return {
      ok: true,
      provider: {
        id: this.providerId,
        name: this.providerName,
      },
      status: this.client.status(),
      auth: this.client.getAuthInfo(),
      activeAccount: listed.activeAccount || null,
      configPath: listed.configPath || null,
      accounts: listed.accounts.map((acct) => ({
        ...acct,
        probed: this._probedByAccount.get(acct.name) || null,
      })),
      models: effectiveModels.map((m) => ({
        id: m.id,
        fullId: `${this.providerId}/${m.id}`,
        name: m.name || m.id,
        description: m.description || "",
        contextWindow: m.contextWindow || 1000000,
        maxOutputTokens: m.maxOutputTokens || 65536,
        supportsImages: m.supportsImages !== false,
        efforts: Array.isArray(m.efforts) ? [...m.efforts] : ["low", "medium", "high"],
      })),
      modelSource: discovery?.source || "fallback",
      discoveryError: discovery?.error || null,
      loginSession,
    };
  }

  async refresh() {
    this.client.clearCooldown();
    await this.client.restart();
    await this.client.discoverModels({ forceRefresh: true, timeoutMs: 12000 });
    this.onModelsUpdated();
    return this.getState();
  }

  async probeAccounts(names) {
    const listed = this.client.listAccounts();
    const filterSet =
      Array.isArray(names) && names.length > 0 ? new Set(names.map(String)) : null;

    for (const acct of listed.accounts) {
      if (filterSet && !filterSet.has(acct.name)) continue;
      if (acct.isCurrent) {
        this.client.clearCooldown();
        const disc = await this.client.discoverModels({ forceRefresh: true, timeoutMs: 6000 });
        this._probedByAccount.set(acct.name, {
          authenticated: disc.authenticated,
          modelSource: disc.source,
          modelsCount: disc.models.length,
          error: disc.error || null,
          probedAt: new Date().toISOString(),
        });
      } else {
        await this._probeSingleAccount(acct);
      }
    }
    return this.getState();
  }

  async addAccount({
    name,
    label,
    dataDir,
    appDataDir,
    authMethod,
    activate = true,
    force = false,
    startLogin = false,
  } = {}) {
    const added = this.client.accountStore.upsert({
      name,
      label,
      dataDir,
      appDataDir,
      authMethod,
      activate: activate !== false,
      force: Boolean(force),
    });

    if (added.activeAccount === added.account.name) {
      await this.client.switchAccount(added.account.name, { persist: false });
      if (!startLogin) {
        await this.client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
        this.onModelsUpdated();
      }
    }

    if (startLogin) {
      return this.startGoogleLogin(added.account.name);
    }
    return this.getState();
  }

  async updateAccount({ name, label, dataDir, appDataDir, authMethod, force = false } = {}) {
    const validName = validateAccountName(name);
    const cfg = this.client.accountStore.readConfig();
    if (!cfg.accounts?.[validName]) {
      throw new Error(`Account '${validName}' does not exist.`);
    }
    this.client.accountStore.upsert({
      name: validName,
      ...(label !== undefined ? { label } : {}),
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(appDataDir !== undefined ? { appDataDir } : {}),
      ...(authMethod !== undefined ? { authMethod } : {}),
      activate: false,
      force: Boolean(force),
    });

    if (validName === this.client.account) {
      this.client.reloadPersistedConfig({ account: validName });
      await this.client.restart();
      await this.client.discoverModels({ forceRefresh: true, timeoutMs: 10000 });
      this.onModelsUpdated();
    }
    return this.getState();
  }

  async useAccount(name) {
    if (!name || typeof name !== "string") {
      throw new Error("Account name is required.");
    }
    await this.client.switchAccount(name);
    await this.client.discoverModels({ forceRefresh: true, timeoutMs: 10000 });
    this.onModelsUpdated();
    return this.getState();
  }

  async removeAccount({ name, purgeData = false } = {}) {
    if (!name || typeof name !== "string") {
      throw new Error("Account name is required.");
    }
    const prevAccount = this.client.account;
    const rm = this.client.accountStore.remove(name, { purgeData: Boolean(purgeData) });
    this._probedByAccount.delete(rm.removed.name);

    if (prevAccount === rm.removed.name || rm.activeAccount !== prevAccount) {
      this.client.reloadPersistedConfig({ account: rm.activeAccount || "" });
      await this.client.restart();
      await this.client.discoverModels({ forceRefresh: true, timeoutMs: 10000 });
      this.onModelsUpdated();
    }
    return this.getState();
  }

  async startGoogleLogin(accountName = "") {
    const target = this._resolveTargetEntry(accountName);
    this.loginManager.start({
      account: target.account || null,
      agyBin: this.client.agyBin,
      geminiDir: target.geminiDir,
      appDataDir: target.appDataDir,
      env: this.client.env,
      cwd: this.client.defaultCwd,
      onComplete: async (snap) => {
        if (snap.status !== "succeeded") return;
        try {
          if (target.isActiveTarget || !target.account) {
            this.client.clearCooldown();
            await this.client.restart();
            const disc = await this.client.discoverModels({
              forceRefresh: true,
              timeoutMs: 12000,
            });
            if (target.account) {
              this._probedByAccount.set(target.account, {
                authenticated: disc.authenticated,
                modelSource: disc.source,
                modelsCount: disc.models.length,
                error: disc.error || null,
                probedAt: new Date().toISOString(),
              });
            }
            this.onModelsUpdated();
          } else {
            await this._probeSingleAccount({
              name: target.account,
              geminiDir: target.geminiDir,
              appDataDir: target.appDataDir,
              authMethod: target.authMethod,
            });
          }
        } catch {
          // Best-effort post-login refresh
        }
      },
    });
    return this.getState();
  }

  async getGoogleLoginStatus() {
    return this.getState();
  }

  async cancelGoogleLogin() {
    this.loginManager.cancel();
    return this.getState();
  }

  async authenticateApiKey({ account = "", apiKey = "", persist = true } = {}) {
    const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!trimmedKey) {
      const err = new Error("API key is required.");
      err.statusCode = 400;
      throw err;
    }

    const target = this._resolveTargetEntry(account);
    if (!target.isActiveTarget && target.account) {
      if (persist && target.geminiDir) {
        this.client.accountStore.writeApiKey(target.geminiDir, trimmedKey);
      }
      const tmpClient = this.clientFactory({
        account: target.account,
        geminiDir: target.geminiDir,
        appDataDir: target.appDataDir,
        env: { ...this.client.env, GEMINI_API_KEY: trimmedKey },
        usePersistedConfig: false,
        rpcTimeoutMs: 10000,
      });
      try {
        await tmpClient.authenticate("gemini-api-key", 10000);
        const disc = await tmpClient.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
        this._probedByAccount.set(target.account, {
          authenticated: disc.authenticated,
          modelSource: disc.source,
          modelsCount: disc.models.length,
          error: disc.error || null,
          probedAt: new Date().toISOString(),
        });
      } finally {
        await tmpClient.dispose();
      }
      return this.getState();
    }

    await this.client.setApiKey(trimmedKey, { persist: Boolean(persist) });
    await this.client.authenticate("gemini-api-key", 10000);
    await this.client.discoverModels({ forceRefresh: true, timeoutMs: 10000 });
    this.onModelsUpdated();
    return this.getState();
  }

  async clearApiKey({ account = "" } = {}) {
    const target = this._resolveTargetEntry(account);
    if (!target.isActiveTarget && target.account) {
      if (target.geminiDir) {
        this.client.accountStore.clearApiKey(target.geminiDir);
      }
      this._probedByAccount.delete(target.account);
      return this.getState();
    }

    if (this.client.geminiDir) {
      this.client.accountStore.clearApiKey(this.client.geminiDir);
    }
    await this.client.setApiKey("", { persist: true });
    await this.client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
    this.onModelsUpdated();
    return this.getState();
  }

  async authenticateMethod({ methodId = "gemini-api-key" } = {}) {
    const normalized = normalizeAuthMethodId(methodId, "gemini-api-key");
    await this.client.authenticate(normalized, 10000);
    await this.client.discoverModels({ forceRefresh: true, timeoutMs: 10000 });
    this.onModelsUpdated();
    return this.getState();
  }

  async logout(accountName = "") {
    const target = this._resolveTargetEntry(accountName);
    if (!target.isActiveTarget && target.account) {
      if (target.geminiDir) {
        this.client.accountStore.clearApiKey(target.geminiDir);
      }
      const tmpClient = this.clientFactory({
        account: target.account,
        geminiDir: target.geminiDir,
        appDataDir: target.appDataDir,
        usePersistedConfig: false,
        rpcTimeoutMs: 8000,
      });
      try {
        const res = await tmpClient.logout(8000);
        this._probedByAccount.set(target.account, {
          authenticated: false,
          modelSource: "fallback",
          modelsCount: this.client.fallbackModels.length,
          error: null,
          probedAt: new Date().toISOString(),
        });
        return { ...(await this.getState()), logout: res };
      } finally {
        await tmpClient.dispose();
      }
    }

    const res = await this.client.logout(8000);
    await this.client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
    this.onModelsUpdated();
    return { ...(await this.getState()), logout: res };
  }

  async handleAction(action, payload = {}) {
    const key = typeof action === "string" ? action.trim() : "";
    const handler = this._actionHandlers.get(key);
    if (!handler) {
      const err = new Error(`Unknown action '${String(action ?? "")}'.`);
      err.statusCode = 400;
      throw err;
    }
    return handler(payload || {});
  }

  dispose() {
    this.loginManager.dispose();
  }
}
