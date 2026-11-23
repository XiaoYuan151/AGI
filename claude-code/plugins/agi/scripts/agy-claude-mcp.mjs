#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { AgyAcpClient } from "./lib/agy-acp-client.mjs";
import { formatAnthropicModelsList } from "./lib/anthropic-adapter.mjs";
import {
  DEFAULT_CLAUDE_BRIDGE_HOST,
  DEFAULT_CLAUDE_BRIDGE_PORT,
  ensureClaudeBridgeRunning,
} from "./agy-claude-bridge.mjs";
import { configureClaudeSettings } from "./setup-claude.mjs";

const TOOLS = [
  {
    name: "agy_status",
    description:
      "Check Antigravity ACP (agy acp) authentication, local Claude bridge health, and model discovery status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agy_list_models",
    description:
      "List Antigravity ACP models formatted for Claude Code's /model selector (anthropic-agy/<model-id>).",
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
      "Force refresh the Antigravity ACP model catalog via the local Claude bridge.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "agy_configure_claude",
    description:
      "Configure Claude Code settings.json so agy acp models appear natively in /model and route through the local bridge.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["user", "local"],
          description: "Write to ~/.claude/settings.json ('user') or .claude/settings.local.json ('local').",
        },
        authMode: {
          type: "string",
          enum: ["auto", "preserve", "local-token"],
          description:
            "Credential handling: 'auto' preserves existing keys/login, 'local-token' sets ANTHROPIC_AUTH_TOKEN=agy-acp-local for full gateway /v1/models discovery without an Anthropic account.",
        },
        defaultModel: {
          type: "string",
          description: "Default AGY model ID for ANTHROPIC_CUSTOM_MODEL_OPTION.",
        },
        includeModelPicker: {
          type: "boolean",
          description: "Also populate user settings modelPicker options (Claude Code >= 2.1.242).",
        },
        remove: {
          type: "boolean",
          description: "Remove AGY bridge keys from Claude Code settings.",
        },
        dryRun: {
          type: "boolean",
          description: "Preview settings changes without writing disk.",
        },
      },
      additionalProperties: false,
    },
  },
];

function getBridgeHostPort() {
  return {
    host: process.env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_BRIDGE_HOST,
    port: Number(process.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT),
  };
}

async function fetchBridgeJson(pathname, method = "GET", timeoutMs = 4000) {
  const { host, port } = getBridgeHostPort();
  const res = await fetch(`http://${host}:${port}${pathname}`, {
    method,
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
      return { bridgeUrl: `http://${host}:${port}`, running: true, ...data };
    } catch (err) {
      return {
        bridgeUrl: `http://${host}:${port}`,
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
          ...formatAnthropicModelsList(discovery.models),
        };
      } finally {
        await client.dispose();
      }
    }
  }

  if (name === "agy_configure_claude") {
    let models;
    try {
      const { data } = await fetchBridgeJson("/v1/models", "GET", 1500);
      if (Array.isArray(data?.data) && data.data.length > 0) {
        models = data.data.map((m) => ({
          id: m.id.replace(/^anthropic-agy\//, ""),
          name: m.display_name?.replace(/^AGY\s*·\s*/, "") || m.id,
          description: m.description || "Antigravity ACP model",
        }));
      }
    } catch {
      // use fallback models inside configureClaudeSettings
    }
    const result = configureClaudeSettings({
      scope: args.scope || "user",
      authMode: args.authMode || "auto",
      defaultModel: args.defaultModel,
      includeModelPicker: Boolean(args.includeModelPicker),
      remove: Boolean(args.remove),
      dryRun: Boolean(args.dryRun),
      host,
      port,
      ...(models ? { models } : {}),
    });
    if (!args.remove && !args.dryRun && process.env.AGY_AUTO_START_BRIDGE !== "0") {
      result.bridge = await ensureClaudeBridgeRunning({ host, port });
    }
    return result;
  }

  throw new Error(`Unknown tool: ${name}`);
}

export function startMcpServer() {
  if (process.env.AGY_AUTO_START_BRIDGE !== "0") {
    const { host, port } = getBridgeHostPort();
    void ensureClaudeBridgeRunning({ host, port, waitMs: 1500 }).catch(() => {});
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
            serverInfo: { name: "agy-claude-mcp", version: "0.2.0" },
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
