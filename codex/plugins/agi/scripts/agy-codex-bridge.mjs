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

function atomicWriteJson(filePath, data) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function mapErrorSpec(kind) {
  if (kind === "invalid_json") return { code: "invalid_json", type: "invalid_request_error" };
  if (kind === "invalid_request") return { code: "invalid_request", type: "invalid_request_error" };
  if (kind === "not_found") return { code: "not_found", type: "invalid_request_error" };
  return { code: "internal_error", type: "api_error" };
}

export function createCodexBridgeServer(options = {}) {
  const upstreamUrl =
    options.upstreamUrl ||
    process.env.AGY_UPSTREAM_OPENAI_URL ||
    "https://api.openai.com";
  const catalogPath =
    options.catalogPath || process.env.AGY_CODEX_CATALOG_PATH || "";
  const responseSessionMap = new Map();

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

  return createAgyBridgeServer(
    { ...options, upstreamUrl },
    {
      harness: "codex",
      defaultHost: DEFAULT_CODEX_BRIDGE_HOST,
      defaultPort: DEFAULT_CODEX_BRIDGE_PORT,
      formatModelsList: formatOpenAiModelsList,
      sendError: (res, status, kind, message) => {
        const spec = mapErrorSpec(kind);
        sendOpenAiError(res, status, spec.code, message, spec.type);
      },
      onDiscoveryUpdated(discovery) {
        if (discovery.source === "acp") {
          syncCatalogFileIfConfigured(discovery.models || []);
        }
      },
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
        if (req.method === "GET" && pathname === "/v1/models") {
          const force = url.searchParams.get("refresh") === "1";
          const discovery = await refreshModels({
            forceRefresh: force,
            timeoutMs: 15000,
          });
          sendJson(res, 200, formatOpenAiModelsList(discovery.models));
          return true;
        }

        if (req.method === "GET" && pathname === "/v1/models-catalog") {
          const force = url.searchParams.get("refresh") === "1";
          const discovery = await refreshModels({
            forceRefresh: force,
            timeoutMs: 15000,
          });
          sendJson(res, 200, buildCodexModelCatalog(discovery.models));
          return true;
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
            return true;
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
            return true;
          }

          await proxyToUpstreamOpenAi(req, res, rawBody, upstreamUrl);
          return true;
        }

        return false;
      },
    },
  );
}

export async function ensureCodexBridgeRunning({
  host = DEFAULT_CODEX_BRIDGE_HOST,
  port = Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
  stateDir = defaultStateDir(),
  catalogPath = process.env.AGY_CODEX_CATALOG_PATH || "",
  waitMs = 3000,
} = {}) {
  return ensureBridgeDaemon({
    host,
    port,
    stateDir,
    scriptPath: fileURLToPath(import.meta.url),
    extraArgs: catalogPath ? ["--catalog-path", catalogPath] : [],
    waitMs,
  });
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
    const health = await fetchBridgeHealth(args.host, args.port, 1500);
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
    const health = await fetchBridgeHealth(args.host, args.port, 800);
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
