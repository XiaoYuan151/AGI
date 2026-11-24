#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AgyAcpClient, runAgyInteractiveLogin } from "../src/lib/agy-acp-client.mjs";

export function parseConnectArgs(argv) {
  const args = {
    action: "login",
    method: "",
    account: process.env.AGY_ACCOUNT || "",
    dataDir: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--status" || token === "status") {
      args.action = "status";
    } else if (token === "--logout" || token === "logout") {
      args.action = "logout";
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
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "-h" || token === "--help") {
      args.action = "help";
    }
  }
  return args;
}

export async function runDshConnect(options = {}) {
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
      const discovery = await client.discoverModels({ forceRefresh: false, timeoutMs: 4000 });
      return {
        ok: true,
        action: "status",
        ...client.getAuthInfo(),
        authenticated: discovery.authenticated,
        modelSource: discovery.source,
        modelsCount: discovery.models.length,
        error: discovery.error || null,
      };
    }

    if (action === "logout") {
      const res = await client.logout(8000);
      return {
        action: "logout",
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
      await client.authenticate(methodId, 10000);
      const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
      return {
        ok: true,
        action: "authenticate",
        methodId,
        authenticated: discovery.authenticated,
        source: discovery.source,
        modelsCount: discovery.models.length,
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

    const discovery = await client.discoverModels({ forceRefresh: true, timeoutMs: 8000 });
    return {
      ok: true,
      action: "login",
      command: login.command,
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
        "Usage: node agy-dsh-connect.mjs [--status | --login | --method <id> | --logout] [--json]",
        "",
        "Connects DeepSeek Harness's AGI plugin to Google Antigravity ACP using official `agy acp` commands only.",
      ].join("\n"),
    );
    return;
  }

  const result = await runDshConnect(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `[agy-dsh-connect] ${result.action} OK (authenticated=${String(result.authenticated)}, models=${result.modelsCount ?? 0})`,
    );
  } else {
    console.error(`[agy-dsh-connect] ${result.action} failed: ${result.error || result.message || "unknown error"}`);
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
    console.error(`[agy-dsh-connect] Error: ${err.message}`);
    process.exit(1);
  });
}
