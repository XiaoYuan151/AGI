#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgyMcpServer } from "./lib/core/index.mjs";
import { formatAnthropicModelsList } from "./lib/anthropic-adapter.mjs";
import {
  DEFAULT_CLAUDE_BRIDGE_HOST,
  DEFAULT_CLAUDE_BRIDGE_PORT,
  ensureClaudeBridgeRunning,
} from "./agy-claude-bridge.mjs";
import { configureClaudeSettings } from "./setup-claude.mjs";

const CLAUDE_EXTRA_TOOLS = [
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

const mcp = createAgyMcpServer({
  serverName: "agy-claude-mcp",
  version: "0.3.0",
  harness: "claude-code",
  getBridgeHostPort,
  ensureBridgeRunning: ensureClaudeBridgeRunning,
  formatModelsList: formatAnthropicModelsList,
  connectHintKey: "connectCommand",
  connectHintValue: "agy-claude-connect",
  extraTools: CLAUDE_EXTRA_TOOLS,
  async handleExtraTool(name, args, { host, port, fetchBridgeJson }) {
    if (name !== "agy_configure_claude") return undefined;
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
  },
});

export function startMcpServer() {
  mcp.start();
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
