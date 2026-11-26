import type * as OpenCode from "@opencode/plugin";
import {
  type AgyAcpClient,
  type AgyDiscoveryResult,
  removePersistedAccount,
  upsertPersistedAccount,
} from "./acp-client";

export interface AgyToolDeps {
  client: AgyAcpClient;
  providerIdStr: string;
  providerName: string;
  greeting: string;
  directory: string;
  discoveryRpcTimeoutMs: number;
  getDiscovery: () => AgyDiscoveryResult;
  refreshCatalog: (forceRefresh: boolean, timeoutMs?: number) => Promise<AgyDiscoveryResult>;
  reloadIntegrations: () => Promise<void>;
}

export function registerAgyTools(
  editor: Parameters<Parameters<OpenCode.PluginContext["tool"]["transform"]>[0]>[0],
  deps: AgyToolDeps,
): void {
  const {
    client,
    providerIdStr,
    providerName,
    greeting,
    directory,
    discoveryRpcTimeoutMs,
    getDiscovery,
    refreshCatalog,
    reloadIntegrations,
  } = deps;

  editor.namespace({
    name: "hello",
    description: "Sample tools from the agi plugin",
  });

  editor.add({
    name: "greet",
    description: "Greet a person by name.",
    input: {
      type: "object",
      properties: {
        name: { type: "string", description: "Who to greet" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    options: { namespace: "hello", codemode: true },
    execute: async (input) => {
      const name = (input as { name?: unknown }).name;
      if (typeof name !== "string") {
        throw new Error("`name` must be a string");
      }
      return { content: `${greeting}, ${name}! (from ${directory})` };
    },
  });

  editor.namespace({
    name: "agy",
    description: "Antigravity ACP status and model discovery tools",
  });

  editor.add({
    name: "status",
    description: "Inspect agy acp connection, authentication, and active sessions.",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    options: { namespace: "agy", codemode: true },
    execute: async () => {
      const currentDiscovery = getDiscovery();
      return {
        content: JSON.stringify(
          {
            provider: providerIdStr,
            source: currentDiscovery.source,
            authenticated: currentDiscovery.authenticated,
            models: currentDiscovery.models.map((m) => `${providerIdStr}/${m.id}`),
            error: currentDiscovery.error || null,
            acp: client.status(),
          },
          null,
          2,
        ),
      };
    },
  });

  editor.add({
    name: "refresh_models",
    description: "Refresh available Antigravity ACP models and reload OpenCode's /model picker.",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    options: { namespace: "agy", codemode: true },
    execute: async () => {
      const res = await refreshCatalog(true, discoveryRpcTimeoutMs);
      return {
        content: JSON.stringify(
          {
            source: res.source,
            authenticated: res.authenticated,
            error: res.error || null,
            models: res.models.map((m) => ({
              id: `${providerIdStr}/${m.id}`,
              name: m.name,
              efforts: m.efforts,
            })),
          },
          null,
          2,
        ),
      };
    },
  });

  editor.add({
    name: "connect",
    description:
      "Inspect or manage official Antigravity ACP authentication (integrated with OpenCode's native /connect command).",
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "refresh", "authenticate", "logout"],
          description: "Auth action to perform (default: status).",
        },
        methodId: {
          type: "string",
          description:
            "Official ACP auth method ID when action='authenticate' (e.g. gemini-api-key, oauth-business, agent-platform).",
        },
      },
      additionalProperties: false,
    },
    options: { namespace: "agy", codemode: true },
    execute: async (input) => {
      const args = (input && typeof input === "object" ? input : {}) as {
        action?: string;
        methodId?: string;
      };
      const action = args.action || "status";
      if (action === "logout") {
        const logoutRes = await client.logout(discoveryRpcTimeoutMs);
        const discovery = await refreshCatalog(true, discoveryRpcTimeoutMs);
        return {
          content: JSON.stringify(
            {
              action: "logout",
              logout: logoutRes,
              authenticated: discovery.authenticated,
              loginCommand: client.formatLoginCommand(),
            },
            null,
            2,
          ),
        };
      }
      if (action === "authenticate") {
        const methodId =
          typeof args.methodId === "string" && args.methodId.trim()
            ? args.methodId.trim()
            : "gemini-api-key";
        await client.authenticate(methodId, discoveryRpcTimeoutMs);
        const discovery = await refreshCatalog(true, discoveryRpcTimeoutMs);
        return {
          content: JSON.stringify(
            {
              action: "authenticate",
              methodId,
              authenticated: discovery.authenticated,
              modelsCount: discovery.models.length,
            },
            null,
            2,
          ),
        };
      }
      if (action === "refresh") {
        await client.restart();
        const discovery = await refreshCatalog(true, discoveryRpcTimeoutMs);
        return {
          content: JSON.stringify(
            {
              action: "refresh",
              authenticated: discovery.authenticated,
              source: discovery.source,
              modelsCount: discovery.models.length,
              error: discovery.error || null,
            },
            null,
            2,
          ),
        };
      }
      const status = client.status();
      const currentDiscovery = getDiscovery();
      return {
        content: JSON.stringify(
          {
            provider: providerIdStr,
            integrationID: providerIdStr,
            nativeCommand: "/connect",
            authenticated: currentDiscovery.authenticated,
            authMethods: currentDiscovery.authMethods,
            loginCommand: client.formatLoginCommand(),
            canLogout: status.canLogout,
            geminiDir: status.geminiDir,
            appDataDir: status.appDataDir,
            tosNote:
              "Uses Google's official unmodified `agy acp` stdio protocol and `agy acp --login`. For automated/third-party harness usage, GEMINI_API_KEY or Gemini Enterprise (oauth-business / agent-platform) is recommended.",
          },
          null,
          2,
        ),
      };
    },
  });

  editor.add({
    name: "accounts",
    description:
      "List, add, switch, or remove Antigravity ACP accounts saved in separate data folders.",
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "switch", "remove"],
          description: "Account action to perform (default: list).",
        },
        name: {
          type: "string",
          description: "Account name (e.g. 'work', 'personal', 'default').",
        },
        dataDir: {
          type: "string",
          description: "Custom data directory path for this account.",
        },
        appDataDir: {
          type: "string",
          description: "Optional --app-data-dir name (default: antigravity-acp).",
        },
        authMethod: {
          type: "string",
          description: "Optional default ACP auth method for this account.",
        },
        label: {
          type: "string",
          description: "Optional display label.",
        },
        activate: {
          type: "boolean",
          description: "Switch to added account immediately (default: true).",
        },
        purgeData: {
          type: "boolean",
          description: "When action='remove', also delete the account's data folder.",
        },
        force: {
          type: "boolean",
          description: "Allow reusing an existing data folder across accounts.",
        },
      },
      additionalProperties: false,
    },
    options: { namespace: "agy", codemode: true },
    execute: async (input) => {
      const args = (input && typeof input === "object" ? input : {}) as {
        action?: string;
        name?: string;
        dataDir?: string;
        appDataDir?: string;
        authMethod?: string;
        label?: string;
        activate?: boolean;
        purgeData?: boolean;
        force?: boolean;
      };
      const action = args.action || "list";
      if (action === "list") {
        return {
          content: JSON.stringify({ ok: true, ...client.listAccounts() }, null, 2),
        };
      }
      if (action === "add") {
        const resAccount = upsertPersistedAccount(
          {
            name: args.name || "",
            dataDir: args.dataDir,
            appDataDir: args.appDataDir,
            authMethod: args.authMethod,
            label: args.label,
            activate: args.activate !== false,
            force: Boolean(args.force),
          },
          client.env,
        );
        let discovery = getDiscovery();
        if (resAccount.activeAccount === resAccount.account.name) {
          await client.switchAccount(resAccount.account.name, { persist: false });
          discovery = await refreshCatalog(true, discoveryRpcTimeoutMs);
          await reloadIntegrations();
        }
        return {
          content: JSON.stringify(
            {
              ok: true,
              action: "add",
              account: resAccount.account,
              activeAccount: resAccount.activeAccount,
              authenticated: discovery.authenticated,
              modelsCount: discovery.models.length,
              loginCommand: client.formatLoginCommand(),
            },
            null,
            2,
          ),
        };
      }
      if (action === "switch") {
        const switchRes = await client.switchAccount(args.name || "");
        const discovery = await refreshCatalog(true, discoveryRpcTimeoutMs);
        await reloadIntegrations();
        return {
          content: JSON.stringify(
            {
              ...switchRes,
              action: "switch",
              authenticated: discovery.authenticated,
              source: discovery.source,
              modelsCount: discovery.models.length,
            },
            null,
            2,
          ),
        };
      }
      if (action === "remove") {
        const prevAccount = client.account;
        const rm = removePersistedAccount(
          args.name || "",
          { purgeData: Boolean(args.purgeData) },
          client.env,
        );
        if (prevAccount === rm.removed.name || rm.activeAccount !== prevAccount) {
          client.reloadPersistedConfig({ account: rm.activeAccount || "" });
          await client.restart();
          await refreshCatalog(true, discoveryRpcTimeoutMs);
          await reloadIntegrations();
        }
        return {
          content: JSON.stringify(
            {
              ok: true,
              action: "remove",
              removed: rm.removed,
              purgedData: rm.purgedData,
              activeAccount: rm.activeAccount,
            },
            null,
            2,
          ),
        };
      }
      throw new Error(`Unknown agy_accounts action: ${action}`);
    },
  });
}
