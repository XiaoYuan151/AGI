import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { AgyAcpClient } from "../codex/plugins/agi/scripts/lib/agy-acp-client.mjs";
import { createCodexBridgeServer } from "../codex/plugins/agi/scripts/agy-codex-bridge.mjs";
import { configureCodex } from "../codex/plugins/agi/scripts/setup-codex.mjs";
import { runCodexConnect } from "../codex/plugins/agi/scripts/agy-codex-connect.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGY_BIN = path.join(__dirname, "fixtures", "mock-agy");
const MCP_SERVER_PATH = path.resolve(
  __dirname,
  "../codex/plugins/agi/scripts/agy-codex-mcp.mjs",
);

function parseSseFrames(text) {
  const frames = [];
  for (const chunk of text.split(/\n\n+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    let event = null;
    let data = null;
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data = JSON.parse(line.slice(5).trim());
    }
    frames.push({ event, data });
  }
  return frames;
}

test("Codex bridge serves /v1/models-catalog, streams Responses SSE, supports previous_response_id, and proxies gpt-*", async () => {
  const upstreamCalls = [];
  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      upstreamCalls.push({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_openai_1",
          object: "response",
          status: "completed",
          model: "gpt-5.5",
          output_text: "from-upstream-openai",
        }),
      );
    });
  });
  await new Promise((r) => upstreamServer.listen(0, "127.0.0.1", r));
  const upstreamPort = upstreamServer.address().port;

  const acpClient = new AgyAcpClient({ agyBin: MOCK_AGY_BIN });
  const bridge = createCodexBridgeServer({
    host: "127.0.0.1",
    port: 0,
    acpClient,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
  });

  try {
    await bridge.start();
    const baseUrl = bridge.getUrl();

    // GET /v1/models-catalog
    const catRes = await fetch(`${baseUrl}/v1/models-catalog`);
    assert.equal(catRes.status, 200);
    const catJson = await catRes.json();
    assert.ok(catJson.models.length >= 3);
    assert.ok(catJson.models.every((m) => m.slug.startsWith("agy/") && m.visibility === "list"));

    // Turn 1 streaming Responses API
    const r1 = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "agy/gemini-2.5-pro",
        stream: true,
        reasoning: { effort: "low" },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "First Codex turn" }] }],
      }),
    });
    assert.equal(r1.status, 200);
    const frames = parseSseFrames(await r1.text());
    assert.equal(frames[0].event, "response.created");
    // Monotonically incrementing sequence_number
    for (let i = 0; i < frames.length; i++) {
      assert.equal(frames[i].data.sequence_number, i);
    }
    const text1 = frames
      .filter((f) => f.event === "response.output_text.delta")
      .map((f) => f.data.delta)
      .join("");
    assert.match(text1, /model=gemini-2\.5-pro effort=low turn=1/);
    const completedFrame = frames.find((f) => f.event === "response.completed");
    assert.ok(completedFrame);
    const resp1Id = completedFrame.data.response.id;
    assert.ok(resp1Id.startsWith("resp_agy_"));

    // Turn 2 switching to agy/gemini-2.5-flash with previous_response_id
    const r2 = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "agy/gemini-2.5-flash",
        stream: false,
        previous_response_id: resp1Id,
        reasoning: { effort: "high" },
        input: "Second turn after /model",
      }),
    });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.match(j2.output_text, /model=gemini-2\.5-flash effort=high turn=2/);
    assert.match(j2.output_text, /Second turn after \/model/);

    // Native gpt-* model proxies to upstream OpenAI
    const r3 = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
      body: JSON.stringify({ model: "gpt-5.5", stream: false, input: "hi openai" }),
    });
    assert.equal(r3.status, 200);
    const j3 = await r3.json();
    assert.equal(j3.output_text, "from-upstream-openai");
    assert.equal(upstreamCalls.length, 1);
  } finally {
    await bridge.stop();
    await new Promise((r) => upstreamServer.close(r));
  }
});

test("setup-codex.mjs supports profile + default modes, preserves existing TOML, and passes real codex debug models", (t) => {
  const tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-codex-home-"));
  try {
    // 1. Profile mode
    const profRes = configureCodex({
      codexHome: tmpCodexHome,
      mode: "profile",
      includeBundled: true,
    });
    assert.equal(profRes.action, "configured");
    assert.ok(fs.existsSync(profRes.profilePath));
    assert.ok(fs.existsSync(profRes.catalogPath));

    // 2. Default mode preserving pre-existing config.toml keys and table scope
    const configPath = path.join(tmpCodexHome, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        `model = "gpt-5.5"`,
        ``,
        `[plugins."agi@local-repo"]`,
        `enabled = true`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const defRes = configureCodex({
      codexHome: tmpCodexHome,
      mode: "default",
      includeBundled: false,
    });
    assert.equal(defRes.action, "configured");
    const mergedToml = fs.readFileSync(configPath, "utf8");
    assert.ok(mergedToml.indexOf('model_provider = "agy"') < mergedToml.indexOf("[plugins."));
    assert.match(mergedToml, /\[model_providers\.agy\]/);

    // Verify with real codex CLI if present
    try {
      const out = execFileSync(
        "codex",
        ["debug", "models", "-c", `model_catalog_json="${defRes.catalogPath}"`],
        {
          env: { ...process.env, CODEX_HOME: tmpCodexHome },
          encoding: "utf8",
          timeout: 8000,
        },
      );
      const parsed = JSON.parse(out);
      assert.ok(parsed.models.some((m) => m.slug === "agy/gemini-2.5-pro" && m.visibility === "list"));
    } catch (err) {
      if (err.code === "ENOENT") {
        t.skip("codex binary not on PATH");
      } else {
        throw err;
      }
    }

    // 3. Remove restores original top-level model key and removes provider block
    configureCodex({ codexHome: tmpCodexHome, mode: "default", remove: true });
    const restoredToml = fs.readFileSync(configPath, "utf8");
    assert.match(restoredToml, /^model = "gpt-5\.5"/m);
    assert.doesNotMatch(restoredToml, /\[model_providers\.agy\]/);
    assert.equal(fs.existsSync(defRes.catalogPath), false);
  } finally {
    fs.rmSync(tmpCodexHome, { recursive: true, force: true });
  }
});

test("agy-codex-mcp.mjs responds to initialize, tools/list, and tools/call", async () => {
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    env: {
      ...process.env,
      AGY_BIN: MOCK_AGY_BIN,
      AGY_AUTO_START_BRIDGE: "0",
      AGY_CODEX_PORT: "49911",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = readline.createInterface({ input: child.stdout });
  const nextMessage = () =>
    new Promise((resolve) => {
      rl.once("line", (line) => resolve(JSON.parse(line)));
    });

  try {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    const init = await nextMessage();
    assert.equal(init.result.serverInfo.name, "agy-codex-mcp");

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    const list = await nextMessage();
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("agy_status"));
    assert.ok(names.includes("agy_connect"));
    assert.ok(names.includes("agy_list_models"));
    assert.ok(names.includes("agy_configure_codex"));

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "agy_list_models", arguments: { refresh: true } },
      })}\n`,
    );
    const call = await nextMessage();
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.source, "acp");
    assert.ok(payload.data.some((m) => m.id === "agy/gemini-custom-preview"));

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "agy_connect", arguments: { action: "status" } },
      })}\n`,
    );
    const connectCall = await nextMessage();
    const connectPayload = JSON.parse(connectCall.result.content[0].text);
    assert.equal(connectPayload.ok, true);
    assert.equal(connectPayload.harness, "codex");
    assert.equal(connectPayload.canLogout, true);
    assert.match(connectPayload.loginCommand, /--login/);
  } finally {
    rl.close();
    child.kill("SIGTERM");
  }
});

test("Codex bridge /v1/auth endpoints and agy-codex-connect support official login, authenticate, refresh, and logout", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-codex-connect-"));
  const geminiDir = path.join(tmpDir, "antigravity");
  const env = {
    ...process.env,
    MOCK_ACP_REQUIRE_AUTH: "1",
    GEMINI_API_KEY: "",
  };
  const acpClient = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
    geminiDir,
    appDataDir: "antigravity-acp",
    usePersistedConfig: false,
    env,
  });
  const bridge = createCodexBridgeServer({
    host: "127.0.0.1",
    port: 0,
    acpClient,
  });

  try {
    await bridge.start();
    const baseUrl = bridge.getUrl();

    const auth0 = await (await fetch(`${baseUrl}/v1/auth`)).json();
    assert.equal(auth0.ok, true);
    assert.notEqual(auth0.authenticated, true);
    assert.equal(auth0.canLogout, true);

    const loginRes = await runCodexConnect({
      action: "login",
      host: "127.0.0.1",
      port: bridge.port,
      agyBin: MOCK_AGY_BIN,
      geminiDir,
      appDataDir: "antigravity-acp",
      usePersistedConfig: false,
      env,
      stdio: "pipe",
    });
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.bridgeReachable, true);
    assert.equal(loginRes.authenticated, true);
    assert.equal(loginRes.source, "acp");
    assert.ok(loginRes.modelsCount >= 3);

    const logoutRes = await runCodexConnect({
      action: "logout",
      host: "127.0.0.1",
      port: bridge.port,
      agyBin: MOCK_AGY_BIN,
      geminiDir,
      appDataDir: "antigravity-acp",
      usePersistedConfig: false,
      env,
    });
    assert.equal(logoutRes.ok, true);
    assert.equal(logoutRes.bridgeReachable, true);

    const authAfterLogout = await (await fetch(`${baseUrl}/v1/auth`)).json();
    assert.equal(authAfterLogout.authenticated, false);

    await acpClient.setApiKey("codex-connect-key");
    const authApiRes = await fetch(`${baseUrl}/v1/auth/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ methodId: "gemini-api-key" }),
    });
    assert.equal(authApiRes.status, 200);
    const authApiJson = await authApiRes.json();
    assert.equal(authApiJson.ok, true);
    assert.equal(authApiJson.authenticated, true);
    assert.equal(authApiJson.source, "acp");
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Codex bridge /v1/accounts endpoints and agy_accounts MCP tool manage multiple isolated accounts", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-codex-accounts-"));
  const agiHome = path.join(tmpRoot, ".agi");
  const cfgPath = path.join(agiHome, "acp.json");
  const workDir = path.join(tmpRoot, "codex-work");
  const sideDir = path.join(tmpRoot, "codex-side");
  const env = {
    ...process.env,
    AGI_HOME: agiHome,
    AGY_ACP_CONFIG: cfgPath,
    MOCK_ACP_REQUIRE_AUTH: "1",
    GEMINI_API_KEY: "",
  };
  delete env.AGY_GEMINI_DIR;
  delete env.AGY_APP_DATA_DIR;
  delete env.AGY_ACCOUNT;

  const acpClient = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
    env,
  });
  const bridge = createCodexBridgeServer({
    host: "127.0.0.1",
    port: 0,
    acpClient,
  });

  try {
    await bridge.start();
    const baseUrl = bridge.getUrl();

    await fetch(`${baseUrl}/v1/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "work", dataDir: workDir }),
    });

    const loginRes = await runCodexConnect({
      action: "login",
      account: "work",
      host: "127.0.0.1",
      port: bridge.port,
      agyBin: MOCK_AGY_BIN,
      env,
      stdio: "pipe",
    });
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.authenticated, true);

    await fetch(`${baseUrl}/v1/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "side", dataDir: sideDir, activate: false }),
    });

    const swJson = await (
      await fetch(`${baseUrl}/v1/accounts/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "side" }),
      })
    ).json();
    assert.equal(swJson.account, "side");
    assert.equal(swJson.authenticated, false);

    const mcp = spawn(process.execPath, [MCP_SERVER_PATH], {
      env: {
        ...env,
        AGY_AUTO_START_BRIDGE: "0",
        AGY_CODEX_PORT: String(bridge.port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = readline.createInterface({ input: mcp.stdout });
    const nextMsg = () => new Promise((resolve) => rl.once("line", (line) => resolve(JSON.parse(line))));
    try {
      mcp.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "agy_accounts", arguments: { action: "switch", name: "work" } },
        })}\n`,
      );
      const swMcp = JSON.parse((await nextMsg()).result.content[0].text);
      assert.equal(swMcp.account, "work");
      assert.equal(swMcp.authenticated, true);
    } finally {
      rl.close();
      mcp.kill("SIGTERM");
    }
  } finally {
    await bridge.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
