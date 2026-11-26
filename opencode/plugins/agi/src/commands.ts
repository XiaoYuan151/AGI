import type * as OpenCode from "@opencode/plugin";
import {
  type AgyAcpClient,
  type AgyDiscoveryResult,
  removePersistedAccount,
  upsertPersistedAccount,
} from "./acp-client";

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

export interface AgyCommandDeps {
  ctx: OpenCode.PluginContext;
  client: AgyAcpClient;
  providerIdStr: string;
  providerName: string;
  discoveryRpcTimeoutMs: number;
  getDiscovery: () => AgyDiscoveryResult;
  refreshCatalog: (forceRefresh: boolean, timeoutMs?: number) => Promise<AgyDiscoveryResult>;
  reloadIntegrations: () => Promise<void>;
}

export function registerAgyCommands(
  editor: Parameters<Parameters<OpenCode.PluginContext["command"]["transform"]>[0]>[0],
  deps: AgyCommandDeps,
): void {
  const {
    ctx,
    client,
    providerIdStr,
    providerName,
    discoveryRpcTimeoutMs,
    getDiscovery,
    refreshCatalog,
    reloadIntegrations,
  } = deps;

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
      const currentDiscovery = getDiscovery();
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
          text =
            "Usage: `/agy-accounts add <name> [--data-dir <dir>] [--app-data-dir <name>] [--method <id>] [--no-activate]`";
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
            await reloadIntegrations();
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
          await reloadIntegrations();
          text = [
            `Switched active account to \`${switched.account}\` (dataDir: \`${switched.dataDir}\`).`,
            `authenticated=${String(res.authenticated)}, models=${res.models.length} (${res.source}).`,
            ...(res.authenticated === false
              ? [`Sign in with \`${switched.loginCommand}\` or \`/connect\`.`]
              : []),
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
            await reloadIntegrations();
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
}
