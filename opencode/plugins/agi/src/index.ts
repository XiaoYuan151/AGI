import * as OpenCode from "@opencode/plugin";
import {
  AgyAcpClient,
  type AgyDiscoveryResult,
  type AgyModelSpec,
  parseFallbackModels,
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

  return {
    ...base,
    name: spec.name || spec.id,
    capabilities: {
      tools: true,
      input: spec.supportsImages === false ? ["text"] : ["text", "image"],
      output: ["text"],
    },
    variants: efforts.map((effort) => ({
      id: Model.VariantID.make(effort),
      settings: { reasoningEffort: effort },
    })),
    status: "active",
    enabled: true,
    limit: {
      context: spec.contextWindow || 1_000_000,
      output: spec.maxOutputTokens || 65_536,
    },
  };
}

function modelsSignature(models: readonly AgyModelSpec[]): string {
  return models.map((m) => `${m.id}:${m.name}:${m.efforts.join(",")}`).join("|");
}

export default Plugin.define({
  id: "agi",

  async setup(ctx) {
    const greeting = typeof ctx.options.greeting === "string" ? ctx.options.greeting : "Hello";
    const providerIdStr = asString(ctx.options.providerId, "agy");
    const providerName = asString(ctx.options.providerName, "Antigravity (ACP)");
    const agyBin = asString(ctx.options.agyBin, process.env.AGY_BIN || "agy");
    const geminiDir = asString(ctx.options.geminiDir, process.env.AGY_GEMINI_DIR || "");
    const appDataDir = asString(ctx.options.appDataDir, process.env.AGY_APP_DATA_DIR || "");
    const authMethod = asString(ctx.options.authMethod, process.env.AGY_AUTH_METHOD || "");
    const autoApprove = asBoolean(ctx.options.autoApprove, true);
    const sandbox = asBoolean(ctx.options.sandbox, false);
    const showToolActivity = asBoolean(ctx.options.showToolActivity, true);
    const discoveryTimeoutMs = asNumber(ctx.options.discoveryTimeoutMs, 2500);
    const fallbackModels = parseFallbackModels(ctx.options.fallbackModels);

    const providerID = Provider.ID.make(providerIdStr);
    const integrationID = makeIntegrationID(providerIdStr);
    const client = new AgyAcpClient({
      agyBin,
      geminiDir: geminiDir || undefined,
      appDataDir: appDataDir || undefined,
      authMethod: authMethod || undefined,
      autoApprove,
      sandbox,
      cwd: ctx.location.directory,
      fallbackModels,
    });

    let currentDiscovery: AgyDiscoveryResult = {
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
          await client.setApiKey(null);
          return null;
        }
        if (active.type === "credential") {
          const resolved = await connApi.resolve(active);
          if (resolved && resolved.type === "key" && typeof resolved.key === "string") {
            await client.setApiKey(resolved.key);
          } else {
            await client.setApiKey(null);
          }
        } else {
          await client.setApiKey(null);
        }
        return active;
      } catch {
        return null;
      }
    };

    const refreshCatalog = async (forceRefresh: boolean, timeoutMs = 4000) => {
      const activeConnection = await syncIntegrationConnection();
      if (forceRefresh) {
        client.clearCooldown();
      }
      const prevSig = modelsSignature(currentDiscovery.models);
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

      const nextSig = modelsSignature(next.models);
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
          const res = await refreshCatalog(true, 8000);
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
            const logoutRes = await client.logout(8000);
            const discovery = await refreshCatalog(true, 4000);
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
            await client.authenticate(methodId, 10000);
            const discovery = await refreshCatalog(true, 8000);
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
            const discovery = await refreshCatalog(true, 8000);
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
            const logoutRes = await client.logout(8000);
            await refreshCatalog(true, 4000);
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
            const res = await refreshCatalog(true, 8000);
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
          const res = await refreshCatalog(false, 4000);
          const status = client.status();
          const lines = [
            `Antigravity ACP sign-in is integrated with OpenCode's native \`/connect\` command:`,
            `1. Run \`/connect\` and choose **${providerName}** (\`${providerIdStr}\`).`,
            `2. Pick either:`,
            `   - **Sign in with Google (official \`agy acp --login\`)** — runs \`${client.formatLoginCommand()}\``,
            `   - **Gemini API Key (\`GEMINI_API_KEY\`)** — recommended for Google ToS compliance in third-party harnesses`,
            ``,
            `Current status:`,
            `- authenticated: ${String(res.authenticated)} (${res.models.length} models, source: ${res.source})`,
            `- isolated profile: --gemini-dir ${String(status.geminiDir || "(default ~/.gemini)")} --app-data-dir ${String(status.appDataDir || "antigravity-cli")}`,
            `- subcommands: \`/agy-connect refresh\` | \`/agy-connect logout\``,
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
          const res = await refreshCatalog(true, 8000);
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
            await refreshCatalog(true, 8000).catch(() => {});
          }
        } catch {
          // Subscription ended or aborted during plugin cleanup
        }
      })();
    }

    // Fast bounded background/initial probe so OpenCode startup never hangs.
    if (discoveryTimeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        refreshCatalog(false, discoveryTimeoutMs).catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, discoveryTimeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
    } else {
      void refreshCatalog(false, 4000).catch(() => {});
    }

    return async () => {
      disposed = true;
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
