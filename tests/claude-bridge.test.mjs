import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { AgyAcpClient } from "../claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs";
import { createClaudeBridgeServer } from "../claude-code/plugins/agi/scripts/agy-claude-bridge.mjs";
import { configureClaudeSettings } from "../claude-code/plugins/agi/scripts/setup-claude.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGY_BIN = path.join(__dirname, "fixtures", "mock-agy");
const MCP_SERVER_PATH = path.resolve(
  __dirname,
  "../claude-code/plugins/agi/scripts/agy-claude-mcp.mjs",
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

test("Claude bridge serves /v1/models, streams /v1/messages, switches models mid-session, and proxies native claude-*", async () => {
  const upstreamCalls = [];
  const upstreamServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      upstreamCalls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_upstream_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "from-upstream-anthropic" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  await new Promise((r) => upstreamServer.listen(0, "127.0.0.1", r));
  const upstreamPort = upstreamServer.address().port;

  const acpClient = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
    env: { ...process.env, MOCK_ACP_REQUEST_PERMISSION: "1", MOCK_ACP_EMIT_TOOL_CALLS: "1" },
  });
  const bridge = createClaudeBridgeServer({
    host: "127.0.0.1",
    port: 0,
    acpClient,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
  });

  try {
    await bridge.start();
    const baseUrl = bridge.getUrl();

    // HEAD /api/hello warmup
    const helloRes = await fetch(`${baseUrl}/api/hello`, { method: "HEAD" });
    assert.equal(helloRes.status, 200);

    // GET /v1/models?limit=1000
    const modelsRes = await fetch(`${baseUrl}/v1/models?limit=1000`);
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    assert.ok(modelsJson.data.length >= 3);
    assert.ok(modelsJson.data.every((m) => m.id.startsWith("anthropic-agy/")));
    assert.ok(modelsJson.data.some((m) => m.id === "anthropic-agy/gemini-custom-preview"));
    assert.ok(modelsJson.data[0].display_name.startsWith("AGY"));

    // Turn 1 streaming on gemini-2.5-pro
    const turn1Res = await fetch(`${baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-agy/gemini-2.5-pro",
        stream: true,
        max_tokens: 1024,
        thinking: { type: "enabled", budget_tokens: 12000 },
        messages: [{ role: "user", content: "Hello AGY" }],
      }),
    });
    assert.equal(turn1Res.status, 200);
    const frames1 = parseSseFrames(await turn1Res.text());
    assert.equal(frames1[0].event, "message_start");
    assert.ok(frames1.some((f) => f.data?.delta?.type === "thinking_delta"));
    const text1 = frames1
      .filter((f) => f.data?.delta?.type === "text_delta")
      .map((f) => f.data.delta.text)
      .join("");
    assert.match(text1, /model=gemini-2\.5-pro effort=high turn=1/);
    assert.equal(frames1[frames1.length - 1].event, "message_stop");

    // Turn 2 mid-conversation switch via /model to gemini-2.5-flash (non-streaming)
    const turn2Res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-agy/gemini-2.5-flash",
        stream: false,
        max_tokens: 1024,
        messages: [
          { role: "user", content: "Hello AGY" },
          { role: "assistant", content: text1 },
          { role: "user", content: "Follow up after /model switch" },
        ],
      }),
    });
    assert.equal(turn2Res.status, 200);
    const turn2Json = await turn2Res.json();
    const text2 = turn2Json.content.find((b) => b.type === "text")?.text || "";
    assert.match(text2, /model=gemini-2\.5-flash .* turn=2/);
    assert.match(text2, /Follow up after \/model switch/);
    assert.doesNotMatch(text2, /Hello AGY/);

    // Auxiliary title request isolates permissions (reject_once) and doesn't advance main turn count
    const auxRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "agy/gemini-2.5-flash",
        stream: false,
        max_tokens: 64,
        system: "Please write a 5-10 word title for this conversation.",
        messages: [{ role: "user", content: "Summarize title" }],
      }),
    });
    const auxJson = await auxRes.json();
    const auxText = auxJson.content.find((b) => b.type === "text")?.text || "";
    assert.match(auxText, /perm=reject_once/);

    // Token counting endpoint for AGY
    const countRes = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic-agy/gemini-2.5-pro",
        messages: [{ role: "user", content: "12345678" }],
      }),
    });
    const countJson = await countRes.json();
    assert.ok(countJson.input_tokens >= 2);

    // Native Claude model passes through to upstream Anthropic
    const proxyRes = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "sk-ant-real-key",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        max_tokens: 256,
        messages: [{ role: "user", content: "native claude" }],
      }),
    });
    assert.equal(proxyRes.status, 200);
    const proxyJson = await proxyRes.json();
    assert.equal(proxyJson.content[0].text, "from-upstream-anthropic");
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].headers["x-api-key"], "sk-ant-real-key");
  } finally {
    await bridge.stop();
    await new Promise((r) => upstreamServer.close(r));
  }
});

test("setup-claude.mjs writes idempotently, preserves existing keys, and removes cleanly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-claude-setup-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  try {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          theme: "dark",
          env: { ANTHROPIC_API_KEY: "sk-ant-keep-me" },
        },
        null,
        2,
      ),
    );

    const res1 = configureClaudeSettings({
      scope: "user",
      settingsPath,
      authMode: "auto",
      includeModelPicker: true,
    });
    assert.equal(res1.authNote, "preserved-existing-key");
    const saved1 = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(saved1.theme, "dark");
    assert.equal(saved1.env.ANTHROPIC_API_KEY, "sk-ant-keep-me");
    assert.equal(saved1.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(saved1.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43110");
    assert.equal(saved1.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
    assert.ok(saved1.env.ANTHROPIC_CUSTOM_MODEL_OPTION.startsWith("anthropic-agy/"));
    assert.ok(saved1.modelPicker.options.length >= 1);

    // Local-token mode sets placeholder token for gateway-only setups
    configureClaudeSettings({
      scope: "user",
      settingsPath,
      authMode: "local-token",
    });
    const saved2 = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(saved2.env.ANTHROPIC_AUTH_TOKEN, "agy-acp-local");

    // Remove restores clean settings without deleting unrelated keys
    configureClaudeSettings({ scope: "user", settingsPath, remove: true });
    const removed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(removed.theme, "dark");
    assert.equal(removed.env.ANTHROPIC_API_KEY, "sk-ant-keep-me");
    assert.equal(removed.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(removed.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(removed.modelPicker, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("agy-claude-mcp.mjs responds to initialize, tools/list, and tools/call", async () => {
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    env: {
      ...process.env,
      AGY_BIN: MOCK_AGY_BIN,
      AGY_AUTO_START_BRIDGE: "0",
      AGY_CLAUDE_PORT: "49910",
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
    assert.equal(init.result.serverInfo.name, "agy-claude-mcp");

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
    );
    const list = await nextMessage();
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("agy_status"));
    assert.ok(names.includes("agy_list_models"));
    assert.ok(names.includes("agy_configure_claude"));

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
    assert.ok(payload.data.some((m) => m.id === "anthropic-agy/gemini-custom-preview"));
  } finally {
    rl.close();
    child.kill("SIGTERM");
  }
});
