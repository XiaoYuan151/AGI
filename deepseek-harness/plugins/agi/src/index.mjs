import {
  AgyAcpClient,
  parseFallbackModels,
  removePersistedAccount,
  upsertPersistedAccount,
} from "./lib/agy-acp-client.mjs";
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

function tokenizeArgs(raw) {
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function parseDshAccountArgs(raw) {
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
  let dataDir;
  let appDataDir;
  let authMethod;
  let label;
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
          const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 20000 });
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
        const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 20000 });
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
      const discovery = await client.discoverModels({ forceRefresh: false, timeoutMs: 20000 });
      const info = client.getAuthInfo();
      const lines = [
        `Antigravity ACP (${providerName}) authentication:`,
        `- account: ${info.account || "(default)"}`,
        `- authenticated: ${String(discovery.authenticated)} (${discovery.models.length} models, source: ${discovery.source})`,
        `- isolated profile: --gemini-dir ${info.geminiDir || "(default ~/.gemini)"} --app-data-dir ${info.appDataDir || "antigravity-cli"}`,
        `- official sign-in command: \`${info.loginCommand}\``,
        `- or use API key / Enterprise (recommended for Google ToS compliance): export \`GEMINI_API_KEY\` then run \`/agy-connect method gemini-api-key\``,
        `- subcommands: \`/agy-connect refresh\` | \`/agy-connect method <id>\` | \`/agy-connect logout\` | \`/agy-accounts\``,
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
      const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 20000 });
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
        `- account: ${status.account || "(default)"}`,
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

  registerOne({
    definitionId: "@local/dsh-agi:agy-accounts",
    name: "agy-accounts",
    description:
      "Manage multiple Antigravity ACP accounts with isolated data folders",
    input: {
      hint: "[list | add <name> [--data-dir <dir>] | use <name> | remove <name> [--purge]]",
    },
    handler: async (invocation) => {
      const raw = String(invocation?.rawInput || "").trim();
      const parsed = parseDshAccountArgs(raw);
      try {
        if (parsed.sub === "add") {
          if (!parsed.name) {
            return {
              kind: "error",
              text: "Usage: /agy-accounts add <name> [--data-dir <dir>] [--app-data-dir <name>] [--method <id>] [--no-activate]",
            };
          }
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
            await client.discoverModels({ forceRefresh: true, timeoutMs: 20000 });
            emitModelsUpdated();
          }
          return {
            kind: "success",
            text: [
              `Added account '${added.account.name}' (dataDir=${added.account.geminiDir}, active=${added.activeAccount === added.account.name}).`,
              `Sign in for this account by running \`${client.formatLoginCommand()}\` or \`/agy-connect method gemini-api-key\`.`,
            ].join("\n"),
          };
        }

        if (parsed.sub === "use") {
          if (!parsed.name) {
            return { kind: "error", text: "Usage: /agy-accounts use <name>" };
          }
          const switched = await client.switchAccount(parsed.name);
          const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 20000 });
          emitModelsUpdated();
          return {
            kind: "success",
            text: [
              `Switched active account to '${switched.account}' (dataDir=${switched.dataDir}).`,
              `authenticated=${String(discovery.authenticated)}, models=${discovery.models.length} (${discovery.source}).`,
              ...(discovery.authenticated === false
                ? [`Sign in with \`${switched.loginCommand}\` or \`/agy-connect method gemini-api-key\`.`]
                : []),
            ].join("\n"),
          };
        }

        if (parsed.sub === "remove") {
          if (!parsed.name) {
            return { kind: "error", text: "Usage: /agy-accounts remove <name> [--purge]" };
          }
          const prevAccount = client.account;
          const rm = removePersistedAccount(
            parsed.name,
            { purgeData: parsed.purgeData },
            client.env,
          );
          if (prevAccount === rm.removed.name || rm.activeAccount !== prevAccount) {
            client.reloadPersistedConfig({ account: rm.activeAccount || "" });
            await client.restart();
            await client.discoverModels({ forceRefresh: true, timeoutMs: 20000 });
            emitModelsUpdated();
          }
          return {
            kind: "success",
            text: `Removed account '${rm.removed.name}' (purgedData=${rm.purgedData}, activeAccount=${rm.activeAccount || "none"}).`,
          };
        }

        const listed = client.listAccounts();
        if (listed.accounts.length === 0) {
          return {
            kind: "success",
            text: [
              `No named accounts configured yet (${listed.configPath || "~/.agi/acp.json"}).`,
              "Run `/agy-accounts add <name> --data-dir <dir>` to create one.",
            ].join("\n"),
          };
        }
        return {
          kind: "success",
          text: [
            `Antigravity ACP accounts (active: ${listed.activeAccount || "none"}):`,
            ...listed.accounts.map(
              (a) =>
                `- ${a.isCurrent ? "*" : " "} ${a.name} -> ${a.geminiDir || "(default)"} (appDataDir=${a.appDataDir || "default"})`,
            ),
          ].join("\n"),
        };
      } catch (err) {
        return {
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        };
      }
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
  const account = asString(config?.account, process.env.AGY_ACCOUNT || "");
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
    .discoverModels({ cwd, forceRefresh: false, timeoutMs: 20000 })
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
