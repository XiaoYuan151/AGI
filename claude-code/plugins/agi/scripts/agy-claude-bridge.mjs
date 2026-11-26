#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgyAcpClient,
  createAgyBridgeServer,
  ensureBridgeDaemon,
  fetchBridgeHealth,
  readRawBody,
  sendJson,
} from "./lib/core/index.mjs";
import {
  estimateAnthropicTokens,
  formatAnthropicModelsList,
  handleAnthropicJson,
  proxyToUpstreamAnthropic,
  resolveAgyModelId,
  sendAnthropicError,
  streamAnthropicSse,
} from "./lib/anthropic-adapter.mjs";

export const DEFAULT_CLAUDE_BRIDGE_PORT = 43110;
export const DEFAULT_CLAUDE_BRIDGE_HOST = "127.0.0.1";

function defaultStateDir() {
  return path.join(os.homedir(), ".cache", "agy-claude-bridge");
}

function mapErrorType(kind) {
  if (kind === "invalid_json" || kind === "invalid_request") return "invalid_request_error";
  if (kind === "not_found") return "not_found_error";
  return "api_error";
}

export function createClaudeBridgeServer(options = {}) {
  const upstreamUrl =
    options.upstreamUrl ||
    process.env.AGY_UPSTREAM_ANTHROPIC_URL ||
    "https://api.anthropic.com";

  return createAgyBridgeServer(
    { ...options, upstreamUrl },
    {
      harness: "claude-code",
      defaultHost: DEFAULT_CLAUDE_BRIDGE_HOST,
      defaultPort: DEFAULT_CLAUDE_BRIDGE_PORT,
      formatModelsList: formatAnthropicModelsList,
      sendError: (res, status, kind, message) =>
        sendAnthropicError(res, status, mapErrorType(kind), message),
      async handleCustomRoute({
        req,
        res,
        url,
        pathname,
        acpClient,
        cachedModels,
        refreshModels,
        defaultCwd,
        showToolActivity,
      }) {
        if (req.method === "HEAD" && pathname === "/api/hello") {
          res.writeHead(200);
          res.end();
          return true;
        }

        if (req.method === "GET" && pathname === "/v1/models") {
          const force = url.searchParams.get("refresh") === "1";
          const discovery = await refreshModels({
            forceRefresh: force,
            timeoutMs: 15000,
          });
          const formatted = formatAnthropicModelsList(discovery.models);
          const limitRaw = url.searchParams.get("limit");
          if (limitRaw) {
            const limit = Number(limitRaw);
            if (Number.isFinite(limit) && limit > 0) {
              formatted.data = formatted.data.slice(0, limit);
              formatted.first_id = formatted.data[0]?.id ?? null;
              formatted.last_id = formatted.data[formatted.data.length - 1]?.id ?? null;
            }
          }
          sendJson(res, 200, formatted);
          return true;
        }

        if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
          const rawBody = await readRawBody(req);
          let body;
          try {
            body = JSON.parse(rawBody.toString("utf8"));
          } catch {
            sendAnthropicError(res, 400, "invalid_request_error", "Invalid JSON body");
            return true;
          }
          const knownIds = cachedModels.map((m) => m.id);
          const agyModel = resolveAgyModelId(body?.model, knownIds);
          if (agyModel) {
            sendJson(res, 200, { input_tokens: estimateAnthropicTokens(body) });
            return true;
          }
          await proxyToUpstreamAnthropic(req, res, rawBody, upstreamUrl);
          return true;
        }

        if (req.method === "POST" && pathname === "/v1/messages") {
          const rawBody = await readRawBody(req);
          let body;
          try {
            body = JSON.parse(rawBody.toString("utf8"));
          } catch {
            sendAnthropicError(res, 400, "invalid_request_error", "Invalid JSON body");
            return true;
          }
          const knownIds = cachedModels.map((m) => m.id);
          const agyModel = resolveAgyModelId(body?.model, knownIds);
          if (agyModel) {
            if (body?.stream === false) {
              await handleAnthropicJson(req, res, body, agyModel, acpClient, {
                defaultCwd,
                showToolActivity,
              });
            } else {
              await streamAnthropicSse(req, res, body, agyModel, acpClient, {
                defaultCwd,
                showToolActivity,
              });
            }
            return true;
          }
          await proxyToUpstreamAnthropic(req, res, rawBody, upstreamUrl);
          return true;
        }

        return false;
      },
    },
  );
}

export async function ensureClaudeBridgeRunning({
  host = DEFAULT_CLAUDE_BRIDGE_HOST,
  port = Number(process.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT),
  stateDir = defaultStateDir(),
  waitMs = 3000,
} = {}) {
  return ensureBridgeDaemon({
    host,
    port,
    stateDir,
    scriptPath: fileURLToPath(import.meta.url),
    waitMs,
  });
}

function parseCliArgs(argv) {
  const args = {
    command: "start",
    port: Number(process.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT),
    host: process.env.AGY_CLAUDE_HOST || DEFAULT_CLAUDE_BRIDGE_HOST,
    stateDir: process.env.AGY_CLAUDE_STATE_DIR || defaultStateDir(),
    daemon: false,
    refresh: false,
    json: false,
  };

  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) {
    args.command = rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--port" && rest[i + 1]) args.port = Number(rest[++i]);
    else if (token === "--host" && rest[i + 1]) args.host = rest[++i];
    else if (token === "--state-dir" && rest[i + 1]) args.stateDir = rest[++i];
    else if (token === "--daemon") args.daemon = true;
    else if (token === "--refresh") args.refresh = true;
    else if (token === "--json") args.json = true;
    else if (token === "--help" || token === "-h") args.command = "help";
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const pidFile = path.join(args.stateDir, "bridge.pid");

  if (args.command === "help") {
    console.log(
      [
        "Usage: agy-claude-bridge <start|ensure|status|stop|models> [options]",
        "",
        "Options:",
        "  --port <n>        Listen port (default: 43110 or AGY_CLAUDE_PORT)",
        "  --host <addr>     Listen host (default: 127.0.0.1)",
        "  --state-dir <dir> State/log directory",
        "  --daemon          Run in background",
        "  --refresh         Force refresh model list from agy acp",
        "  --json            JSON output",
      ].join("\n"),
    );
    return;
  }

  if (args.command === "status") {
    const health = await fetchBridgeHealth(args.host, args.port, 1500);
    if (args.json) {
      console.log(JSON.stringify({ running: Boolean(health?.ok), health }, null, 2));
    } else if (health?.ok) {
      console.log(
        `agy-claude-bridge running at http://${args.host}:${args.port} (models=${health.modelsCount}, source=${health.modelSource}, authenticated=${health.authenticated})`,
      );
    } else {
      console.log(`agy-claude-bridge not running on http://${args.host}:${args.port}`);
    }
    process.exitCode = health?.ok ? 0 : 1;
    return;
  }

  if (args.command === "stop") {
    let pid = null;
    if (fs.existsSync(pidFile)) {
      pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    }
    if (!pid || !Number.isFinite(pid)) {
      console.log("No bridge PID file found.");
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
      fs.unlinkSync(pidFile);
      console.log(`Stopped agy-claude-bridge (pid ${pid}).`);
    } catch (err) {
      console.error(`Failed to stop pid ${pid}: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "models") {
    const health = await fetchBridgeHealth(args.host, args.port, 800);
    if (health?.ok) {
      const endpoint = args.refresh
        ? `http://${args.host}:${args.port}/v1/refresh`
        : `http://${args.host}:${args.port}/v1/models`;
      const res = await fetch(endpoint, { method: args.refresh ? "POST" : "GET" });
      console.log(JSON.stringify(await res.json(), null, 2));
      return;
    }
    const client = new AgyAcpClient();
    try {
      const discovery = await client.discoverModels({ forceRefresh: true });
      console.log(JSON.stringify(formatAnthropicModelsList(discovery.models), null, 2));
    } finally {
      await client.dispose();
    }
    return;
  }

  if (args.command === "ensure") {
    const res = await ensureClaudeBridgeRunning({
      host: args.host,
      port: args.port,
      stateDir: args.stateDir,
    });
    if (args.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(
        res.alreadyRunning
          ? `agy-claude-bridge already running on http://${args.host}:${args.port}`
          : `Started agy-claude-bridge on http://${args.host}:${args.port} (pid=${res.pid ?? "unknown"})`,
      );
    }
    return;
  }

  if (args.command === "start") {
    if (args.daemon) {
      const res = await ensureClaudeBridgeRunning({
        host: args.host,
        port: args.port,
        stateDir: args.stateDir,
      });
      console.log(
        JSON.stringify({
          ok: Boolean(res.health?.ok),
          url: `http://${args.host}:${args.port}`,
          pid: res.pid ?? null,
        }),
      );
      return;
    }

    fs.mkdirSync(args.stateDir, { recursive: true });
    fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
    const bridge = createClaudeBridgeServer({ host: args.host, port: args.port });
    const addr = await bridge.start();
    void bridge.refreshModels({ forceRefresh: false, timeoutMs: 20000 });
    console.log(`agy-claude-bridge listening on http://${addr.host}:${addr.port}`);

    const shutdown = async () => {
      try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      } catch {
        // ignore
      }
      await bridge.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
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
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
