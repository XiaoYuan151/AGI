import {
  AgyAcpClient,
  InteractiveLoginManager,
  parseFallbackModels,
} from "./lib/core/index.mjs";
import { AgyDshAdapter } from "./adapter.mjs";
import { AgyDshGuiService } from "./gui-service.mjs";
import { registerDshGuiRoutes } from "./gui-routes.mjs";
import { registerAgyCommands } from "./commands.mjs";

export const name = "agi-acp";
export const inject = ["llm"];

function asString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

export function apply(ctx, config = {}) {
  const providerId = asString(config?.providerId, "agy");
  const providerName = asString(config?.providerName, "Antigravity (ACP)");
  const agyBin = asString(config?.agyBin, process.env.AGY_BIN || "agy");
  const account = asString(config?.account, process.env.AGY_ACCOUNT || "");
  const geminiDir = asString(config?.geminiDir, process.env.AGY_GEMINI_DIR || "");
  const appDataDir = asString(config?.appDataDir, process.env.AGY_APP_DATA_DIR || "");
  const authMethod = asString(config?.authMethod, process.env.AGY_AUTH_METHOD || "");
  const autoApprove = asBoolean(config?.autoApprove, true);
  const sandbox = asBoolean(config?.sandbox, false);
  const showToolActivity = asBoolean(config?.showToolActivity, true);
  const cwd = asString(config?.cwd, process.cwd());
  const fallbackModels = parseFallbackModels(config?.fallbackModels);

  const emitModelsUpdated = () => {
    try {
      if (typeof ctx.emit === "function") {
        ctx.emit("llm/models-updated", providerId);
      }
    } catch {
      // Best-effort event notification
    }
  };

  const client = new AgyAcpClient({
    agyBin,
    ...(account ? { account } : {}),
    geminiDir: geminiDir || undefined,
    appDataDir: appDataDir || undefined,
    authMethod: authMethod || undefined,
    autoApprove,
    sandbox,
    cwd,
    fallbackModels,
    ...(config?.env ? { env: config.env } : {}),
    ...(config?.usePersistedConfig !== undefined
      ? { usePersistedConfig: config.usePersistedConfig }
      : {}),
  });

  const adapter = new AgyDshAdapter({
    client,
    providerId,
    providerName,
    cwd,
    showToolActivity,
  });

  const loginManager = new InteractiveLoginManager();
  const guiService = new AgyDshGuiService({
    client,
    providerId,
    providerName,
    loginManager,
    onModelsUpdated: emitModelsUpdated,
  });

  const adapterHandle = ctx.llm.registerAdapter([providerId], adapter);

  let directoryHandle = null;
  if (typeof ctx.llm.registerConfigurableProviders === "function") {
    directoryHandle = ctx.llm.registerConfigurableProviders([
      {
        provider: providerId,
        displayName: providerName,
        settingsNs: ctx.fiber?.entry?.options?.id ?? name,
        settingsPath: [],
        nativeAuth: {
          env: ["GEMINI_API_KEY"],
          oauth: true,
        },
      },
    ]);
  }

  let disposeCommands = () => {};
  if (typeof ctx.inject === "function") {
    ctx.inject(["commands"], (cmdCtx) => {
      const cleanup = registerAgyCommands(cmdCtx, {
        client,
        guiService,
        providerId,
        providerName,
      });
      if (typeof cmdCtx.effect === "function") {
        cmdCtx.effect(function* () {
          yield cleanup;
        }, "agi-acp commands");
      } else {
        disposeCommands = cleanup;
      }
    });
  } else if (ctx.commands) {
    disposeCommands = registerAgyCommands(ctx, {
      client,
      guiService,
      providerId,
      providerName,
    });
  }

  const disposeGuiRoutes = registerDshGuiRoutes(ctx, guiService);

  const cleanup = async () => {
    disposeGuiRoutes();
    guiService.dispose();
    disposeCommands();
    if (typeof directoryHandle === "function") {
      try {
        directoryHandle();
      } catch {
        // ignore
      }
    }
    if (typeof adapterHandle === "function") {
      try {
        adapterHandle();
      } catch {
        // ignore
      }
    }
    await client.dispose();
  };

  if (typeof ctx.effect === "function") {
    ctx.effect(function* () {
      yield cleanup;
    }, "agi-acp lifecycle");
  }

  // Non-blocking initial discovery so DSH model picker updates as soon as ACP responds
  void client
    .discoverModels({ cwd, forceRefresh: false, timeoutMs: 20000 })
    .then(() => emitModelsUpdated())
    .catch(() => {});

  return {
    providerId,
    providerName,
    client,
    adapter,
    guiService,
    dispose: cleanup,
  };
}

export { AgyDshAdapter, AgyDshGuiService };
export default { name, inject, apply };
