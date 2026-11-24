import { AgyAcpClient, parseFallbackModels } from "./lib/agy-acp-client.mjs";
import { AgyDshAdapter } from "./adapter.mjs";

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

function registerAgyCommands(ctx, { client, providerId, providerName }) {
  if (!ctx?.commands || typeof ctx.commands.register !== "function") {
    return () => {};
  }

  const disposers = [];
  const emitModelsUpdated = () => {
    try {
      if (typeof ctx.emit === "function") {
        ctx.emit("llm/models-updated", providerId);
      }
    } catch {
      // Best-effort event notification
    }
  };

  const registerOne = (def) => {
    const dispose = ctx.commands.register(def);
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  };

  registerOne({
    definitionId: "@local/dsh-agi:agy-connect",
    name: "agy-connect",
    description:
      "Sign in to Google Antigravity ACP (agy acp), check auth status, refresh models, or log out",
    input: {
      hint: "[status | method <gemini-api-key|oauth-business|agent-platform> | refresh | logout]",
    },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput || "").trim();
      const parts = raw ? raw.split(/\s+/) : [];
      const sub = (parts[0] || "status").toLowerCase();

      if (sub === "logout" || sub === "--logout") {
        const res = await client.logout(8000);
        emitModelsUpdated();
        if (!res.ok) {
          return {
            kind: "error",
            text: `Antigravity ACP logout failed: ${res.message || "unsupported"}`,
          };
        }
        return {
          kind: "success",
          text: [
            "Signed out of Antigravity ACP via official ACP logout.",
            `To sign in again, run \`${client.formatLoginCommand()}\` in your terminal or set \`GEMINI_API_KEY\`, then run \`/agy-connect refresh\`.`,
          ].join("\n"),
        };
      }

      if (sub === "method" || sub === "--method" || sub === "authenticate") {
        const rawMethod = (parts[1] || "gemini-api-key").toLowerCase();
        const methodMap = {
          "api-key": "gemini-api-key",
          enterprise: "oauth-business",
          vertex: "agent-platform",
        };
        const methodId = methodMap[rawMethod] || rawMethod;
        try {
          await client.authenticate(methodId, 10000);
          const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
          emitModelsUpdated();
          return {
            kind: "success",
            text: `Authenticated Antigravity ACP via '${methodId}' (${discovery.models.length} models discovered, source: ${discovery.source}).`,
          };
        } catch (err) {
          return {
            kind: "error",
            text: `Authentication via '${methodId}' failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      if (sub === "refresh" || sub === "--refresh") {
        await client.restart();
        const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
        emitModelsUpdated();
        return {
          kind: "success",
          text: [
            `Refreshed Antigravity ACP (${providerName}): authenticated=${String(discovery.authenticated)}, models=${discovery.models.length} (${discovery.source}).`,
            ...(discovery.error ? [`Note: ${discovery.error}`] : []),
          ].join("\n"),
        };
      }

      // Default: status + official sign-in instructions
      const discovery = await client.discoverModels({ forceRefresh: false, timeoutMs: 4000 });
      const info = client.getAuthInfo();
      const lines = [
        `Antigravity ACP (${providerName}) authentication:`,
        `- authenticated: ${String(discovery.authenticated)} (${discovery.models.length} models, source: ${discovery.source})`,
        `- isolated profile: --gemini-dir ${info.geminiDir || "(default ~/.gemini)"} --app-data-dir ${info.appDataDir || "antigravity-cli"}`,
        `- official sign-in command: \`${info.loginCommand}\``,
        `- or use API key / Enterprise (recommended for Google ToS compliance): export \`GEMINI_API_KEY\` then run \`/agy-connect method gemini-api-key\``,
        `- subcommands: \`/agy-connect refresh\` | \`/agy-connect method <id>\` | \`/agy-connect logout\``,
      ];
      if (discovery.error) {
        lines.push(`- note: ${discovery.error}`);
      }
      return { kind: "success", text: lines.join("\n") };
    },
  });

  registerOne({
    definitionId: "@local/dsh-agi:agy-models",
    name: "agy-models",
    description: "Refresh and list Google Antigravity (agy acp) models",
    handler: async () => {
      client.clearCooldown();
      const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
      emitModelsUpdated();
      const lines = [
        `Antigravity ACP models (provider: ${providerId}, source: ${discovery.source}, authenticated: ${String(discovery.authenticated)}):`,
        ...discovery.models.map((m) => `- ${providerId}/${m.id} (${m.name})`),
      ];
      if (discovery.error) {
        lines.push(`Note: ${discovery.error}`);
      }
      return { kind: "success", text: lines.join("\n") };
    },
  });

  registerOne({
    definitionId: "@local/dsh-agi:agy-status",
    name: "agy-status",
    description: "Show Google Antigravity ACP runtime and authentication status",
    handler: async () => {
      const status = client.status();
      const lines = [
        `Antigravity ACP status:`,
        `- provider: ${providerId} (${providerName})`,
        `- agyBin: ${status.agyBin}`,
        `- geminiDir: ${status.geminiDir || "(default ~/.gemini)"}`,
        `- appDataDir: ${status.appDataDir || "(default antigravity-cli)"}`,
        `- running: ${String(status.running)}`,
        `- authenticated: ${String(status.authenticated)}`,
        `- activeSessions: ${String(status.activeSessions)}`,
        `- modelsCount: ${String(status.modelsCount)} (${status.modelSource})`,
        `- loginCommand: ${status.loginCommand}`,
      ];
      if (status.lastError) {
        lines.push(`- lastError: ${status.lastError}`);
      }
      return { kind: "success", text: lines.join("\n") };
    },
  });

  return () => {
    while (disposers.length > 0) {
      const fn = disposers.pop();
      try {
        fn();
      } catch {
        // ignore disposal errors
      }
    }
  };
}

export function apply(ctx, config = {}) {
  const providerId = asString(config?.providerId, "agy");
  const providerName = asString(config?.providerName, "Antigravity (ACP)");
  const agyBin = asString(config?.agyBin, process.env.AGY_BIN || "agy");
  const geminiDir = asString(config?.geminiDir, process.env.AGY_GEMINI_DIR || "");
  const appDataDir = asString(config?.appDataDir, process.env.AGY_APP_DATA_DIR || "");
  const authMethod = asString(config?.authMethod, process.env.AGY_AUTH_METHOD || "");
  const autoApprove = asBoolean(config?.autoApprove, true);
  const sandbox = asBoolean(config?.sandbox, false);
  const showToolActivity = asBoolean(config?.showToolActivity, true);
  const cwd = asString(config?.cwd, process.cwd());
  const fallbackModels = parseFallbackModels(config?.fallbackModels);

  const client = new AgyAcpClient({
    agyBin,
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
      const cleanup = registerAgyCommands(cmdCtx, { client, providerId, providerName });
      if (typeof cmdCtx.effect === "function") {
        cmdCtx.effect(function* () {
          yield cleanup;
        }, "agi-acp commands");
      } else {
        disposeCommands = cleanup;
      }
    });
  } else if (ctx.commands) {
    disposeCommands = registerAgyCommands(ctx, { client, providerId, providerName });
  }

  const cleanup = async () => {
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
    .discoverModels({ cwd, forceRefresh: false, timeoutMs: 3000 })
    .then(() => {
      try {
        if (typeof ctx.emit === "function") {
          ctx.emit("llm/models-updated", providerId);
        }
      } catch {
        // ignore
      }
    })
    .catch(() => {});

  return { providerId, providerName, client, adapter, dispose: cleanup };
}

export { AgyDshAdapter };
export default { name, inject, apply };
