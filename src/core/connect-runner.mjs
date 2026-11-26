import { AgyAcpClient } from "./acp-client.mjs";
import { normalizeAuthMethodId } from "./acp-errors.mjs";
import { runAgyInteractiveLogin } from "./login-runner.mjs";

export function parseConnectArgs(argv, defaults = {}) {
  const args = {
    action: "login",
    method: "",
    account: process.env.AGY_ACCOUNT || "",
    dataDir: undefined,
    json: false,
    ...(defaults.host !== undefined ? { host: defaults.host } : {}),
    ...(defaults.port !== undefined ? { port: defaults.port } : {}),
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
    } else if (token === "--host" && argv[i + 1] && "host" in args) {
      args.host = argv[++i];
    } else if (token === "--port" && argv[i + 1] && "port" in args) {
      args.port = Number(argv[++i]);
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "-h" || token === "--help") {
      args.action = "help";
    }
  }
  return args;
}

export async function notifyBridgeEndpoint(host, port, pathname, method = "POST", body = undefined) {
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

export async function runHarnessConnect(options = {}, { useBridge = false, defaultHost, defaultPort } = {}) {
  const host = options.host || defaultHost;
  const port = options.port || defaultPort;
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
      if (useBridge) {
        const bridge = await notifyBridgeEndpoint(host, port, "/v1/auth", "GET");
        if (bridge.reachable && bridge.status < 400) {
          return { ok: true, action: "status", bridgeReachable: true, ...bridge.data };
        }
      }
      const discovery = await client.discoverModels({ forceRefresh: false, timeoutMs: 4000 });
      return {
        ok: true,
        action: "status",
        ...(useBridge ? { bridgeReachable: false } : {}),
        ...client.getAuthInfo(),
        authenticated: discovery.authenticated,
        modelSource: discovery.source,
        modelsCount: discovery.models.length,
        error: discovery.error || null,
      };
    }

    if (action === "logout") {
      if (useBridge) {
        const bridge = await notifyBridgeEndpoint(host, port, "/v1/auth/logout", "POST");
        if (bridge.reachable && bridge.status < 400) {
          return { action: "logout", bridgeReachable: true, ...bridge.data };
        }
      }
      const res = await client.logout(8000);
      return {
        action: "logout",
        ...(useBridge ? { bridgeReachable: false } : {}),
        ...res,
        loginCommand: client.formatLoginCommand(),
      };
    }

    if (action === "authenticate") {
      const methodId = normalizeAuthMethodId(options.method, "gemini-api-key");
      if (useBridge) {
        const bridge = await notifyBridgeEndpoint(host, port, "/v1/auth/authenticate", "POST", {
          methodId,
        });
        if (bridge.reachable && bridge.status < 400) {
          return { action: "authenticate", bridgeReachable: true, ...bridge.data };
        }
      }
      await client.authenticate(methodId, 10000);
      const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
      return {
        ok: true,
        action: "authenticate",
        ...(useBridge ? { bridgeReachable: false } : {}),
        methodId,
        authenticated: discovery.authenticated,
        source: discovery.source,
        modelsCount: discovery.models.length,
      };
    }

    if (action === "refresh") {
      if (useBridge) {
        const bridge = await notifyBridgeEndpoint(host, port, "/v1/refresh?restart=1", "POST");
        if (bridge.reachable && bridge.status < 400) {
          return { action: "refresh", bridgeReachable: true, ...bridge.data };
        }
      }
      const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
      return {
        ok: true,
        action: "refresh",
        ...(useBridge ? { bridgeReachable: false } : {}),
        authenticated: discovery.authenticated,
        source: discovery.source,
        modelsCount: discovery.models.length,
        error: discovery.error || null,
      };
    }

    const login = await runAgyInteractiveLogin({
      agyBin: client.agyBin,
      geminiDir: client.geminiDir,
      appDataDir: client.appDataDir,
      env: client.env,
      stdio: options.stdio || "inherit",
    });

    if (!login.ok) {
      return { ok: false, action: "login", ...login };
    }

    if (useBridge) {
      const bridge = await notifyBridgeEndpoint(host, port, "/v1/refresh?restart=1", "POST");
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
    }

    const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
    return {
      ok: true,
      action: "login",
      command: login.command,
      ...(useBridge ? { bridgeReachable: false } : {}),
      authenticated: discovery.authenticated,
      source: discovery.source,
      modelsCount: discovery.models.length,
      error: discovery.error || null,
    };
  } finally {
    await client.dispose();
  }
}
