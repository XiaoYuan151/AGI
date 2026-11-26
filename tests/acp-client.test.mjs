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
  CooldownPolicy,
  InteractiveLoginManager,
  buildLoginCommandArgs,
  clearAccountApiKey,
  extractAuthUrlFromOutput,
  extractModelsFromSessionResult,
  listPersistedAccounts,
  normalizeModelId,
  parseFallbackModels,
  readAccountApiKey,
  readPersistedAcpConfig,
  removePersistedAccount,
  runAgyInteractiveLogin,
  setActivePersistedAccount,
  upsertPersistedAccount,
  writeAccountApiKey,
} from "../claude-code/plugins/agi/scripts/lib/agy-acp-client.mjs";
import { checkCoreSync } from "../scripts/sync-core.mjs";

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
const DSH_CLIENT_PATH = path.resolve(
  __dirname,
  "../deepseek-harness/plugins/agi/src/lib/agy-acp-client.mjs",
);

test("Claude, Codex, and DeepSeek Harness agy-acp-client.mjs stay byte-identical", () => {
  const a = fs.readFileSync(CLAUDE_CLIENT_PATH, "utf8");
  const b = fs.readFileSync(CODEX_CLIENT_PATH, "utf8");
  const c = fs.readFileSync(DSH_CLIENT_PATH, "utf8");
  assert.equal(a, b);
  assert.equal(a, c);
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

  const fromDual = extractModelsFromSessionResult({
    configOptions: [
      {
        id: "model",
        type: "select",
        category: "model",
        currentValue: "gemini-4-neon",
        options: [
          { value: "gemini-4-neon", name: "Gemini 4 Neon" },
          { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
          { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        ],
      },
      {
        id: "thought_level",
        type: "select",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Extra" },
        ],
      },
    ],
    models: {
      currentModelId: "gemini-4-neon",
      availableModels: [
        { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
        { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
        { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
        { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
        { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
        { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
        { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
        { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        { modelId: "gemini-custom-only", name: "Gemini Custom Only" },
      ],
    },
  });
  assert.deepEqual(
    fromDual.models.map((m) => m.id),
    ["gemini-4-neon", "gemini-3.8-flash", "gpt-oss-120b-medium", "gemini-custom-only"],
  );
  assert.deepEqual(
    fromDual.models.find((m) => m.id === "gemini-4-neon").efforts,
    ["low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    fromDual.models.find((m) => m.id === "gemini-3.8-flash").efforts,
    ["low", "medium", "high"],
  );
});

test("AgyAcpClient discovers models, switches model & effort, and preserves session continuity", async () => {
  const client = new AgyAcpClient({
    agyBin: MOCK_AGY_BIN,
    usePersistedConfig: false,
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
    usePersistedConfig: false,
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
    usePersistedConfig: false,
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
    usePersistedConfig: false,
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
    usePersistedConfig: false,
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
    const raceClient = new AgyAcpClient({ agyBin: MOCK_AGY_BIN, usePersistedConfig: false });
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

test("AgyAcpClient supports official loginInteractive, getAuthInfo, setApiKey, restart, and logout", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agi-acp-auth-"));
  const geminiDir = path.join(tmpDir, "antigravity");
  try {
    assert.deepEqual(
      buildLoginCommandArgs({ geminiDir, appDataDir: "antigravity-acp" }),
      ["acp", "--gemini-dir", geminiDir, "--app-data-dir", "antigravity-acp", "--login"],
    );

    const client = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      geminiDir,
      appDataDir: "antigravity-acp",
      usePersistedConfig: false,
      env: {
        ...process.env,
        MOCK_ACP_REQUIRE_AUTH: "1",
        GEMINI_API_KEY: "",
      },
    });
    try {
      // Initially unauthenticated -> fallback
      const disc0 = await client.discoverModels({ forceRefresh: true });
      assert.equal(disc0.authenticated, false);
      assert.equal(disc0.source, "fallback");

      const info0 = client.getAuthInfo();
      assert.equal(info0.canLogout, true);
      assert.ok(info0.authMethods.some((m) => m.id === "gemini-api-key"));
      assert.match(info0.loginCommand, /--gemini-dir .* --app-data-dir antigravity-acp --login/);

      // Official interactive login via `agy acp --gemini-dir ... --app-data-dir ... --login`
      const loginRes = await client.loginInteractive({ stdio: "pipe" });
      assert.equal(loginRes.ok, true);
      assert.equal(loginRes.discovery.authenticated, true);
      assert.equal(loginRes.discovery.source, "acp");
      assert.ok(fs.existsSync(path.join(geminiDir, ".mock-logged-in")));

      // Official ACP `logout` RPC clears credentials & marker
      const logoutRes = await client.logout(6000);
      assert.equal(logoutRes.ok, true);
      assert.equal(fs.existsSync(path.join(geminiDir, ".mock-logged-in")), false);

      // Discovery after logout drops back to fallback
      const discAfterLogout = await client.discoverModels({ forceRefresh: true });
      assert.equal(discAfterLogout.authenticated, false);
      assert.equal(discAfterLogout.source, "fallback");

      // Setting GEMINI_API_KEY restarts ACP and authenticates via official `gemini-api-key`
      const changed = await client.setApiKey("test-key-from-connect");
      assert.equal(changed, true);
      assert.equal(client.getAuthInfo().hasGeminiApiKey, true);
      const discKey = await client.discoverModels({ forceRefresh: true });
      assert.equal(discKey.authenticated, true);
      assert.equal(discKey.source, "acp");

      // Clearing key returns false on duplicate clear
      assert.equal(await client.setApiKey(""), true);
      assert.equal(await client.setApiKey(""), false);

      // Failed interactive login surfaces exit code cleanly
      const failLogin = await runAgyInteractiveLogin({
        agyBin: MOCK_AGY_BIN,
        geminiDir,
        appDataDir: "antigravity-acp",
        env: { ...process.env, MOCK_ACP_LOGIN_FAIL: "1" },
        stdio: "pipe",
      });
      assert.equal(failLogin.ok, false);
      assert.equal(failLogin.exitCode, 1);
    } finally {
      await client.dispose();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Multi-account config migration, isolation, collision checks, purge safety, and live switchAccount", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-multi-acct-"));
  const agiHome = path.join(tmpRoot, ".agi");
  const cfgPath = path.join(agiHome, "acp.json");
  const legacyDir = path.join(agiHome, "antigravity");
  const workDir = path.join(tmpRoot, "custom-work-data");
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

  try {
    // 1. Legacy v1 acp.json migrates automatically to version 2 with `default` account
    fs.mkdirSync(agiHome, { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ geminiDir: legacyDir, appDataDir: "antigravity-acp" }),
      "utf8",
    );
    const migrated = readPersistedAcpConfig(env);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.activeAccount, "default");
    assert.equal(migrated.geminiDir, legacyDir);
    assert.equal(migrated.accounts.default.dataDir, legacyDir);

    // 2. Add named accounts into separate data folders
    const workAdded = upsertPersistedAccount(
      { name: "work", dataDir: workDir, label: "Work Profile", activate: true },
      env,
    );
    assert.equal(workAdded.activeAccount, "work");
    assert.equal(workAdded.account.geminiDir, workDir);
    assert.ok(fs.existsSync(path.join(workDir, ".agi-account.json")));

    const personalAdded = upsertPersistedAccount(
      { name: "personal", activate: false },
      env,
    );
    assert.equal(personalAdded.activeAccount, "work");
    assert.equal(
      personalAdded.account.geminiDir,
      path.join(agiHome, "accounts", "personal"),
    );

    // 3. Rejects assigning same folder to a second account unless force: true
    assert.throws(
      () => upsertPersistedAccount({ name: "dup", dataDir: workDir }, env),
      /already used by account 'work'/,
    );
    upsertPersistedAccount({ name: "dup", dataDir: workDir, activate: false, force: true }, env);
    removePersistedAccount("dup", { purgeData: true }, env);
    // workDir is still used by 'work', so purgeData must NOT delete it
    assert.equal(fs.existsSync(workDir), true);

    const listed = listPersistedAccounts(env);
    assert.equal(listed.activeAccount, "work");
    assert.deepEqual(
      listed.accounts.map((a) => a.name),
      ["default", "personal", "work"],
    );

    // 4. Sign in only to `work`, keep `personal` unauthenticated, and verify live switchAccount isolation
    await runAgyInteractiveLogin({
      agyBin: MOCK_AGY_BIN,
      geminiDir: workDir,
      appDataDir: "antigravity-acp",
      env,
      stdio: "pipe",
    });

    const client = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      env,
    });
    try {
      assert.equal(client.account, "work");
      assert.equal(client.geminiDir, workDir);
      const discWork = await client.discoverModels({ forceRefresh: true });
      assert.equal(discWork.authenticated, true);
      assert.equal(discWork.source, "acp");

      // Switch live to `personal` -> respawns agy acp with personal's folder (unauthenticated!)
      const sw = await client.switchAccount("personal");
      assert.equal(sw.account, "personal");
      assert.equal(sw.dataDir, path.join(agiHome, "accounts", "personal"));
      assert.equal(client.status().account, "personal");
      assert.equal(readPersistedAcpConfig(env).activeAccount, "personal");

      const discPersonal = await client.discoverModels({ forceRefresh: true });
      assert.equal(discPersonal.authenticated, false);
      assert.equal(discPersonal.source, "fallback");

      // AGY_ACCOUNT env override picks specified account directly
      const workOnlyClient = new AgyAcpClient({
        agyBin: MOCK_AGY_BIN,
        env: { ...env, AGY_ACCOUNT: "work" },
      });
      try {
        assert.equal(workOnlyClient.account, "work");
        const discEnvWork = await workOnlyClient.discoverModels({ forceRefresh: true });
        assert.equal(discEnvWork.authenticated, true);
      } finally {
        await workOnlyClient.dispose();
      }
    } finally {
      await client.dispose();
    }

    // 5. Purge safety guard refuses protected dirs & removes normal account dirs cleanly
    setActivePersistedAccount("default", env);
    const rmPersonal = removePersistedAccount("personal", { purgeData: true }, env);
    assert.equal(rmPersonal.purgedData, true);
    assert.equal(fs.existsSync(path.join(agiHome, "accounts", "personal")), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("AgyAcpClient persists models cache, preserves live catalog on transient timeout, and clears cache on auth error", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-models-cache-"));
  const agiHome = path.join(tmpRoot, ".agi");
  const cfgPath = path.join(agiHome, "acp.json");
  const geminiDir = path.join(agiHome, "antigravity");

  const baseEnv = {
    ...process.env,
    AGI_HOME: agiHome,
    AGY_ACP_CONFIG: cfgPath,
    MOCK_ACP_DUAL_MODELS: "1",
  };
  delete baseEnv.GEMINI_API_KEY;

  try {
    upsertPersistedAccount({ name: "default", dataDir: geminiDir }, baseEnv);

    // 1. Live discovery populates models-cache.json without flattened effort duplicates
    const client1 = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      env: baseEnv,
    });
    try {
      const disc = await client1.discoverModels({ forceRefresh: true });
      assert.equal(disc.source, "acp");
      assert.equal(disc.authenticated, true);
      assert.deepEqual(
        disc.models.map((m) => m.id),
        ["gemini-4-neon", "gemini-4-carbon", "gemini-3.8-flash", "gpt-oss-120b-medium"],
      );
      assert.equal(fs.existsSync(path.join(agiHome, "models-cache.json")), true);
    } finally {
      await client1.dispose();
    }

    // 2. Fresh client reads persisted cache immediately and preserves live catalog across a transient timeout
    const slowClient = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      env: { ...baseEnv, MOCK_ACP_SESSION_DELAY_MS: "350" },
    });
    try {
      const seeded = slowClient.getCachedDiscovery();
      assert.ok(seeded);
      assert.equal(seeded.source, "acp");
      assert.ok(seeded.models.some((m) => m.id === "gemini-4-neon"));

      const timedOut = await slowClient.discoverModels({ forceRefresh: true, timeoutMs: 80 });
      assert.equal(timedOut.source, "acp");
      assert.ok(timedOut.models.some((m) => m.id === "gemini-4-neon"));
      assert.match(timedOut.error || "", /timed out/i);
      assert.equal(slowClient.lastDiscoveryAt, 0);

      // Next fast retry succeeds without waiting 60s
      const recovered = await slowClient.discoverModels({ forceRefresh: false, timeoutMs: 5000 });
      assert.equal(recovered.source, "acp");
      assert.equal(recovered.authenticated, true);
      assert.equal(recovered.error, undefined);
    } finally {
      await slowClient.dispose();
    }

    // 3. Explicit auth failure clears the cached live models and drops back to fallback
    const unauthClient = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      env: { ...baseEnv, MOCK_ACP_REQUIRE_AUTH: "1" },
    });
    try {
      const unauthDisc = await unauthClient.discoverModels({ forceRefresh: true });
      assert.equal(unauthDisc.source, "fallback");
      assert.equal(unauthDisc.authenticated, false);
      assert.equal(unauthClient.getCachedDiscovery(), null);
    } finally {
      await unauthClient.dispose();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("core mirror files stay in sync across root and all standalone plugins", () => {
  const report = checkCoreSync();
  assert.equal(report.ok, true, `Core mirror drift: ${JSON.stringify(report)}`);
});

test("per-account .agi-credentials.json isolates API keys with 0600 perms and clears on logout", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-creds-"));
  const agiHome = path.join(tmpRoot, "agi-home");
  const workDir = path.join(tmpRoot, "work-gemini");
  const personalDir = path.join(tmpRoot, "personal-gemini");
  const baseEnv = { ...process.env, AGI_HOME: agiHome };

  try {
    upsertPersistedAccount({ name: "work", dataDir: workDir }, baseEnv);
    upsertPersistedAccount({ name: "personal", dataDir: personalDir, activate: false }, baseEnv);

    const written = writeAccountApiKey(workDir, "AIza-work-secret-key", baseEnv);
    assert.equal(written, true);
    const credPath = path.join(workDir, ".agi-credentials.json");
    const mode = fs.statSync(credPath).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(readAccountApiKey(workDir, baseEnv), "AIza-work-secret-key");
    assert.equal(readAccountApiKey(personalDir, baseEnv), "");

    // Must never be stored in ~/.agi/acp.json
    const acpJson = fs.readFileSync(path.join(agiHome, "acp.json"), "utf8");
    assert.equal(acpJson.includes("AIza-work-secret-key"), false);

    // Client loads stored account key automatically for 'work', not 'personal'
    const workClient = new AgyAcpClient({
      agyBin: MOCK_AGY_BIN,
      account: "work",
      env: { ...baseEnv, MOCK_ACP_REQUIRE_AUTH: "1" },
    });
    try {
      const authStatus = workClient.getAuthInfo();
      assert.equal(authStatus.hasStoredAccountKey, true);
      assert.equal(authStatus.apiKeySource, "account");
      const disc = await workClient.discoverModels({ forceRefresh: true });
      assert.equal(disc.authenticated, true);

      await workClient.logout();
      assert.equal(readAccountApiKey(workDir, baseEnv), "");
    } finally {
      await workClient.dispose();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("CooldownPolicy and InteractiveLoginManager handle backoff, OAuth URL capture, and cancel", async () => {
  const policy = new CooldownPolicy({ authCooldownMs: 5000, policyCooldownMs: 5000 });
  assert.equal(policy.isAuthCoolingDown(), false);
  policy.tripAuth();
  assert.equal(policy.isAuthCoolingDown(), true);
  policy.tripPolicy(new Error("rate limit"));
  assert.throws(() => policy.checkPolicy(), AgyPolicyCooldownError);
  policy.clear();
  assert.equal(policy.isAuthCoolingDown(), false);
  assert.doesNotThrow(() => policy.checkPolicy());

  assert.equal(
    extractAuthUrlFromOutput("Open https://accounts.google.com/o/oauth2/auth?client_id=123 to continue."),
    "https://accounts.google.com/o/oauth2/auth?client_id=123",
  );

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-login-mgr-"));
  const geminiDir = path.join(tmpRoot, "gemini");
  const manager = new InteractiveLoginManager();
  try {
    let completed = null;
    manager.start({
      account: "work",
      agyBin: MOCK_AGY_BIN,
      geminiDir,
      appDataDir: "antigravity-acp",
      env: {
        ...process.env,
        MOCK_ACP_LOGIN_URL: "https://accounts.google.com/o/oauth2/v2/auth?code_challenge=abc",
        MOCK_ACP_LOGIN_DELAY_MS: "80",
      },
      onComplete: (snap) => {
        completed = snap;
      },
    });

    const deadline = Date.now() + 5000;
    while (!completed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(completed);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.authUrl, "https://accounts.google.com/o/oauth2/v2/auth?code_challenge=abc");
    assert.equal(fs.existsSync(path.join(geminiDir, ".mock-logged-in")), true);

    // Verify cancel stops a slow login cleanly
    manager.start({
      account: "work",
      agyBin: MOCK_AGY_BIN,
      geminiDir,
      appDataDir: "antigravity-acp",
      env: { ...process.env, MOCK_ACP_LOGIN_DELAY_MS: "5000" },
    });
    const cancelled = manager.cancel();
    assert.equal(cancelled.status, "cancelled");
  } finally {
    manager.dispose();
    clearAccountApiKey(geminiDir);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
