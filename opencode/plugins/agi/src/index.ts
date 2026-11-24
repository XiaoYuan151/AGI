import * as OpenCode from "@opencode/plugin";
import {
  AgyAcpClient,
  type AgyDiscoveryResult,
  type AgyModelSpec,
  parseFallbackModels,
  removePersistedAccount,
  upsertPersistedAccount,
} from "./acp-client";
import { createAgyLanguageModel } from "./language-model";

const { Model, Plugin, Provider } = OpenCode;

function makeIntegrationID(id: string): OpenCode.Integration.ID {
  const integrationNs = OpenCode.Integration as
    | { ID?: { make?: (value: string) => OpenCode.Integration.ID } }
    | undefined;
  return typeof integrationNs?.ID?.make === "function"
    ? integrationNs.ID.make(id)
    : (id as unknown as OpenCode.Integration.ID);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function inferModelFamily(id: string): string | undefined {
  const lower = id.toLowerCase();
  if (lower.startsWith("gemini")) return "gemini";
  if (lower.startsWith("claude")) return "claude";
  return undefined;
}

function buildModelInfo(providerID: Provider.ID, spec: AgyModelSpec): Model.Info {
  const modelID = Model.ID.make(spec.id);
  const defaultFn = (Model.Info as unknown as { default?: (p: Provider.ID, id: Model.ID) => Model.Info }).default;
  const base: Model.Info =
    typeof defaultFn === "function"
      ? defaultFn(providerID, modelID)
      : ({
          id: modelID,
          modelID,
          providerID,
          name: spec.id,
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        } as unknown as Model.Info);

  const efforts =
    Array.isArray(spec.efforts) && spec.efforts.length > 0
      ? spec.efforts
      : ["low", "medium", "high"];
  const baseObj = base as unknown as {
    capabilities?: Record<string, unknown>;
    cost?: unknown[];
    family?: unknown;
  };
  const baseCost =
    Array.isArray(baseObj.cost) && baseObj.cost.length > 0
      ? baseObj.cost
      : [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
  const family = inferModelFamily(spec.id);

  return {
    ...base,
    modelID,
    ...(family && !baseObj.family ? { family } : {}),
    name: spec.name || spec.id,
    capabilities: {
      ...(baseObj.capabilities || {}),
      tools: true,
      input: spec.supportsImages === false ? ["text"] : ["text", "image"],
      output: ["text"],
    },
    variants: efforts.map((effort) => ({
      id: Model.VariantID.make(effort),
      settings: { reasoningEffort: effort },
    })),
    cost: baseCost as Model.Info["cost"],
    status: "active",
    enabled: true,
    limit: {
      context: spec.contextWindow || 1_000_000,
      output: spec.maxOutputTokens || 65_536,
    },
  };
}

function modelsSignature(discovery: AgyDiscoveryResult): string {
  const listSig = discovery.models
    .map((m) => `${m.id}:${m.name}:${m.efforts.join(",")}`)
    .join("|");
  return `${discovery.source}#${listSig}`;
}

function tokenizeArgs(raw: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function parseAccountCommandArgs(raw: string) {
  const tokens = tokenizeArgs(raw);
  const subRaw = (tokens[0] || "list").toLowerCase();
  const sub =
    subRaw === "ls"
      ? "list"
      : subRaw === "switch" || subRaw === "select"
        ? "use"
        : subRaw === "rm" || subRaw === "delete"
          ? "remove"
          : subRaw;
  let name = "";
  let dataDir: string | undefined;
  let appDataDir: string | undefined;
  let authMethod: string | undefined;
  let label: string | undefined;
  let activate = true;
  let purgeData = false;
  let force = false;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === "--data-dir" || t === "--gemini-dir") && tokens[i + 1] !== undefined) {
      dataDir = tokens[++i];
    } else if (t === "--app-data-dir" && tokens[i + 1] !== undefined) {
      appDataDir = tokens[++i];
    } else if ((t === "--method" || t === "--auth-method") && tokens[i + 1] !== undefined) {
      authMethod = tokens[++i];
    } else if (t === "--label" && tokens[i + 1] !== undefined) {
      label = tokens[++i];
    } else if (t === "--no-activate") {
      activate = false;
    } else if (t === "--purge") {
      purgeData = true;
    } else if (t === "--force") {
      force = true;
    } else if (!t.startsWith("-") && !name) {
      name = t;
    }
  }

  return { sub, name, dataDir, appDataDir, authMethod, label, activate, purgeData, force };
}

export default Plugin.define({
  id: "agi",

  async setup(ctx) {
    const greeting = typeof ctx.options.greeting === "string" ? ctx.options.greeting : "Hello";
    const providerIdStr = asString(ctx.options.providerId, "agy");
    const providerName = asString(ctx.options.providerName, "Antigravity (ACP)");
    const agyBin = asString(ctx.options.agyBin, process.env.AGY_BIN || "agy");
    const account = asString(ctx.options.account, process.env.AGY_ACCOUNT || "");
    const geminiDir = asString(ctx.options.geminiDir, process.env.AGY_GEMINI_DIR || "");
    const appDataDir = asString(ctx.options.appDataDir, process.env.AGY_APP_DATA_DIR || "");
    const authMethod = asString(ctx.options.authMethod, process.env.AGY_AUTH_METHOD || "");
    const autoApprove = asBoolean(ctx.options.autoApprove, true);
    const sandbox = asBoolean(ctx.options.sandbox, false);
    const showToolActivity = asBoolean(ctx.options.showToolActivity, true);
    const startupWaitMs = asNumber(ctx.options.discoveryTimeoutMs, 1200);
    const discoveryRpcTimeoutMs = Math.max(
      asNumber(ctx.options.discoveryRpcTimeoutMs, 20000),
      startupWaitMs,
      10000,
    );
    const fallbackModels = parseFallbackModels(ctx.options.fallbackModels);
    const baseEnvApiKey =
      typeof process.env.GEMINI_API_KEY === "string"
        ? process.env.GEMINI_API_KEY.trim()
        : "";

    const providerID = Provider.ID.make(providerIdStr);
    const integrationID = makeIntegrationID(providerIdStr);
    const client = new AgyAcpClient({
      agyBin,
      account: account || undefined,
      geminiDir: geminiDir || undefined,
      appDataDir: appDataDir || undefined,
      authMethod: authMethod || undefined,
      autoApprove,
      sandbox,
      cwd: ctx.location.directory,
      rpcTimeoutMs: Math.max(30000, discoveryRpcTimeoutMs),
      fallbackModels,
    });

    const cachedDiscovery = client.getCachedDiscovery();
    let currentDiscovery: AgyDiscoveryResult =
      cachedDiscovery && cachedDiscovery.models.length > 0
        ? cachedDiscovery
        : {
            models: fallbackModels,
            source: "fallback",
            authenticated: null,
            modelConfigId: null,
            currentModelId: fallbackModels[0]?.id ?? null,
            effortConfig: null,
            agentInfo: null,
            authMethods: [],
          };
    let disposed = false;

    const syncIntegrationConnection = async () => {
      const connApi = ctx.integration?.connection;
      if (!connApi) return null;
      try {
        const active = await connApi.active(providerIdStr);
        if (!active) {
          await client.setApiKey(baseEnvApiKey || null);
          return null;
        }
        if (active.type === "credential") {
          const resolved = await connApi.resolve(active);
          if (resolved && resolved.type === "key" && typeof resolved.key === "string") {
            await client.setApiKey(resolved.key);
          } else {
            await client.setApiKey(baseEnvApiKey || null);
          }
        } else {
          await client.setApiKey(baseEnvApiKey || null);
        }
        return active;
      } catch {
        return null;
      }
    };

    const refreshCatalog = async (
      forceRefresh: boolean,
      timeoutMs = discoveryRpcTimeoutMs,
    ) => {
      const activeConnection = await syncIntegrationConnection();
      if (forceRefresh) {
        client.clearCooldown();
      }
      const prevSig = modelsSignature(currentDiscovery);
      const next = await client.discoverModels({
        cwd: ctx.location.directory,
        forceRefresh,
        timeoutMs,
      });
      currentDiscovery = next;

      if (activeConnection && ctx.integration?.connection?.status) {
        try {
          if (next.authenticated === false) {
            await ctx.integration.connection.status({
              integrationID: providerIdStr,
              connection: activeConnection,
              status: {
                status: "needs_auth",
                message: `Authenticate ${providerName} via /connect or run '${client.formatLoginCommand()}'`,
              },
            });
          } else if (next.authenticated === true) {
            await ctx.integration.connection.status({
              integrationID: providerIdStr,
              connection: activeConnection,
              status: undefined,
            });
          }
        } catch {
          // Best-effort connection status reporting
        }
      }

      const nextSig = modelsSignature(next);
      if (!disposed && prevSig !== nextSig) {
        await ctx.provider.reload().catch(() => {});
      }
      return next;
    };

    const providerTransform = await ctx.provider.transform((editor) => {
      const models = currentDiscovery.models.map((m) => buildModelInfo(providerID, m));
      const existing = editor.get(providerID);
      if (existing) {
        editor.update(providerID, (prov) => {
          prov.name = providerName;
          prov.integrationID = integrationID;
          prov.activation = "enabled";
          prov.package = "agy-acp";
        });
        editor.models.set(providerID, models);
      } else {
        editor.add({
          info: {
            id: providerID,
            integrationID,
            name: providerName,
            activation: "enabled",
            package: "agy-acp",
          },
          models,
        });
      }
    });

    const integrationTransform =
      ctx.integration && typeof ctx.integration.transform === "function"
        ? await ctx.integration.transform((editor) => {
            if (editor.get(providerIdStr)) {
              editor.update(providerIdStr, (item) => {
                item.name = providerName;
              });
            }
            const loginCmd = client.getLoginCommand();
            editor.method.update({
              integrationID: providerIdStr,
              method: {
                id: "agy-acp-login",
                type: "command",
                label: "Sign in with Google (official agy acp --login)",
                command: [loginCmd.bin, ...loginCmd.args],
              },
            });
            editor.method.update({
              integrationID: providerIdStr,
              method: {
                type: "key",
                label: "Gemini API Key (GEMINI_API_KEY — recommended for ToS compliance)",
              },
            });
            editor.method.update({
              integrationID: providerIdStr,
              method: {
                type: "env",
                names: ["GEMINI_API_KEY"],
              },
            });
          })
        : null;

    const sdkHook = await ctx.aisdk.hook(
      "sdk",
      (event) => {
        event.sdk = { type: "agy-acp", providerID: providerIdStr };
      },
      { providerID },
    );

    const languageHook = await ctx.aisdk.hook(
      "language",
      (event) => {
        event.language = createAgyLanguageModel({
          providerID: providerIdStr,
          modelId: String(event.model.modelID || event.model.id),
          client,
          cwd: ctx.location.directory,
          showToolActivity,
        }) as unknown as typeof event.language;
      },
      { providerID },
    );

    const contextHook = await ctx.session.hook("context", (event) => {
      event.system.push({
        type: "text",
        text: "The agi plugin is active. Prefer the hello_greet tool for greetings.",
      });
      if (event.model.providerID === providerID) {
        event.options[providerIdStr] = {
          ...(typeof event.options[providerIdStr] === "object" &&
          event.options[providerIdStr] !== null
            ? (event.options[providerIdStr] as Record<string, unknown>)
            : {}),
          sessionID: event.sessionID,
          kind: "primary",
          variant: event.model.variant,
          cwd: ctx.location.directory,
        };
      }
    });

    const attachAuxMeta =
      (kind: "title" | "compaction" | "generate") =>
      (event: {
        readonly sessionID: string;
        readonly model: { readonly variant?: string };
        options: Record<string, unknown>;
      }) => {
        event.options[providerIdStr] = {
          ...(typeof event.options[providerIdStr] === "object" &&
          event.options[providerIdStr] !== null
            ? (event.options[providerIdStr] as Record<string, unknown>)
            : {}),
          sessionID: event.sessionID,
          kind,
          variant: event.model.variant,
          cwd: ctx.location.directory,
        };
      };

    const titleHook = await ctx.session.hook("title", attachAuxMeta("title"), {
      providerID,
    });
    const compactionHook = await ctx.session.hook(
      "compaction",
      attachAuxMeta("compaction"),
      { providerID },
    );
    const generateHook = await ctx.session.hook(
      "generate",
      attachAuxMeta("generate"),
      { providerID },
    );

    const tools = await ctx.tool.transform((editor) => {
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
          return { content: `${greeting}, ${name}! (from ${ctx.location.directory})` };
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
              content: JSON.stringify(
                { ok: true, ...client.listAccounts() },
                null,
                2,
              ),
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
            let discovery = currentDiscovery;
            if (resAccount.activeAccount === resAccount.account.name) {
              await client.switchAccount(resAccount.account.name, { persist: false });
              discovery = await refreshCatalog(true, discoveryRpcTimeoutMs);
              await ctx.integration?.reload?.().catch(() => {});
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
            await ctx.integration?.reload?.().catch(() => {});
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
              await ctx.integration?.reload?.().catch(() => {});
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
    });

    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: "agy-connect",
        description:
          "Sign in to Antigravity ACP (links to native /connect, or run with 'refresh' / 'logout')",
        execute: async (input) => {
          const arg = String((input as { arguments?: unknown })?.arguments || "")
            .trim()
            .toLowerCase();
          if (arg === "logout" || arg === "--logout") {
            const logoutRes = await client.logout(discoveryRpcTimeoutMs);
            await refreshCatalog(true, discoveryRpcTimeoutMs);
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: logoutRes.ok
                ? `Signed out of Antigravity ACP via official ACP logout.\nRun \`/connect\` (select ${providerName}) or \`${client.formatLoginCommand()}\` to sign in again.`
                : `Could not sign out via ACP RPC: ${logoutRes.message || "unsupported"}.`,
              resume: false,
            });
            return;
          }
          if (arg === "refresh" || arg === "--refresh") {
            await client.restart();
            const res = await refreshCatalog(true, discoveryRpcTimeoutMs);
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: [
                `Antigravity ACP connection refreshed (authenticated: ${String(res.authenticated)}, source: ${res.source}, models: ${res.models.length}).`,
                ...(res.error ? [`Note: ${res.error}`] : []),
              ].join("\n"),
              resume: false,
            });
            return;
          }
          const res = await refreshCatalog(false, discoveryRpcTimeoutMs);
          const status = client.status();
          const lines = [
            `Antigravity ACP sign-in is integrated with OpenCode's native \`/connect\` command:`,
            `1. Run \`/connect\` and choose **${providerName}** (\`${providerIdStr}\`).`,
            `2. Pick either:`,
            `   - **Sign in with Google (official \`agy acp --login\`)** — runs \`${client.formatLoginCommand()}\``,
            `   - **Gemini API Key (\`GEMINI_API_KEY\`)** — recommended for Google ToS compliance in third-party harnesses`,
            ``,
            `Current status:`,
            `- account: ${String(status.account || "(default)")}`,
            `- authenticated: ${String(res.authenticated)} (${res.models.length} models, source: ${res.source})`,
            `- isolated profile: --gemini-dir ${String(status.geminiDir || "(default ~/.gemini)")} --app-data-dir ${String(status.appDataDir || "antigravity-cli")}`,
            `- subcommands: \`/agy-connect refresh\` | \`/agy-connect logout\` | \`/agy-accounts\``,
          ];
          if (res.error) {
            lines.push(`- note: ${res.error}`);
          }
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text: lines.join("\n"),
            resume: false,
          });
        },
      });

      editor.add({
        name: "agy-models",
        description: "Refresh and list Antigravity (agy acp) models available in /model",
        execute: async (input) => {
          const res = await refreshCatalog(true, discoveryRpcTimeoutMs);
          const lines = [
            `Antigravity ACP models (provider: ${providerIdStr}, source: ${res.source}, authenticated: ${res.authenticated}):`,
            ...res.models.map((m) => `- ${providerIdStr}/${m.id} (${m.name})`),
          ];
          if (res.error) {
            lines.push(`Note: ${res.error}`);
          }
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text: lines.join("\n"),
            resume: false,
          });
        },
      });

      editor.add({
        name: "agy-status",
        description: "Show Antigravity (agy acp) runtime and authentication status",
        execute: async (input) => {
          const status = client.status();
          const lines = [
            `Antigravity ACP status:`,
            `- provider: ${providerIdStr} (${providerName})`,
            `- account: ${String(status.account || "(default)")}`,
            `- agyBin: ${String(status.agyBin)}`,
            `- geminiDir: ${String(status.geminiDir || "(default ~/.gemini)")}`,
            `- appDataDir: ${String(status.appDataDir || "(default antigravity-cli)")}`,
            `- running: ${String(status.running)}`,
            `- authenticated: ${String(currentDiscovery.authenticated)}`,
            `- activeSessions: ${String(status.activeSessions)}`,
            `- modelsCount: ${currentDiscovery.models.length} (${currentDiscovery.source})`,
            `- connect: /connect (${providerName}) or \`${client.formatLoginCommand()}\``,
          ];
          if (currentDiscovery.error) {
            lines.push(`- error: ${currentDiscovery.error}`);
          }
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text: lines.join("\n"),
            resume: false,
          });
        },
      });

      editor.add({
        name: "agy-accounts",
        description:
          "Manage multiple Antigravity ACP accounts with isolated data folders (list | add <name> [--data-dir <dir>] | use <name> | remove <name> [--purge])",
        execute: async (input) => {
          const raw = String((input as { arguments?: unknown })?.arguments || "").trim();
          const parsed = parseAccountCommandArgs(raw);
          let text = "";

          if (parsed.sub === "add") {
            if (!parsed.name) {
              text = "Usage: `/agy-accounts add <name> [--data-dir <dir>] [--app-data-dir <name>] [--method <id>] [--no-activate]`";
            } else {
              const added = upsertPersistedAccount(
                {
                  name: parsed.name,
                  dataDir: parsed.dataDir,
                  appDataDir: parsed.appDataDir,
                  authMethod: parsed.authMethod,
                  label: parsed.label,
                  activate: parsed.activate,
                  force: parsed.force,
                },
                client.env,
              );
              if (added.activeAccount === added.account.name) {
                await client.switchAccount(added.account.name, { persist: false });
                await refreshCatalog(true, discoveryRpcTimeoutMs);
                await ctx.integration?.reload?.().catch(() => {});
              }
              text = [
                `Added account \`${added.account.name}\` (dataDir: \`${added.account.geminiDir}\`, active: ${added.activeAccount === added.account.name}).`,
                `Sign in for this account with \`/connect\` or \`${client.formatLoginCommand()}\`.`,
              ].join("\n");
            }
          } else if (parsed.sub === "use") {
            if (!parsed.name) {
              text = "Usage: `/agy-accounts use <name>`";
            } else {
              const switched = await client.switchAccount(parsed.name);
              const res = await refreshCatalog(true, discoveryRpcTimeoutMs);
              await ctx.integration?.reload?.().catch(() => {});
              text = [
                `Switched active account to \`${switched.account}\` (dataDir: \`${switched.dataDir}\`).`,
                `authenticated=${String(res.authenticated)}, models=${res.models.length} (${res.source}).`,
                ...(res.authenticated === false ? [`Sign in with \`${switched.loginCommand}\` or \`/connect\`.`] : []),
              ].join("\n");
            }
          } else if (parsed.sub === "remove") {
            if (!parsed.name) {
              text = "Usage: `/agy-accounts remove <name> [--purge]`";
            } else {
              const prevAccount = client.account;
              const rm = removePersistedAccount(
                parsed.name,
                { purgeData: parsed.purgeData },
                client.env,
              );
              if (prevAccount === rm.removed.name || rm.activeAccount !== prevAccount) {
                client.reloadPersistedConfig({ account: rm.activeAccount || "" });
                await client.restart();
                await refreshCatalog(true, discoveryRpcTimeoutMs);
                await ctx.integration?.reload?.().catch(() => {});
              }
              text = `Removed account \`${rm.removed.name}\` (purgedData=${rm.purgedData}, activeAccount=${rm.activeAccount || "none"}).`;
            }
          } else {
            const listed = client.listAccounts();
            if (listed.accounts.length === 0) {
              text = [
                `No named accounts configured yet in \`${listed.configPath || "~/.agi/acp.json"}\`.`,
                `Run \`/agy-accounts add <name> --data-dir <dir>\` or \`agi account add <name> --data-dir <dir> --login\`.`,
              ].join("\n");
            } else {
              text = [
                `Antigravity ACP accounts (active: ${listed.activeAccount || "none"}):`,
                ...listed.accounts.map(
                  (a) =>
                    `- ${a.isCurrent ? "*" : " "} \`${a.name}\` -> \`${a.geminiDir || "(default)"}\` (appDataDir: ${a.appDataDir || "default"})`,
                ),
              ].join("\n");
            }
          }

          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text,
            resume: false,
          });
        },
      });
    });

    // React to OpenCode native /connect credential updates automatically.
    const eventAbort = new AbortController();
    if (ctx.event && typeof ctx.event.subscribe === "function") {
      void (async () => {
        try {
          const stream = ctx.event.subscribe({
            types: ["credential.updated"],
            signal: eventAbort.signal,
          });
          for await (const _evt of stream) {
            if (disposed || eventAbort.signal.aborted) break;
            await client.restart().catch(() => {});
            await refreshCatalog(true, discoveryRpcTimeoutMs).catch(() => {});
          }
        } catch {
          // Subscription ended or aborted during plugin cleanup
        }
      })();
    }

    // Start full-timeout ACP discovery without aborting it at startupWaitMs, so
    // OpenCode plugin activation never hits the 5s deadline while slow `agy acp`
    // cold starts still complete in background and reload /model live.
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const initialRefresh = refreshCatalog(false, discoveryRpcTimeoutMs)
      .then((res) => {
        if (
          !disposed &&
          res &&
          res.source !== "acp" &&
          res.authenticated !== false &&
          typeof res.error === "string" &&
          res.error
        ) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!disposed) {
              void refreshCatalog(true, discoveryRpcTimeoutMs).catch(() => {});
            }
          }, 5000);
          if (typeof retryTimer.unref === "function") retryTimer.unref();
        }
      })
      .catch(() => {});

    if (startupWaitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        initialRefresh,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, startupWaitMs);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }

    return async () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      eventAbort.abort();
      await commands.dispose();
      await tools.dispose();
      await generateHook.dispose();
      await compactionHook.dispose();
      await titleHook.dispose();
      await contextHook.dispose();
      await languageHook.dispose();
      await sdkHook.dispose();
      if (integrationTransform) {
        await integrationTransform.dispose();
      }
      await providerTransform.dispose();
      await client.dispose();
    };
  },
});
