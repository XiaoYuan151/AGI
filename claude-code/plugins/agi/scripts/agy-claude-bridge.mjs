#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgyAcpClient } from "./lib/agy-acp-client.mjs";
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

function readRawBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function createClaudeBridgeServer(options = {}) {
  const host = options.host || DEFAULT_CLAUDE_BRIDGE_HOST;
  const port = options.port ?? DEFAULT_CLAUDE_BRIDGE_PORT;
  const defaultCwd = options.cwd || process.cwd();
  const upstreamUrl =
    options.upstreamUrl ||
    process.env.AGY_UPSTREAM_ANTHROPIC_URL ||
    "https://api.anthropic.com";
  const showToolActivity = options.showToolActivity !== false;
  const acpClient =
    options.acpClient ||
    new AgyAcpClient({
      cwd: defaultCwd,
      ...(options.acpOptions || {}),
    });

  let cachedModels = [...acpClient.fallbackModels];
  let cachedDiscovery = {
    models: cachedModels,
    source: "fallback",
    authenticated: null,
  };

  async function refreshModels({ forceRefresh = false, timeoutMs = 4000 } = {}) {
    const discovery = await acpClient.discoverModels({
      cwd: defaultCwd,
      forceRefresh,
      timeoutMs,
    });
    cachedDiscovery = discovery;
    cachedModels = discovery.models || acpClient.fallbackModels;
    return discovery;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      const pathname = url.pathname;

      if (req.method === "HEAD" && pathname === "/api/hello") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === "GET" && pathname === "/health") {
        const acpStatus = acpClient.status();
        sendJson(res, 200, {
          ok: true,
          harness: "claude-code",
          host,
          port: server.address()?.port ?? port,
          modelsCount: cachedModels.length,
          modelSource: cachedDiscovery.source,
          authenticated: cachedDiscovery.authenticated,
          acp: acpStatus,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        const force = url.searchParams.get("refresh") === "1";
        const discovery = await refreshModels({
          forceRefresh: force,
          timeoutMs: 2500,
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
        return;
      }

      if (req.method === "POST" && pathname === "/v1/refresh") {
        const discovery = await refreshModels({
          forceRefresh: true,
          timeoutMs: 8000,
        });
        sendJson(res, 200, {
          ok: true,
          source: discovery.source,
          authenticated: discovery.authenticated,
          error: discovery.error || null,
          models: formatAnthropicModelsList(discovery.models).data,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        const rawBody = await readRawBody(req);
        let body;
        try {
          body = JSON.parse(rawBody.toString("utf8"));
        } catch {
          sendAnthropicError(res, 400, "invalid_request_error", "Invalid JSON body");
          return;
        }
        const knownIds = cachedModels.map((m) => m.id);
        const agyModel = resolveAgyModelId(body?.model, knownIds);
        if (agyModel) {
          sendJson(res, 200, { input_tokens: estimateAnthropicTokens(body) });
          return;
        }
        await proxyToUpstreamAnthropic(req, res, rawBody, upstreamUrl);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages") {
        const rawBody = await readRawBody(req);
        let body;
        try {
          body = JSON.parse(rawBody.toString("utf8"));
        } catch {
          sendAnthropicError(res, 400, "invalid_request_error", "Invalid JSON body");
          return;
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
          return;
        }
        await proxyToUpstreamAnthropic(req, res, rawBody, upstreamUrl);
        return;
      }

      sendAnthropicError(
        res,
        404,
        "not_found_error",
        `Unknown route: ${req.method} ${pathname}`,
      );
    } catch (err) {
      if (!res.headersSent) {
        sendAnthropicError(
          res,
          500,
          "api_error",
          err?.message || "Internal bridge error",
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  async function start() {
    await new Promise((resolve, reject) => {
      const onErr = (err) => {
        server.off("listening", onListen);
        reject(err);
      };
      const onListen = () => {
        server.off("error", onErr);
        resolve();
      };
      server.once("error", onErr);
      server.once("listening", onListen);
      server.listen(port, host);
    });
    const addr = server.address();
    return {
      host,
      port: typeof addr === "object" && addr ? addr.port : port,
    };
  }

  async function stop() {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    await acpClient.dispose();
  }

  return {
    server,
    acpClient,
    refreshModels,
    start,
    stop,
    get port() {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : port;
    },
    getUrl() {
      return `http://${host}:${this.port}`;
    },
  };
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
    if (token === "--port" && rest[i + 1]) {
      args.port = Number(rest[++i]);
    } else if (token === "--host" && rest[i + 1]) {
      args.host = rest[++i];
    } else if (token === "--state-dir" && rest[i + 1]) {
      args.stateDir = rest[++i];
    } else if (token === "--daemon") {
      args.daemon = true;
    } else if (token === "--refresh") {
      args.refresh = true;
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "--help" || token === "-h") {
      args.command = "help";
    }
  }
  return args;
}

async function fetchHealth(host, port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureClaudeBridgeRunning({
  host = DEFAULT_CLAUDE_BRIDGE_HOST,
  port = Number(process.env.AGY_CLAUDE_PORT || DEFAULT_CLAUDE_BRIDGE_PORT),
  stateDir = defaultStateDir(),
  waitMs = 3000,
} = {}) {
  const existing = await fetchHealth(host, port, 800);
  if (existing?.ok) {
    return { started: false, alreadyRunning: true, health: existing };
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, "bridge.log");
  const pidFile = path.join(stateDir, "bridge.pid");
  const outFd = fs.openSync(logFile, "a");
  const scriptPath = fileURLToPath(import.meta.url);

  const child = spawn(
    process.execPath,
    [scriptPath, "start", "--host", host, "--port", String(port), "--state-dir", stateDir],
    {
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: process.env,
    },
  );
  child.unref();
  fs.closeSync(outFd);

  if (child.pid) {
    fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(host, port, 500);
    if (health?.ok) {
      return { started: true, alreadyRunning: false, pid: child.pid, health };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return { started: true, alreadyRunning: false, pid: child.pid, health: null };
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
    const health = await fetchHealth(args.host, args.port, 1500);
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
    const health = await fetchHealth(args.host, args.port, 800);
    if (health?.ok) {
      const endpoint = args.refresh
        ? `http://${args.host}:${args.port}/v1/refresh`
        : `http://${args.host}:${args.port}/v1/models`;
      const res = await fetch(endpoint, { method: args.refresh ? "POST" : "GET" });
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
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
    const bridge = createClaudeBridgeServer({
      host: args.host,
      port: args.port,
    });
    const addr = await bridge.start();
    // Kick off non-blocking warmup discovery
    void bridge.refreshModels({ forceRefresh: false, timeoutMs: 4000 });
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
