#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AgyAcpClient,
  removePersistedAccount,
  upsertPersistedAccount,
} from "./lib/agy-acp-client.mjs";
import {
  buildCodexModelCatalog,
  formatOpenAiModelsList,
  handleResponsesJson,
  proxyToUpstreamOpenAi,
  resolveCodexAgyModelId,
  sendOpenAiError,
  streamResponsesSse,
} from "./lib/responses-adapter.mjs";

export const DEFAULT_CODEX_BRIDGE_PORT = 43111;
export const DEFAULT_CODEX_BRIDGE_HOST = "127.0.0.1";

function defaultStateDir() {
  return path.join(os.homedir(), ".cache", "agy-codex-bridge");
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

function atomicWriteJson(filePath, data) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function createCodexBridgeServer(options = {}) {
  const host = options.host || DEFAULT_CODEX_BRIDGE_HOST;
  const port = options.port ?? DEFAULT_CODEX_BRIDGE_PORT;
  const defaultCwd = options.cwd || process.cwd();
  const upstreamUrl =
    options.upstreamUrl ||
    process.env.AGY_UPSTREAM_OPENAI_URL ||
    "https://api.openai.com";
  const showToolActivity = options.showToolActivity !== false;
  const catalogPath =
    options.catalogPath || process.env.AGY_CODEX_CATALOG_PATH || "";
  const acpClient =
    options.acpClient ||
    new AgyAcpClient({
      cwd: defaultCwd,
      ...(options.acpOptions || {}),
    });

  const responseSessionMap = new Map();
  let cachedModels = [...acpClient.fallbackModels];
  let cachedDiscovery = {
    models: cachedModels,
    source: "fallback",
    authenticated: null,
  };

  function syncCatalogFileIfConfigured(models) {
    if (!catalogPath) return;
    try {
      let existingBundled = [];
      if (fs.existsSync(catalogPath)) {
        const prev = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
        if (Array.isArray(prev?.models)) {
          existingBundled = prev.models.filter(
            (m) => typeof m?.slug === "string" && !m.slug.startsWith("agy/"),
          );
        }
      }
      const catalog = buildCodexModelCatalog(models, {
        bundledModels: existingBundled,
        includeBundled: existingBundled.length > 0,
      });
      atomicWriteJson(catalogPath, catalog);
    } catch {
      // Best-effort catalog file refresh
    }
  }

  async function refreshModels({ forceRefresh = false, timeoutMs = 20000 } = {}) {
    const discovery = await acpClient.discoverModels({
      cwd: defaultCwd,
      forceRefresh,
      timeoutMs,
    });
    cachedDiscovery = discovery;
    cachedModels = discovery.models || acpClient.fallbackModels;
    if (discovery.source === "acp") {
      syncCatalogFileIfConfigured(cachedModels);
    }
    return discovery;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          harness: "codex",
          host,
          port: server.address()?.port ?? port,
          modelsCount: cachedModels.length,
          modelSource: cachedDiscovery.source,
          authenticated: cachedDiscovery.authenticated,
          acp: acpClient.status(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        const force = url.searchParams.get("refresh") === "1";
        const discovery = await refreshModels({
          forceRefresh: force,
          timeoutMs: 15000,
        });
        sendJson(res, 200, formatOpenAiModelsList(discovery.models));
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models-catalog") {
        const force = url.searchParams.get("refresh") === "1";
        const discovery = await refreshModels({
          forceRefresh: force,
          timeoutMs: 15000,
        });
        sendJson(res, 200, buildCodexModelCatalog(discovery.models));
        return;
      }

      if (req.method === "POST" && pathname === "/v1/refresh") {
        if (url.searchParams.get("restart") === "1") {
          acpClient.reloadPersistedConfig();
          await acpClient.restart();
        } else {
          acpClient.clearCooldown();
        }
        const discovery = await refreshModels({
          forceRefresh: true,
          timeoutMs: 20000,
        });
        sendJson(res, 200, {
          ok: true,
          source: discovery.source,
          authenticated: discovery.authenticated,
          error: discovery.error || null,
          models: formatOpenAiModelsList(discovery.models).data,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/accounts") {
        sendJson(res, 200, {
          ok: true,
          harness: "codex",
          ...acpClient.listAccounts(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/accounts") {
        const rawBody = await readRawBody(req);
        let body = {};
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString("utf8"));
          } catch {
            sendOpenAiError(
              res,
              400,
              "invalid_json",
              "Invalid JSON request body",
              "invalid_request_error",
            );
            return;
          }
        }
        try {
          const resAccount = upsertPersistedAccount(
            {
              name: body?.name,
              dataDir: body?.dataDir,
              geminiDir: body?.geminiDir,
              appDataDir: body?.appDataDir,
              authMethod: body?.authMethod,
              label: body?.label,
              activate: body?.activate !== false,
              force: Boolean(body?.force),
            },
            acpClient.env,
          );
          let discovery = cachedDiscovery;
          if (resAccount.activeAccount === resAccount.account.name) {
            await acpClient.switchAccount(resAccount.account.name, { persist: false });
            discovery = await refreshModels({ forceRefresh: true, timeoutMs: 20000 });
          }
          sendJson(res, 200, {
            ok: true,
            account: resAccount.account,
            activeAccount: resAccount.activeAccount,
            authenticated: discovery.authenticated,
            source: discovery.source,
            modelsCount: discovery.models.length,
            loginCommand: acpClient.formatLoginCommand(),
          });
        } catch (err) {
          sendOpenAiError(
            res,
            400,
            "invalid_request",
            err.message,
            "invalid_request_error",
          );
        }
        return;
      }

      if (req.method === "POST" && pathname === "/v1/accounts/switch") {
        const rawBody = await readRawBody(req);
        let body = {};
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString("utf8"));
          } catch {
            sendOpenAiError(
              res,
              400,
              "invalid_json",
              "Invalid JSON request body",
              "invalid_request_error",
            );
            return;
          }
        }
        try {
          const targetName = body?.name || body?.account || "";
          const switchRes = await acpClient.switchAccount(targetName);
          const discovery = await refreshModels({ forceRefresh: true, timeoutMs: 20000 });
          sendJson(res, 200, {
            ...switchRes,
            authenticated: discovery.authenticated,
            source: discovery.source,
            modelsCount: discovery.models.length,
            models: formatOpenAiModelsList(discovery.models).data,
          });
        } catch (err) {
          sendOpenAiError(
            res,
            400,
            "invalid_request",
            err.message,
            "invalid_request_error",
          );
        }
        return;
      }

      if (req.method === "POST" && pathname === "/v1/accounts/remove") {
        const rawBody = await readRawBody(req);
        let body = {};
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString("utf8"));
          } catch {
            sendOpenAiError(
              res,
              400,
              "invalid_json",
              "Invalid JSON request body",
              "invalid_request_error",
            );
            return;
          }
        }
        try {
          const targetName = body?.name || body?.account || "";
          const prevAccount = acpClient.account;
          const rmRes = removePersistedAccount(
            targetName,
            { purgeData: Boolean(body?.purgeData) },
            acpClient.env,
          );
          if (prevAccount === rmRes.removed.name || rmRes.activeAccount !== prevAccount) {
            acpClient.reloadPersistedConfig({ account: rmRes.activeAccount || "" });
            await acpClient.restart();
            await refreshModels({ forceRefresh: true, timeoutMs: 20000 });
          }
          sendJson(res, 200, {
            ok: true,
            removed: rmRes.removed,
            purgedData: rmRes.purgedData,
            activeAccount: rmRes.activeAccount,
          });
        } catch (err) {
          sendOpenAiError(
            res,
            400,
            "invalid_request",
            err.message,
            "invalid_request_error",
          );
        }
        return;
      }

      if (req.method === "GET" && pathname === "/v1/auth") {
        try {
          await acpClient.initialize(4000);
        } catch {
          // Return best-effort auth info even if agy acp cannot initialize yet
        }
        sendJson(res, 200, {
          ok: true,
          harness: "codex",
          ...acpClient.getAuthInfo(),
          modelSource: cachedDiscovery.source,
          modelsCount: cachedModels.length,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/auth/authenticate") {
        const rawBody = await readRawBody(req);
        let body = {};
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString("utf8"));
          } catch {
            sendOpenAiError(
              res,
              400,
              "invalid_json",
              "Invalid JSON request body",
              "invalid_request_error",
            );
            return;
          }
        }
        const methodId =
          typeof body?.methodId === "string" && body.methodId.trim()
            ? body.methodId.trim()
            : "gemini-api-key";
        await acpClient.authenticate(methodId, 10000);
        const discovery = await refreshModels({ forceRefresh: true, timeoutMs: 20000 });
        sendJson(res, 200, {
          ok: true,
          methodId,
          authenticated: discovery.authenticated,
          source: discovery.source,
          modelsCount: discovery.models.length,
          models: formatOpenAiModelsList(discovery.models).data,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/auth/logout") {
        const logoutResult = await acpClient.logout(8000);
        cachedDiscovery = {
          models: [...acpClient.fallbackModels],
          source: "fallback",
          authenticated: false,
        };
        cachedModels = [...acpClient.fallbackModels];
        sendJson(res, 200, {
          ...logoutResult,
          loginCommand: acpClient.formatLoginCommand(),
        });
        return;
      }

      if (
        req.method === "POST" &&
        (pathname === "/v1/responses" || pathname === "/responses")
      ) {
        const rawBody = await readRawBody(req);
        let body;
        try {
          body = JSON.parse(rawBody.toString("utf8"));
        } catch {
          sendOpenAiError(
            res,
            400,
            "invalid_json",
            "Invalid JSON request body",
            "invalid_request_error",
          );
          return;
        }

        const knownIds = cachedModels.map((m) => m.id);
        const agyModel = resolveCodexAgyModelId(body?.model, knownIds);
        if (agyModel) {
          if (body?.stream === false) {
            await handleResponsesJson(req, res, body, agyModel, acpClient, {
              defaultCwd,
              showToolActivity,
              responseSessionMap,
            });
          } else {
            await streamResponsesSse(req, res, body, agyModel, acpClient, {
              defaultCwd,
              showToolActivity,
              responseSessionMap,
            });
          }
          return;
        }

        await proxyToUpstreamOpenAi(req, res, rawBody, upstreamUrl);
        return;
      }

      sendOpenAiError(
        res,
        404,
        "not_found",
        `Unknown route: ${req.method} ${pathname}`,
        "invalid_request_error",
      );
    } catch (err) {
      if (!res.headersSent) {
        sendOpenAiError(
          res,
          500,
          "internal_error",
          err?.message || "Internal Codex bridge error",
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
    port: Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
    host: process.env.AGY_CODEX_HOST || DEFAULT_CODEX_BRIDGE_HOST,
    stateDir: process.env.AGY_CODEX_STATE_DIR || defaultStateDir(),
    catalogPath: process.env.AGY_CODEX_CATALOG_PATH || "",
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
    else if (token === "--catalog-path" && rest[i + 1]) args.catalogPath = rest[++i];
    else if (token === "--daemon") args.daemon = true;
    else if (token === "--refresh") args.refresh = true;
    else if (token === "--json") args.json = true;
    else if (token === "--help" || token === "-h") args.command = "help";
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

export async function ensureCodexBridgeRunning({
  host = DEFAULT_CODEX_BRIDGE_HOST,
  port = Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
  stateDir = defaultStateDir(),
  catalogPath = process.env.AGY_CODEX_CATALOG_PATH || "",
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

  const cliArgs = [
    scriptPath,
    "start",
    "--host",
    host,
    "--port",
    String(port),
    "--state-dir",
    stateDir,
  ];
  if (catalogPath) {
    cliArgs.push("--catalog-path", catalogPath);
  }

  const child = spawn(process.execPath, cliArgs, {
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: process.env,
  });
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
        "Usage: agy-codex-bridge <start|ensure|status|stop|models|catalog> [options]",
        "",
        "Options:",
        "  --port <n>            Listen port (default: 43111 or AGY_CODEX_PORT)",
        "  --host <addr>         Listen host (default: 127.0.0.1)",
        "  --state-dir <dir>     State/log directory",
        "  --catalog-path <path> Optional agy-models.json path to keep synced",
        "  --daemon              Run in background",
        "  --refresh             Force refresh model list from agy acp",
        "  --json                JSON output",
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
        `agy-codex-bridge running at http://${args.host}:${args.port} (models=${health.modelsCount}, source=${health.modelSource}, authenticated=${health.authenticated})`,
      );
    } else {
      console.log(`agy-codex-bridge not running on http://${args.host}:${args.port}`);
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
      console.log(`Stopped agy-codex-bridge (pid ${pid}).`);
    } catch (err) {
      console.error(`Failed to stop pid ${pid}: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "models" || args.command === "catalog") {
    const health = await fetchHealth(args.host, args.port, 800);
    if (health?.ok) {
      const endpoint =
        args.command === "catalog"
          ? `http://${args.host}:${args.port}/v1/models-catalog${args.refresh ? "?refresh=1" : ""}`
          : args.refresh
            ? `http://${args.host}:${args.port}/v1/refresh`
            : `http://${args.host}:${args.port}/v1/models`;
      const method = args.command === "models" && args.refresh ? "POST" : "GET";
      const res = await fetch(endpoint, { method });
      console.log(JSON.stringify(await res.json(), null, 2));
      return;
    }
    const client = new AgyAcpClient();
    try {
      const discovery = await client.discoverModels({ forceRefresh: true });
      const out =
        args.command === "catalog"
          ? buildCodexModelCatalog(discovery.models)
          : formatOpenAiModelsList(discovery.models);
      console.log(JSON.stringify(out, null, 2));
    } finally {
      await client.dispose();
    }
    return;
  }

  if (args.command === "ensure") {
    const res = await ensureCodexBridgeRunning({
      host: args.host,
      port: args.port,
      stateDir: args.stateDir,
      catalogPath: args.catalogPath,
    });
    if (args.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(
        res.alreadyRunning
          ? `agy-codex-bridge already running on http://${args.host}:${args.port}`
          : `Started agy-codex-bridge on http://${args.host}:${args.port} (pid=${res.pid ?? "unknown"})`,
      );
    }
    return;
  }

  if (args.command === "start") {
    if (args.daemon) {
      const res = await ensureCodexBridgeRunning({
        host: args.host,
        port: args.port,
        stateDir: args.stateDir,
        catalogPath: args.catalogPath,
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
    const bridge = createCodexBridgeServer({
      host: args.host,
      port: args.port,
      catalogPath: args.catalogPath,
    });
    const addr = await bridge.start();
    void bridge.refreshModels({ forceRefresh: false, timeoutMs: 20000 });
    console.log(`agy-codex-bridge listening on http://${addr.host}:${addr.port}`);

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
