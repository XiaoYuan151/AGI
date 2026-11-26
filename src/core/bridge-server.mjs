import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgyAcpClient } from "./acp-client.mjs";
import { removePersistedAccount, upsertPersistedAccount } from "./account-store.mjs";
import { normalizeAuthMethodId } from "./acp-errors.mjs";

export function readRawBody(req, limitBytes = 20 * 1024 * 1024) {
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

export function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function fetchBridgeHealth(host, port, timeoutMs = 1500) {
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

export function stopBridgeByPidFile(stateDir, dryRun = false) {
  const pidFile = path.join(stateDir, "bridge.pid");
  if (!fs.existsSync(pidFile)) return { stopped: false, reason: "no-pid-file" };
  const raw = fs.readFileSync(pidFile, "utf8").trim();
  const pid = Number(raw);
  if (!pid || !Number.isFinite(pid)) {
    if (!dryRun) {
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // ignore
      }
    }
    return { stopped: false, reason: "invalid-pid" };
  }
  if (dryRun) {
    return { stopped: false, dryRun: true, pid };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // ignore
  }
  return { stopped: true, pid };
}

export async function ensureBridgeDaemon({
  host,
  port,
  stateDir,
  scriptPath,
  extraArgs = [],
  waitMs = 3000,
  env = process.env,
}) {
  const existing = await fetchBridgeHealth(host, port, 800);
  if (existing?.ok) {
    return { started: false, alreadyRunning: true, health: existing };
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, "bridge.log");
  const pidFile = path.join(stateDir, "bridge.pid");
  const outFd = fs.openSync(logFile, "a");

  const cliArgs = [
    scriptPath,
    "start",
    "--host",
    host,
    "--port",
    String(port),
    "--state-dir",
    stateDir,
    ...extraArgs,
  ];

  const child = spawn(process.execPath, cliArgs, {
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env,
  });
  child.unref();
  fs.closeSync(outFd);

  if (child.pid) {
    fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const health = await fetchBridgeHealth(host, port, 500);
    if (health?.ok) {
      return { started: true, alreadyRunning: false, pid: child.pid, health };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return { started: true, alreadyRunning: false, pid: child.pid, health: null };
}

async function parseOptionalJsonBody(req, res, sendError) {
  const rawBody = await readRawBody(req);
  if (rawBody.length === 0) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(rawBody.toString("utf8")) };
  } catch {
    sendError(res, 400, "invalid_json", "Invalid JSON body");
    return { ok: false, body: null };
  }
}

/**
 * Shared HTTP bridge server chassis (OCP + DIP).
 * Common health, auth, refresh, and multi-account routes live here;
 * harness-specific routes and error/model formatting are supplied via `strategy`.
 */
export function createAgyBridgeServer(options = {}, strategy = {}) {
  const host = options.host || strategy.defaultHost || "127.0.0.1";
  const port = options.port ?? strategy.defaultPort ?? 43110;
  const defaultCwd = options.cwd || process.cwd();
  const upstreamUrl = options.upstreamUrl || strategy.defaultUpstreamUrl || "";
  const showToolActivity = options.showToolActivity !== false;
  const harness = strategy.harness || "agy";
  const formatModelsList = strategy.formatModelsList || ((models) => ({ data: models }));
  const sendError =
    strategy.sendError ||
    ((res, status, _kind, message) => sendJson(res, status, { error: { message } }));

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

  async function refreshModels({ forceRefresh = false, timeoutMs = 20000 } = {}) {
    const discovery = await acpClient.discoverModels({
      cwd: defaultCwd,
      forceRefresh,
      timeoutMs,
    });
    cachedDiscovery = discovery;
    cachedModels = discovery.models || acpClient.fallbackModels;
    if (typeof strategy.onDiscoveryUpdated === "function") {
      strategy.onDiscoveryUpdated(discovery, { cachedModels, options });
    }
    return discovery;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
      const pathname = url.pathname;

      if (typeof strategy.handleCustomRoute === "function") {
        const handled = await strategy.handleCustomRoute({
          req,
          res,
          url,
          pathname,
          acpClient,
          cachedModels,
          cachedDiscovery,
          refreshModels,
          defaultCwd,
          showToolActivity,
          upstreamUrl,
          options,
        });
        if (handled) return;
      }

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          harness,
          host,
          port: server.address()?.port ?? port,
          modelsCount: cachedModels.length,
          modelSource: cachedDiscovery.source,
          authenticated: cachedDiscovery.authenticated,
          acp: acpClient.status(),
        });
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
          models: formatModelsList(discovery.models).data,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/accounts") {
        sendJson(res, 200, {
          ok: true,
          harness,
          ...acpClient.listAccounts(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/accounts") {
        const parsed = await parseOptionalJsonBody(req, res, sendError);
        if (!parsed.ok) return;
        const body = parsed.body;
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
          sendError(res, 400, "invalid_request", err.message);
        }
        return;
      }

      if (req.method === "POST" && pathname === "/v1/accounts/switch") {
        const parsed = await parseOptionalJsonBody(req, res, sendError);
        if (!parsed.ok) return;
        const body = parsed.body;
        try {
          const targetName = body?.name || body?.account || "";
          const switchRes = await acpClient.switchAccount(targetName);
          const discovery = await refreshModels({ forceRefresh: true, timeoutMs: 20000 });
          sendJson(res, 200, {
            ...switchRes,
            authenticated: discovery.authenticated,
            source: discovery.source,
            modelsCount: discovery.models.length,
            models: formatModelsList(discovery.models).data,
          });
        } catch (err) {
          sendError(res, 400, "invalid_request", err.message);
        }
        return;
      }

      if (req.method === "POST" && pathname === "/v1/accounts/remove") {
        const parsed = await parseOptionalJsonBody(req, res, sendError);
        if (!parsed.ok) return;
        const body = parsed.body;
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
          sendError(res, 400, "invalid_request", err.message);
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
          harness,
          ...acpClient.getAuthInfo(),
          modelSource: cachedDiscovery.source,
          modelsCount: cachedModels.length,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/auth/authenticate") {
        const parsed = await parseOptionalJsonBody(req, res, sendError);
        if (!parsed.ok) return;
        const body = parsed.body;
        const methodId = normalizeAuthMethodId(body?.methodId, "gemini-api-key");
        await acpClient.authenticate(methodId, 10000);
        const discovery = await refreshModels({ forceRefresh: true, timeoutMs: 20000 });
        sendJson(res, 200, {
          ok: true,
          methodId,
          authenticated: discovery.authenticated,
          source: discovery.source,
          modelsCount: discovery.models.length,
          models: formatModelsList(discovery.models).data,
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

      sendError(res, 404, "not_found", `Unknown route: ${req.method} ${pathname}`);
    } catch (err) {
      if (!res.headersSent) {
        sendError(res, 500, "internal_error", err?.message || "Internal bridge error");
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
