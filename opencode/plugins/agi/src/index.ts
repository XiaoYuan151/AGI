import { Model, Plugin, Provider } from "@opencode/plugin";
import {
  AgyAcpClient,
  type AgyDiscoveryResult,
  type AgyModelSpec,
  parseFallbackModels,
} from "./acp-client";
import { createAgyLanguageModel } from "./language-model";

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

    const refreshCatalog = async (forceRefresh: boolean, timeoutMs = 4000) => {
      const prevSig = modelsSignature(currentDiscovery.models);
      const next = await client.discoverModels({
        cwd: ctx.location.directory,
        forceRefresh,
        timeoutMs,
      });
      currentDiscovery = next;
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
          prov.activation = "enabled";
          prov.package = "agy-acp";
        });
        editor.models.set(providerID, models);
      } else {
        editor.add({
          info: {
            id: providerID,
            name: providerName,
            activation: "enabled",
            package: "agy-acp",
          },
          models,
        });
      }
    });

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
    });

    const commands = await ctx.command.transform((editor) => {
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
      await commands.dispose();
      await tools.dispose();
      await generateHook.dispose();
      await compactionHook.dispose();
      await titleHook.dispose();
      await contextHook.dispose();
      await languageHook.dispose();
      await sdkHook.dispose();
      await providerTransform.dispose();
      await client.dispose();
    };
  },
});
