import * as OpenCode from "@opencode/plugin";
import {
  AgyAcpClient,
  type AgyDiscoveryResult,
  type AgyModelSpec,
  parseFallbackModels,
} from "./acp-client";
import { createAgyLanguageModel } from "./language-model";
import { registerAgyTools } from "./tools";
import { registerAgyCommands } from "./commands";

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

    const reloadIntegrations = async () => {
      await ctx.integration?.reload?.().catch(() => {});
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

    const tools = await ctx.tool.transform((editor) =>
      registerAgyTools(editor, {
        client,
        providerIdStr,
        providerName,
        greeting,
        directory: ctx.location.directory,
        discoveryRpcTimeoutMs,
        getDiscovery: () => currentDiscovery,
        refreshCatalog,
        reloadIntegrations,
      }),
    );

    const commands = await ctx.command.transform((editor) =>
      registerAgyCommands(editor, {
        ctx,
        client,
        providerIdStr,
        providerName,
        discoveryRpcTimeoutMs,
        getDiscovery: () => currentDiscovery,
        refreshCatalog,
        reloadIntegrations,
      }),
    );

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
