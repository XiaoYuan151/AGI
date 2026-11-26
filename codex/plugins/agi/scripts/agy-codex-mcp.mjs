#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createAgyMcpServer } from "./lib/core/index.mjs";
import { formatOpenAiModelsList } from "./lib/responses-adapter.mjs";
import {
  DEFAULT_CODEX_BRIDGE_HOST,
  DEFAULT_CODEX_BRIDGE_PORT,
  ensureCodexBridgeRunning,
} from "./agy-codex-bridge.mjs";
import { configureCodex } from "./setup-codex.mjs";

const CODEX_EXTRA_TOOLS = [
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
];

function getBridgeHostPort() {
  return {
    host: process.env.AGY_CODEX_HOST || DEFAULT_CODEX_BRIDGE_HOST,
    port: Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
  };
}

const mcp = createAgyMcpServer({
  serverName: "agy-codex-mcp",
  version: "0.3.0",
  harness: "codex",
  statusUrlSuffix: "/v1",
  getBridgeHostPort,
  ensureBridgeRunning: ensureCodexBridgeRunning,
  formatModelsList: formatOpenAiModelsList,
  connectHintKey: "connectScript",
  connectHintValue: "node scripts/agy-codex-connect.mjs",
  extraTools: CODEX_EXTRA_TOOLS,
  async handleExtraTool(name, args, { host, port, fetchBridgeJson }) {
    if (name !== "agy_configure_codex") return undefined;
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
