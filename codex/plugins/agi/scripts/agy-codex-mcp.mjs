#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { AgyAcpClient } from "./lib/agy-acp-client.mjs";
import { formatOpenAiModelsList } from "./lib/responses-adapter.mjs";
import {
  DEFAULT_CODEX_BRIDGE_HOST,
  DEFAULT_CODEX_BRIDGE_PORT,
  ensureCodexBridgeRunning,
} from "./agy-codex-bridge.mjs";
import { configureCodex } from "./setup-codex.mjs";

const TOOLS = [
  {
    name: "agy_status",
    description:
      "Check Antigravity ACP (agy acp) authentication, local Codex Responses bridge health, and model discovery status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agy_list_models",
    description:
      "List Antigravity ACP models formatted for Codex /model selection (agy/<model-id>).",
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
    description:
      "Force refresh the Antigravity ACP model catalog via the local Codex Responses bridge.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agy_configure_codex",
    description:
      "Generate agy-models.json and write Codex user profile (agy.config.toml) or default config.toml so agy/* models appear natively in /model.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["profile", "default"],
          description:
            "'profile' writes ~/.codex/agy.config.toml (for `codex -p agy`); 'default' updates ~/.codex/config.toml.",
        },
        profileName: {
          type: "string",
          description: "Profile name when mode is 'profile' (default: 'agy').",
        },
        defaultModel: {
          type: "string",
          description: "Default AGY model ID.",
        },
        includeBundled: {
          type: "boolean",
          description: "Include Codex bundled models alongside AGY models in agy-models.json.",
        },
        remove: {
          type: "boolean",
          description: "Remove plugin-managed Codex profile/config and catalog.",
        },
        dryRun: {
          type: "boolean",
          description: "Preview generated config without writing files.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agy_connect",
    description:
      "Inspect or manage official Google Antigravity ACP sign-in (`agy acp --login`, official ACP `authenticate`, or official ACP `logout`) and refresh the Codex bridge & model catalog.",
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
];

function getBridgeHostPort() {
  return {
    host: process.env.AGY_CODEX_HOST || DEFAULT_CODEX_BRIDGE_HOST,
    port: Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
  };
}

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

async function handleToolCall(name, args = {}) {
  const { host, port } = getBridgeHostPort();
  if (name === "agy_status") {
    try {
      const { data } = await fetchBridgeJson("/health", "GET", 2000);
      return { bridgeUrl: `http://${host}:${port}/v1`, running: true, ...data };
    } catch (err) {
      return {
        bridgeUrl: `http://${host}:${port}/v1`,
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
          ...formatOpenAiModelsList(discovery.models),
        };
      } finally {
        await client.dispose();
      }
    }
  }

  if (name === "agy_configure_codex") {
    let models;
    try {
      const { data } = await fetchBridgeJson("/v1/models", "GET", 1500);
      if (Array.isArray(data?.data) && data.data.length > 0) {
        models = data.data.map((m) => ({
          id: m.id.replace(/^agy\//, ""),
          name: m.display_name?.replace(/^AGY\s*·\s*/, "") || m.id,
          description: m.description || "Antigravity ACP model",
        }));
      }
    } catch {
      // use fallback models inside configureCodex
    }

    const result = configureCodex({
      mode: args.mode || "profile",
      profileName: args.profileName || "agy",
      defaultModel: args.defaultModel,
      includeBundled: args.includeBundled !== false,
      remove: Boolean(args.remove),
      dryRun: Boolean(args.dryRun),
      host,
      port,
      ...(models ? { models } : {}),
    });

    if (!args.remove && !args.dryRun && process.env.AGY_AUTO_START_BRIDGE !== "0") {
      result.bridge = await ensureCodexBridgeRunning({
        host,
        port,
        catalogPath: result.catalogPath,
      });
    }
    return result;
  }

  if (name === "agy_connect") {
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
      const methodId =
        typeof args.methodId === "string" && args.methodId.trim()
          ? args.methodId.trim()
          : "gemini-api-key";
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
        if (/fetch failed|ECONNREFUSED|AbortError/i.test(String(err?.message || ""))) {
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
            models: formatOpenAiModelsList(discovery.models).data,
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
        connectScript: "node scripts/agy-codex-connect.mjs",
        tosNote:
          "Uses Google's official unmodified `agy acp` stdio protocol and `agy acp --login`. For third-party/automated harness usage, GEMINI_API_KEY or Gemini Enterprise (oauth-business / agent-platform) is recommended.",
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
          harness: "codex",
          bridgeRunning: false,
          ...client.getAuthInfo(),
          connectScript: "node scripts/agy-codex-connect.mjs",
          tosNote:
            "Uses Google's official unmodified `agy acp` stdio protocol and `agy acp --login`. For third-party/automated harness usage, GEMINI_API_KEY or Gemini Enterprise (oauth-business / agent-platform) is recommended.",
        };
      } finally {
        await client.dispose();
      }
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

export function startMcpServer() {
  if (process.env.AGY_AUTO_START_BRIDGE !== "0") {
    const { host, port } = getBridgeHostPort();
    void ensureCodexBridgeRunning({ host, port, waitMs: 1500 }).catch(() => {});
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
            serverInfo: { name: "agy-codex-mcp", version: "0.2.0" },
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
          result: { tools: TOOLS },
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

const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  startMcpServer();
}
