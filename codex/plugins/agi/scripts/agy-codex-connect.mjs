#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AgyAcpClient, runAgyInteractiveLogin } from "./lib/agy-acp-client.mjs";
import {
  DEFAULT_CODEX_BRIDGE_HOST,
  DEFAULT_CODEX_BRIDGE_PORT,
} from "./agy-codex-bridge.mjs";

export function parseConnectArgs(argv) {
  const args = {
    action: "login",
    method: "",
    account: process.env.AGY_ACCOUNT || "",
    dataDir: undefined,
    json: false,
    host: process.env.AGY_CODEX_HOST || DEFAULT_CODEX_BRIDGE_HOST,
    port: Number(process.env.AGY_CODEX_PORT || DEFAULT_CODEX_BRIDGE_PORT),
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--status" || token === "status") {
      args.action = "status";
    } else if (token === "--logout" || token === "logout") {
      args.action = "logout";
    } else if (token === "--refresh" || token === "refresh") {
      args.action = "refresh";
    } else if (token === "--login" || token === "login") {
      args.action = "login";
    } else if (token === "--account" && argv[i + 1]) {
      args.account = argv[++i];
    } else if ((token === "--data-dir" || token === "--gemini-dir") && argv[i + 1]) {
      args.dataDir = argv[++i];
    } else if (token === "--method" && argv[i + 1]) {
      args.method = argv[++i];
      if (args.method !== "oauth-personal" && args.method !== "google") {
        args.action = "authenticate";
      }
    } else if (token === "--host" && argv[i + 1]) {
      args.host = argv[++i];
    } else if (token === "--port" && argv[i + 1]) {
      args.port = Number(argv[++i]);
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "-h" || token === "--help") {
      args.action = "help";
    }
  }
  return args;
}

async function notifyBridge(host, port, pathname, method = "POST", body = undefined) {
  try {
    const res = await fetch(`http://${host}:${port}${pathname}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return { reachable: true, status: res.status, data };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

export async function runCodexConnect(options = {}) {
  const host = options.host || DEFAULT_CODEX_BRIDGE_HOST;
  const port = options.port || DEFAULT_CODEX_BRIDGE_PORT;
  const action = options.action || "login";
  const resolvedGeminiDir =
    options.dataDir !== undefined ? options.dataDir : options.geminiDir;
  const client = new AgyAcpClient({
    ...(options.account ? { account: options.account } : {}),
    ...(options.agyBin ? { agyBin: options.agyBin } : {}),
    ...(resolvedGeminiDir !== undefined ? { geminiDir: resolvedGeminiDir } : {}),
    ...(options.appDataDir !== undefined ? { appDataDir: options.appDataDir } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.usePersistedConfig !== undefined
      ? { usePersistedConfig: options.usePersistedConfig }
      : {}),
  });

  try {
    if (action === "status") {
      const bridge = await notifyBridge(host, port, "/v1/auth", "GET");
      if (bridge.reachable && bridge.status < 400) {
        return { ok: true, action: "status", bridgeReachable: true, ...bridge.data };
      }
      const discovery = await client.discoverModels({ forceRefresh: false, timeoutMs: 4000 });
      return {
        ok: true,
        action: "status",
        bridgeReachable: false,
        ...client.getAuthInfo(),
        authenticated: discovery.authenticated,
        modelSource: discovery.source,
        modelsCount: discovery.models.length,
        error: discovery.error || null,
      };
    }

    if (action === "logout") {
      const bridge = await notifyBridge(host, port, "/v1/auth/logout", "POST");
      if (bridge.reachable && bridge.status < 400) {
        return { action: "logout", bridgeReachable: true, ...bridge.data };
      }
      const res = await client.logout(8000);
      return {
        action: "logout",
        bridgeReachable: false,
        ...res,
        loginCommand: client.formatLoginCommand(),
      };
    }

    if (action === "authenticate") {
      const rawMethod = options.method || "gemini-api-key";
      const methodMap = {
        "api-key": "gemini-api-key",
        enterprise: "oauth-business",
        vertex: "agent-platform",
      };
      const methodId = methodMap[rawMethod] || rawMethod;
      const bridge = await notifyBridge(host, port, "/v1/auth/authenticate", "POST", {
        methodId,
      });
      if (bridge.reachable && bridge.status < 400) {
        return { action: "authenticate", bridgeReachable: true, ...bridge.data };
      }
      await client.authenticate(methodId, 10000);
      const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
      return {
        ok: true,
        action: "authenticate",
        bridgeReachable: false,
        methodId,
        authenticated: discovery.authenticated,
        source: discovery.source,
        modelsCount: discovery.models.length,
      };
    }

    if (action === "refresh") {
      const bridge = await notifyBridge(host, port, "/v1/refresh?restart=1", "POST");
      if (bridge.reachable && bridge.status < 400) {
        return { action: "refresh", bridgeReachable: true, ...bridge.data };
      }
      const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
      return {
        ok: true,
        action: "refresh",
        bridgeReachable: false,
        authenticated: discovery.authenticated,
        source: discovery.source,
        modelsCount: discovery.models.length,
        error: discovery.error || null,
      };
    }

    // Default: official interactive `agy acp [--gemini-dir ...] [--app-data-dir ...] --login`
    const login = await runAgyInteractiveLogin({
      agyBin: client.agyBin,
      geminiDir: client.geminiDir,
      appDataDir: client.appDataDir,
      env: client.env,
      stdio: options.stdio || "inherit",
    });

    if (!login.ok) {
      return {
        ok: false,
        action: "login",
        ...login,
      };
    }

    const bridge = await notifyBridge(host, port, "/v1/refresh?restart=1", "POST");
    if (bridge.reachable && bridge.status < 400) {
      return {
        ok: true,
        action: "login",
        command: login.command,
        bridgeReachable: true,
        authenticated: bridge.data?.authenticated ?? true,
        source: bridge.data?.source ?? "acp",
        modelsCount: Array.isArray(bridge.data?.models) ? bridge.data.models.length : 0,
      };
    }

    const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
    return {
      ok: true,
      action: "login",
      command: login.command,
      bridgeReachable: false,
      authenticated: discovery.authenticated,
      source: discovery.source,
      modelsCount: discovery.models.length,
      error: discovery.error || null,
    };
  } finally {
    await client.dispose();
  }
}

async function main() {
  const args = parseConnectArgs(process.argv.slice(2));
  if (args.action === "help") {
    console.log(
      [
        "Usage: agy-codex-connect [--status | --login | --method <id> | --refresh | --logout] [options]",
        "",
        "Connects Codex's AGI plugin to Google Antigravity ACP using official `agy acp` commands only:",
        "  (default) / --login      Run official interactive `agy acp ... --login` and refresh bridge + agy-models.json",
        "  --method <id>            Authenticate via official ACP `authenticate` (gemini-api-key | oauth-business | agent-platform)",
        "  --account <name>         Target a named AGI account profile",
        "  --data-dir <dir>         Override isolated data folder (--gemini-dir)",
        "  --status                 Inspect isolated ACP profile and authentication status",
        "  --refresh                Restart ACP subprocess and refresh bridge models + catalog",
        "  --logout                 Sign out via official ACP `logout` RPC",
      ].join("\n"),
    );
    return;
  }

  const result = await runCodexConnect(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `[agy-codex-connect] ${result.action} OK (authenticated=${String(result.authenticated)}, models=${result.modelsCount ?? 0}, loginCommand="${result.loginCommand || result.command || ""}")`,
    );
  } else {
    console.error(`[agy-codex-connect] ${result.action} failed: ${result.error || result.message || "unknown error"}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
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
    console.error(`[agy-codex-connect] Error: ${err.message}`);
    process.exit(1);
  });
}
