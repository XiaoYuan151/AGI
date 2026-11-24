import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgyAcpClient,
  AgyAuthRequiredError,
  AgyPolicyCooldownError,
  extractModelsFromSessionResult,
  normalizeModelId,
  parseFallbackModels,
  readPersistedAcpConfig,
} from "../claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGY_BIN = path.join(__dirname, "fixtures", "mock-agy");
const CLAUDE_CLIENT_PATH = path.resolve(
  __dirname,
  "../claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs",
);
const CODEX_CLIENT_PATH = path.resolve(
  __dirname,
  "../codex/plugins/agi/scripts/lib/agy-acp-client.mjs",
);

test("Claude and Codex agy-acp-client.mjs stay byte-identical", () => {
  const a = fs.readFileSync(CLAUDE_CLIENT_PATH, "utf8");
  const b = fs.readFileSync(CODEX_CLIENT_PATH, "utf8");
  assert.equal(a, b);
});

test("normalizeModelId and parseFallbackModels parse formats cleanly", () => {
  assert.equal(normalizeModelId("anthropic-agy/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(normalizeModelId("agy/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(normalizeModelId("antigravity/gemini-2.0-flash"), "gemini-2.0-flash");

  const parsedCsv = parseFallbackModels("gemini-a:Model A, agy/gemini-b");
  assert.equal(parsedCsv.length, 2);
  assert.deepEqual(parsedCsv[0].id, "gemini-a");
  assert.deepEqual(parsedCsv[0].name, "Model A");
  assert.deepEqual(parsedCsv[1].id, "gemini-b");
});

test("extractModelsFromSessionResult handles grouped configOptions and legacy models", () => {
  const fromConfig = extractModelsFromSessionResult({
    configOptions: [
      {
        id: "model",
        type: "select",
        category: "model",
        currentValue: "gemini-2.5-pro",
        options: [
          {
            group: "g1",
            name: "G1",
            options: [{ value: "gemini-2.5-pro", name: "Pro" }],
          },
        ],
      },
      {
        id: "thought_level",
        type: "select",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ],
  });
  assert.equal(fromConfig.modelConfigId, "model");
  assert.equal(fromConfig.currentModelId, "gemini-2.5-pro");
  assert.equal(fromConfig.models[0].efforts.join(","), "low,high");

  const fromLegacy = extractModelsFromSessionResult({
    models: {
      currentModelId: "gemini-legacy",
      availableModels: [{ modelId: "gemini-legacy", name: "Legacy" }],
    },
  });
  assert.equal(fromLegacy.currentModelId, "gemini-legacy");
  assert.equal(fromLegacy.models[0].id, "gemini-legacy");
});

test("AgyAcpClient discovers models, switches model & effort, and preserves session continuity", async () => {
  const client = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
    env: { ...process.env, MOCK_ACP_EMIT_TOOL_CALLS: "1" },
  });
  try {
    const discovery = await client.discoverModels({ forceRefresh: true });
    assert.equal(discovery.source, "acp");
    assert.equal(discovery.authenticated, true);
    assert.equal(discovery.models.length, 3);
    assert.equal(discovery.models[2].id, "gemini-custom-preview");

    const turn1 = await client.promptTurn({
      conversationKey: "conv-1",
      modelId: "gemini-2.5-pro",
      effort: "low",
      promptBlocks: [{ type: "text", text: "first message" }],
    });
    assert.match(turn1.text, /model=gemini-2\.5-pro effort=low turn=1/);
    assert.match(turn1.thoughts, /Thinking on gemini-2\.5-pro/);

    // Mid-session model & effort switch on the same conversationKey reuses sessionId & increments turn!
    const turn2 = await client.promptTurn({
      conversationKey: "conv-1",
      modelId: "gemini-2.5-flash",
      effort: "high",
      promptBlocks: [{ type: "text", text: "second message" }],
    });
    assert.equal(turn2.sessionId, turn1.sessionId);
    assert.match(turn2.text, /model=gemini-2\.5-flash effort=high turn=2/);
  } finally {
    await client.dispose();
  }
});

test("AgyAcpClient supports legacy session/set_model and permission policies", async () => {
  const client = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
    autoApprove: true,
    env: {
      ...process.env,
      MOCK_ACP_LEGACY_MODELS: "1",
      MOCK_ACP_REQUEST_PERMISSION: "1",
    },
  });
  try {
    const discovery = await client.discoverModels({ forceRefresh: true });
    assert.equal(discovery.source, "acp");
    assert.equal(discovery.models.length, 3);

    const primary = await client.promptTurn({
      conversationKey: "conv-perm",
      modelId: "gemini-2.5-flash",
      promptBlocks: [{ type: "text", text: "do work" }],
    });
    assert.match(primary.text, /model=gemini-2\.5-flash .* perm=allow_once/);

    // Auxiliary turns must reject permissions
    const aux = await client.promptTurn({
      auxiliary: true,
      modelId: "gemini-2.5-flash",
      promptBlocks: [{ type: "text", text: "title?" }],
    });
    assert.match(aux.text, /perm=reject_once/);
  } finally {
    await client.dispose();
  }
});

test("AgyAcpClient handles unauthenticated fallback and GEMINI_API_KEY auto-auth", async () => {
  const unauthClient = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
    env: { ...process.env, MOCK_ACP_REQUIRE_AUTH: "1", GEMINI_API_KEY: "" },
  });
  try {
    const disc = await unauthClient.discoverModels({ forceRefresh: true });
    assert.equal(disc.source, "fallback");
    assert.equal(disc.authenticated, false);
    assert.ok(disc.models.length >= 1);

    await assert.rejects(
      () =>
        unauthClient.promptTurn({
          conversationKey: "fail",
          modelId: "gemini-2.5-pro",
          promptBlocks: [{ type: "text", text: "hi" }],
        }),
      (err) => err instanceof AgyAuthRequiredError && err.code === -32000,
    );
  } finally {
    await unauthClient.dispose();
  }

  const keyClient = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
    env: {
      ...process.env,
      MOCK_ACP_REQUIRE_AUTH: "1",
      GEMINI_API_KEY: "test-gemini-key",
    },
  });
  try {
    const disc = await keyClient.discoverModels({ forceRefresh: true });
    assert.equal(disc.source, "acp");
    assert.equal(disc.authenticated, true);
  } finally {
    await keyClient.dispose();
  }
});

test("AgyAcpClient cancels prompt on AbortSignal and recovers after child crash", async () => {
  const client = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
  });
  try {
    // 1. Live in-flight session/cancel once prompt stream starts
    const ac = new AbortController();
    const res = await client.promptTurn({
      conversationKey: "cancel-conv",
      modelId: "gemini-2.5-pro",
      promptBlocks: [{ type: "text", text: "WAIT_FOREVER" }],
      signal: ac.signal,
      onEvent(evt) {
        if (evt.type === "thought" && evt.text.includes("waiting for cancel")) {
          ac.abort();
        }
      },
    });
    assert.equal(res.stopReason, "cancelled");

    // 2. Abort firing during session/new setup resolves cleanly as cancelled without hanging
    const raceClient = new AgyAcpClient({ agyBin: MOCK_AGY_BIN });
    try {
      const preAc = new AbortController();
      const pendingPre = raceClient.promptTurn({
        conversationKey: "pre-cancel",
        modelId: "gemini-2.5-pro",
        promptBlocks: [{ type: "text", text: "WAIT_FOREVER" }],
        signal: preAc.signal,
      });
      setTimeout(() => preAc.abort(), 5);
      const preRes = await pendingPre;
      assert.equal(preRes.stopReason, "cancelled");
    } finally {
      await raceClient.dispose();
    }

    // 3. Simulate abrupt child crash
    client.proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 80));

    // 4. Next turn respawns cleanly
    const recovered = await client.promptTurn({
      conversationKey: "after-crash",
      modelId: "gemini-2.5-flash",
      promptBlocks: [{ type: "text", text: "hello again" }],
    });
    assert.match(recovered.text, /model=gemini-2\.5-flash/);
  } finally {
    await client.dispose();
  }
});

test("Live agy acp initialize smoke test", async (t) => {
  const client = new AgyAcpClient({ rpcTimeoutMs: 6000 });
  try {
    const init = await client.initialize();
    assert.ok(init.agentInfo && typeof init.agentInfo.name === "string");
    assert.ok(Array.isArray(init.authMethods) && init.authMethods.length > 0);
  } catch (err) {
    if (/ENOENT/i.test(err.message)) {
      t.skip("agy binary not installed in PATH");
      return;
    }
    throw err;
  } finally {
    await client.dispose();
  }
});

test("AgyAcpClient isolates --gemini-dir + --app-data-dir from persisted config and enforces cooldowns", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agi-acp-safety-"));
  const cfgPath = path.join(tmpDir, "acp.json");
  const geminiDir = path.join(tmpDir, "antigravity");
  const callsLog = path.join(tmpDir, "calls.log");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ geminiDir, appDataDir: "antigravity-acp" }),
    "utf8",
  );

  try {
    const parsedCfg = readPersistedAcpConfig({ AGY_ACP_CONFIG: cfgPath });
    assert.equal(parsedCfg.geminiDir, geminiDir);
    assert.equal(parsedCfg.appDataDir, "antigravity-acp");

    const isoClient = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      env: { ...process.env, AGY_ACP_CONFIG: cfgPath },
    });
    assert.deepEqual(isoClient._buildArgs(), [
      "acp",
      "--gemini-dir",
      geminiDir,
      "--app-data-dir",
      "antigravity-acp",
      "--dangerously-skip-permissions",
    ]);
    assert.equal(isoClient.status().geminiDir, geminiDir);
    assert.equal(isoClient.status().appDataDir, "antigravity-acp");
    await isoClient.dispose();

    // Policy / 403 cooldown prevents repeated session/new retry storms
    const policyClient = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      usePersistedConfig: false,
      policyCooldownMs: 60000,
      env: {
        ...process.env,
        MOCK_ACP_ERROR_403: "1",
        MOCK_ACP_LOG_CALLS: callsLog,
      },
    });
    try {
      await assert.rejects(
        () =>
          policyClient.promptTurn({
            conversationKey: "c1",
            modelId: "gemini-2.5-pro",
            promptBlocks: [{ type: "text", text: "hi" }],
          }),
        (err) => err instanceof AgyPolicyCooldownError,
      );
      await assert.rejects(
        () =>
          policyClient.promptTurn({
            conversationKey: "c2",
            modelId: "gemini-2.5-pro",
            promptBlocks: [{ type: "text", text: "hi again" }],
          }),
        (err) => err instanceof AgyPolicyCooldownError,
      );
      const logged = fs.readFileSync(callsLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
      assert.equal(logged.length, 1);
    } finally {
      await policyClient.dispose();
    }

    // Auth cooldown prevents hammering session/new on repeated unauthenticated turns
    fs.writeFileSync(callsLog, "", "utf8");
    const authClient = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      usePersistedConfig: false,
      authCooldownMs: 60000,
      env: {
        ...process.env,
        MOCK_ACP_REQUIRE_AUTH: "1",
        GEMINI_API_KEY: "",
        MOCK_ACP_LOG_CALLS: callsLog,
      },
    });
    try {
      await assert.rejects(
        () =>
          authClient.promptTurn({
            conversationKey: "a1",
            modelId: "gemini-2.5-pro",
            promptBlocks: [{ type: "text", text: "one" }],
          }),
        (err) => err instanceof AgyAuthRequiredError,
      );
      await assert.rejects(
        () =>
          authClient.promptTurn({
            conversationKey: "a2",
            modelId: "gemini-2.5-pro",
            promptBlocks: [{ type: "text", text: "two" }],
          }),
        (err) => err instanceof AgyAuthRequiredError,
      );
      const logged = fs.readFileSync(callsLog, "utf8").trim().split(/\r?\n/).filter(Boolean);
      assert.equal(logged.length, 1);
    } finally {
      await authClient.dispose();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
