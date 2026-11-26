import readline from "node:readline";
import { AgyAcpClient } from "./acp-client.mjs";
import {
  listPersistedAccounts,
  removePersistedAccount,
  setActivePersistedAccount,
  upsertPersistedAccount,
} from "./account-store.mjs";
import { normalizeAuthMethodId } from "./acp-errors.mjs";

export const COMMON_MCP_TOOLS = [
  {
    name: "agy_status",
    description:
      "Check Antigravity ACP (agy acp) authentication, local bridge health, and model discovery status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agy_list_models",
    description: "List Antigravity ACP models available for /model selection.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "Force a live model refresh from agy acp.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agy_refresh_models",
    description: "Force refresh the Antigravity ACP model catalog via the local bridge.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agy_connect",
    description:
      "Inspect or manage official Google Antigravity ACP sign-in (`agy acp --login`, official ACP `authenticate`, or official ACP `logout`) and refresh the bridge.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "authenticate", "refresh", "logout"],
          description:
            "'status' shows auth state and official login command; 'authenticate' calls official ACP authenticate (e.g. gemini-api-key, oauth-business, agent-platform); 'refresh' restarts/refreshes after interactive `agy acp --login`; 'logout' calls official ACP logout.",
        },
        methodId: {
          type: "string",
          description:
            "Official ACP auth method ID when action='authenticate' (gemini-api-key, oauth-business, agent-platform).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agy_accounts",
    description:
      "List, add, switch, or remove Antigravity ACP accounts, each saved in its own isolated data folder (--gemini-dir).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "switch", "remove"],
          description: "Account action to perform (default: 'list').",
        },
        name: {
          type: "string",
          description: "Account name (e.g. 'default', 'work', 'personal').",
        },
        dataDir: {
          type: "string",
          description: "Custom data directory path for this account (defaults to ~/.agi/accounts/<name>).",
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
          description: "Optional display label for this account.",
        },
        activate: {
          type: "boolean",
          description: "Switch to the added account immediately (default: true).",
        },
        purgeData: {
          type: "boolean",
          description: "When action='remove', also delete the account's data folder.",
        },
        force: {
          type: "boolean",
          description: "Allow reusing a data folder already assigned to another account.",
        },
      },
      additionalProperties: false,
    },
  },
];

function isBridgeUnreachableError(err) {
  return /fetch failed|ECONNREFUSED|AbortError/i.test(String(err?.message || ""));
}

const TOS_NOTE =
  "Uses Google's official unmodified `agy acp` stdio protocol and `agy acp --login`. For third-party/automated harness usage, GEMINI_API_KEY or Gemini Enterprise (oauth-business / agent-platform) is recommended.";

/**
 * Shared stdio MCP JSON-RPC server factory for bridge-backed harnesses (OCP + DIP).
 */
export function createAgyMcpServer({
  serverName,
  version = "0.3.0",
  harness,
  statusUrlSuffix = "",
  getBridgeHostPort,
  ensureBridgeRunning,
  formatModelsList,
  connectHintKey = "connectCommand",
  connectHintValue,
  extraTools = [],
  handleExtraTool,
}) {
  const tools = [...COMMON_MCP_TOOLS, ...extraTools];

  async function fetchBridgeJson(pathname, method = "GET", timeoutMs = 4000, body = undefined) {
    const { host, port } = getBridgeHostPort();
    const headers = body !== undefined ? { "Content-Type": "application/json" } : undefined;
    const res = await fetch(`http://${host}:${port}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  async function handleAccountTool(args = {}) {
    const action = args.action || "list";
    if (action === "list") {
      try {
        const { status, data } = await fetchBridgeJson("/v1/accounts", "GET", 4000);
        if (status >= 400) {
          throw new Error(data?.error?.message || `Failed to list accounts (${status})`);
        }
        return { bridgeReachable: true, ...data };
      } catch (err) {
        if (!isBridgeUnreachableError(err)) throw err;
        return {
          ok: true,
          harness,
          bridgeReachable: false,
          ...listPersistedAccounts(process.env),
        };
      }
    }

    if (action === "add") {
      const payload = {
        name: args.name,
        ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
        ...(args.appDataDir !== undefined ? { appDataDir: args.appDataDir } : {}),
        ...(args.authMethod !== undefined ? { authMethod: args.authMethod } : {}),
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.activate !== undefined ? { activate: Boolean(args.activate) } : {}),
        ...(args.force !== undefined ? { force: Boolean(args.force) } : {}),
      };
      try {
        const { status, data } = await fetchBridgeJson("/v1/accounts", "POST", 10000, payload);
        if (status >= 400) {
          throw new Error(data?.error?.message || `Failed to add account (${status})`);
        }
        return { bridgeReachable: true, ...data };
      } catch (err) {
        if (!isBridgeUnreachableError(err)) throw err;
        const added = upsertPersistedAccount(payload, process.env);
        return {
          ok: true,
          bridgeReachable: false,
          account: added.account,
          activeAccount: added.activeAccount,
        };
      }
    }

    if (action === "switch") {
      const accountName = args.name || "";
      try {
        const { status, data } = await fetchBridgeJson("/v1/accounts/switch", "POST", 10000, {
          name: accountName,
        });
        if (status >= 400) {
          throw new Error(data?.error?.message || `Failed to switch account (${status})`);
        }
        return { bridgeReachable: true, ...data };
      } catch (err) {
        if (!isBridgeUnreachableError(err)) throw err;
        const switched = setActivePersistedAccount(accountName, process.env);
        return {
          ok: true,
          bridgeReachable: false,
          account: switched.activeAccount,
          dataDir: switched.account.geminiDir,
          geminiDir: switched.account.geminiDir,
          appDataDir: switched.account.appDataDir,
        };
      }
    }

    if (action === "remove") {
      const payload = {
        name: args.name || "",
        purgeData: Boolean(args.purgeData),
      };
      try {
        const { status, data } = await fetchBridgeJson("/v1/accounts/remove", "POST", 8000, payload);
        if (status >= 400) {
          throw new Error(data?.error?.message || `Failed to remove account (${status})`);
        }
        return { bridgeReachable: true, ...data };
      } catch (err) {
        if (!isBridgeUnreachableError(err)) throw err;
        const rm = removePersistedAccount(
          payload.name,
          { purgeData: payload.purgeData },
          process.env,
        );
        return {
          ok: true,
          bridgeReachable: false,
          removed: rm.removed,
          purgedData: rm.purgedData,
          activeAccount: rm.activeAccount,
        };
      }
    }

    throw new Error(`Unknown agy_accounts action: ${action}`);
  }

  async function handleConnectTool(args = {}) {
    const action = args.action || "status";
    if (action === "logout") {
      try {
        const { data } = await fetchBridgeJson("/v1/auth/logout", "POST", 8000);
        return data;
      } catch {
        const client = new AgyAcpClient();
        try {
          const res = await client.logout(8000);
          return { ...res, loginCommand: client.formatLoginCommand() };
        } finally {
          await client.dispose();
        }
      }
    }

    if (action === "authenticate") {
      const methodId = normalizeAuthMethodId(args.methodId, "gemini-api-key");
      try {
        const { status, data } = await fetchBridgeJson(
          "/v1/auth/authenticate",
          "POST",
          10000,
          { methodId },
        );
        if (status >= 400) {
          throw new Error(data?.error?.message || `Authentication failed (${status})`);
        }
        return data;
      } catch (err) {
        if (isBridgeUnreachableError(err)) {
          const client = new AgyAcpClient();
          try {
            await client.authenticate(methodId, 10000);
            const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
            return {
              ok: true,
              methodId,
              authenticated: discovery.authenticated,
              source: discovery.source,
              modelsCount: discovery.models.length,
            };
          } finally {
            await client.dispose();
          }
        }
        throw err;
      }
    }

    if (action === "refresh") {
      try {
        const { data } = await fetchBridgeJson("/v1/refresh?restart=1", "POST", 8000);
        return data;
      } catch {
        const client = new AgyAcpClient();
        try {
          const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
          return {
            ok: true,
            source: discovery.source,
            authenticated: discovery.authenticated,
            error: discovery.error || null,
            models: formatModelsList(discovery.models).data,
          };
        } finally {
          await client.dispose();
        }
      }
    }

    try {
      const { data } = await fetchBridgeJson("/v1/auth", "GET", 4000);
      return {
        ...data,
        ...(connectHintValue ? { [connectHintKey]: connectHintValue } : {}),
        tosNote: TOS_NOTE,
      };
    } catch {
      const client = new AgyAcpClient();
      try {
        try {
          await client.initialize(4000);
        } catch {
          // ignore init failure when reporting status
        }
        return {
          ok: true,
          harness,
          bridgeRunning: false,
          ...client.getAuthInfo(),
          ...(connectHintValue ? { [connectHintKey]: connectHintValue } : {}),
          tosNote: TOS_NOTE,
        };
      } finally {
        await client.dispose();
      }
    }
  }

  async function handleToolCall(name, args = {}) {
    const { host, port } = getBridgeHostPort();
    if (name === "agy_status") {
      try {
        const { data } = await fetchBridgeJson("/health", "GET", 2000);
        return { bridgeUrl: `http://${host}:${port}${statusUrlSuffix}`, running: true, ...data };
      } catch (err) {
        return {
          bridgeUrl: `http://${host}:${port}${statusUrlSuffix}`,
          running: false,
          error: err.message,
        };
      }
    }

    if (name === "agy_list_models" || name === "agy_refresh_models") {
      const refresh = name === "agy_refresh_models" || Boolean(args?.refresh);
      try {
        const { data } = await fetchBridgeJson(
          refresh ? "/v1/refresh" : "/v1/models",
          refresh ? "POST" : "GET",
          8000,
        );
        return data;
      } catch {
        const client = new AgyAcpClient();
        try {
          const discovery = await client.discoverModels({ forceRefresh: refresh });
          return {
            source: discovery.source,
            authenticated: discovery.authenticated,
            error: discovery.error || null,
            ...formatModelsList(discovery.models),
          };
        } finally {
          await client.dispose();
        }
      }
    }

    if (name === "agy_connect") return handleConnectTool(args);
    if (name === "agy_accounts") return handleAccountTool(args);

    if (typeof handleExtraTool === "function") {
      const res = await handleExtraTool(name, args, { host, port, fetchBridgeJson });
      if (res !== undefined) return res;
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  function start() {
    if (process.env.AGY_AUTO_START_BRIDGE !== "0" && typeof ensureBridgeRunning === "function") {
      const { host, port } = getBridgeHostPort();
      void ensureBridgeRunning({ host, port, waitMs: 1500 }).catch(() => {});
    }

    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    const write = (payload) => {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    };

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (msg.id === undefined || msg.id === null) {
        return;
      }

      try {
        if (msg.method === "initialize") {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: msg.params?.protocolVersion || "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: serverName, version },
            },
          });
          return;
        }

        if (msg.method === "ping") {
          write({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }

        if (msg.method === "tools/list") {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools },
          });
          return;
        }

        if (msg.method === "tools/call") {
          const name = msg.params?.name;
          const args = msg.params?.arguments || {};
          try {
            const data = await handleToolCall(name, args);
            write({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
              },
            });
          } catch (err) {
            write({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                isError: true,
                content: [{ type: "text", text: err.message || String(err) }],
              },
            });
          }
          return;
        }

        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
      } catch (err) {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: err.message || String(err) },
        });
      }
    });
  }

  return { tools, handleToolCall, start };
}
