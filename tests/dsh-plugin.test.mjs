import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dshPlugin, { apply, name as pluginName, inject as pluginInject } from "../deepseek-harness/plugins/agi/src/index.mjs";
import {
  configureDsh,
  configureDshProfile,
  listDshProfiles,
  DSH_PACKAGE_NAME,
} from "../deepseek-harness/plugins/agi/scripts/setup-dsh.mjs";
import { runDshConnect } from "../deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGY_BIN = path.join(__dirname, "fixtures", "mock-agy");

function createMockCordisContext() {
  const adapters = new Map();
  const configurableProviders = [];
  const commands = new Map();
  const events = [];
  const cleanups = [];

  const ctx = {
    fiber: { entry: { options: { id: "agi-acp" } } },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) adapters.set(p, adapter);
        return () => {
          for (const p of providers) adapters.delete(p);
        };
      },
      registerConfigurableProviders(entries) {
        configurableProviders.push(...entries);
        return () => {
          configurableProviders.length = 0;
        };
      },
    },
    commands: {
      register(def) {
        commands.set(def.name, def);
        return () => {
          commands.delete(def.name);
        };
      },
    },
    emit(event, ...args) {
      events.push({ event, args });
    },
    inject(deps, fn) {
      if (deps.includes("commands")) {
        fn(ctx);
      }
    },
    effect(genFn) {
      const gen = genFn();
      const yielded = gen.next();
      if (typeof yielded.value === "function") {
        cleanups.push(yielded.value);
      }
    },
  };

  return {
    ctx,
    adapters,
    configurableProviders,
    commands,
    events,
    async disposeAll() {
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        await fn();
      }
    },
  };
}

test("DeepSeek Harness plugin registers LlmAdapter, streams valid StreamChunks, and handles commands", async () => {
  assert.equal(pluginName, "agi-acp");
  assert.deepEqual(pluginInject, ["llm"]);
  assert.equal(typeof dshPlugin.apply, "function");

  const harness = createMockCordisContext();
  const instance = apply(harness.ctx, {
    agyBin: MOCK_AGY_BIN,
    providerId: "agy",
    providerName: "Antigravity (ACP)",
    usePersistedConfig: false,
    env: { ...process.env, MOCK_ACP_EMIT_TOOL_CALLS: "1" },
  });

  try {
    const adapter = harness.adapters.get("agy");
    assert.ok(adapter);
    assert.deepEqual(adapter.providerInfo("agy"), {
      id: "agy",
      name: "Antigravity (ACP)",
    });
    assert.equal(harness.configurableProviders.length, 1);
    assert.equal(harness.configurableProviders[0].provider, "agy");
    assert.deepEqual(harness.configurableProviders[0].nativeAuth, {
      env: ["GEMINI_API_KEY"],
      oauth: true,
    });

    // listModels + resolveModel + prepareCall
    const models = await adapter.listModels("agy");
    assert.equal(models.length, 3);
    assert.ok(models.some((m) => m.id === "gemini-custom-preview"));
    assert.ok(models.every((m) => m.provider === "agy"));

    const prepared = await adapter.prepareCall("agy", "gemini-2.5-pro");
    assert.equal(prepared.model.id, "gemini-2.5-pro");
    assert.equal(prepared.model.context.contextWindow, 1000000);
    assert.equal(prepared.model.reasoning.defaultEffort, "medium");

    // Turn 1 streaming chunk lifecycle
    const chunks1 = [];
    for await (const chunk of prepared.stream({
      provider: "agy",
      model: "gemini-2.5-pro",
      reasoningEffort: "low",
      system: "You are helpful.",
      messages: [{ role: "user", content: [{ type: "text", text: "First DSH turn" }] }],
    })) {
      chunks1.push(chunk);
    }

    const types1 = chunks1.map((c) => c.type);
    assert.equal(types1[0], "block-start");
    assert.equal(chunks1[0].blockType, "reasoning");
    assert.ok(types1.includes("reasoning-delta"));
    assert.ok(types1.includes("text-delta"));
    assert.ok(types1.includes("usage"));
    assert.deepEqual(chunks1[chunks1.length - 1], {
      type: "finish",
      reason: { kind: "stop" },
    });

    const reasoningEnd = chunks1.find((c) => c.type === "block-end" && c.block?.type === "reasoning");
    const textEnd = chunks1.find((c) => c.type === "block-end" && c.block?.type === "text");
    assert.ok(reasoningEnd);
    assert.match(reasoningEnd.block.text, /Thinking on gemini-2\.5-pro/);
    assert.ok(textEnd);
    assert.match(textEnd.block.text, /model=gemini-2\.5-pro effort=low turn=1/);
    assert.match(textEnd.block.text, /\[agy tool: Read workspace \(completed\)\]/);

    // Turn 2 switches model & effort on same conversation -> preserves session & increments turn
    const chunks2 = [];
    for await (const chunk of adapter.stream({
      provider: "agy",
      model: "gemini-2.5-flash",
      reasoningEffort: "high",
      system: "You are helpful.",
      messages: [
        { role: "user", content: [{ type: "text", text: "First DSH turn" }] },
        { role: "assistant", content: [{ type: "text", text: textEnd.block.text }] },
        { role: "user", content: [{ type: "text", text: "Second DSH turn" }] },
      ],
    })) {
      chunks2.push(chunk);
    }
    const text2 = chunks2.find((c) => c.type === "block-end" && c.block?.type === "text")?.block?.text || "";
    assert.match(text2, /model=gemini-2\.5-flash effort=high turn=2/);
    assert.match(text2, /Second DSH turn/);
    assert.doesNotMatch(text2, /First DSH turn/);

    // AbortSignal maps cleanly to finish kind: "aborted"
    const ac = new AbortController();
    const abortChunks = [];
    for await (const chunk of adapter.stream({
      provider: "agy",
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "WAIT_FOREVER" }] }],
      signal: ac.signal,
    })) {
      abortChunks.push(chunk);
      if (chunk.type === "reasoning-delta" && chunk.text.includes("waiting for cancel")) {
        ac.abort();
      }
    }
    assert.equal(abortChunks[abortChunks.length - 1].type, "finish");
    assert.equal(abortChunks[abortChunks.length - 1].reason.kind, "aborted");

    // Slash commands registered & functional
    assert.ok(harness.commands.has("agy-connect"));
    assert.ok(harness.commands.has("agy-models"));
    assert.ok(harness.commands.has("agy-status"));

    const connectStatus = await harness.commands.get("agy-connect").handler({ rawInput: "status" });
    assert.equal(connectStatus.kind, "success");
    assert.match(connectStatus.text, /authenticated: true/);
    assert.match(connectStatus.text, /--login/);

    const modelsOut = await harness.commands.get("agy-models").handler({ rawInput: "" });
    assert.equal(modelsOut.kind, "success");
    assert.match(modelsOut.text, /agy\/gemini-custom-preview/);

    const statusOut = await harness.commands.get("agy-status").handler({ rawInput: "" });
    assert.equal(statusOut.kind, "success");
    assert.match(statusOut.text, /provider: agy/);
  } finally {
    await harness.disposeAll();
    await instance.dispose();
  }
});

test("DeepSeek Harness adapter maps auth failures to ACCOUNT_SIGN_IN_REQUIRED and supports /agy-connect logout + authenticate", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dsh-auth-"));
  const geminiDir = path.join(tmpDir, "antigravity");
  const harness = createMockCordisContext();
  const instance = apply(harness.ctx, {
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
    const adapter = harness.adapters.get("agy");
    const errChunks = [];
    for await (const chunk of adapter.stream({
      provider: "agy",
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    })) {
      errChunks.push(chunk);
    }
    const last = errChunks[errChunks.length - 1];
    assert.equal(last.type, "finish");
    assert.equal(last.reason.kind, "error");
    assert.equal(last.reason.failure.code, "ACCOUNT_SIGN_IN_REQUIRED");

    // Sign in via agy-dsh-connect helper
    const loginRes = await runDshConnect({
      action: "login",
      agyBin: MOCK_AGY_BIN,
      geminiDir,
      appDataDir: "antigravity-acp",
      usePersistedConfig: false,
      env: { ...process.env, MOCK_ACP_REQUIRE_AUTH: "1", GEMINI_API_KEY: "" },
      stdio: "pipe",
    });
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.authenticated, true);

    // Refresh inside DSH via /agy-connect refresh picks up new credentials
    const refreshOut = await harness.commands.get("agy-connect").handler({ rawInput: "refresh" });
    assert.equal(refreshOut.kind, "success");
    assert.match(refreshOut.text, /authenticated=true/);

    // /agy-connect logout clears credentials
    const logoutOut = await harness.commands.get("agy-connect").handler({ rawInput: "logout" });
    assert.equal(logoutOut.kind, "success");
    assert.match(logoutOut.text, /Signed out of Antigravity ACP/);

    // /agy-connect method gemini-api-key with key set authenticates cleanly
    await instance.client.setApiKey("dsh-test-key");
    const authOut = await harness.commands
      .get("agy-connect")
      .handler({ rawInput: "method gemini-api-key" });
    assert.equal(authOut.kind, "success");
    assert.match(authOut.text, /Authenticated Antigravity ACP via 'gemini-api-key'/);
  } finally {
    await harness.disposeAll();
    await instance.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("setup-dsh.mjs configures profiles idempotently, creates @local/dsh-agi symlink, and removes cleanly", () => {
  const tmpDshHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dsh-home-"));
  const desktopDir = path.join(tmpDshHome, "profiles", "desktop");
  const cliDir = path.join(tmpDshHome, "profiles", "cli");
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(
    path.join(desktopDir, "package.json"),
    JSON.stringify(
      {
        name: "dsh-profile-desktop",
        dependencies: { "@deepseek-ai/dsh-base": "0.2.2" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(cliDir, "package.json"),
    JSON.stringify(
      {
        name: "dsh-profile-cli",
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      },
      null,
      2,
    ),
    "utf8",
  );

  try {
    assert.deepEqual(listDshProfiles(tmpDshHome), ["cli", "desktop"]);

    // Configure all existing profiles
    const res = configureDsh({ dshHome: tmpDshHome });
    assert.equal(res.action, "configured");
    assert.deepEqual(res.profiles, ["cli", "desktop"]);

    for (const profile of ["cli", "desktop"]) {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(tmpDshHome, "profiles", profile, "package.json"), "utf8"),
      );
      assert.ok(pkg.dependencies[DSH_PACKAGE_NAME].startsWith("link:"));
      assert.ok(pkg.dsh.profile.bundles.includes(DSH_PACKAGE_NAME));
      const linkPath = path.join(tmpDshHome, "profiles", profile, "node_modules", "@local", "dsh-agi");
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    }

    // Re-running is idempotent (no duplicate bundle entries)
    configureDshProfile({ dshHome: tmpDshHome, profile: "desktop" });
    const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
    assert.equal(
      desktopPkg.dsh.profile.bundles.filter((b) => b === DSH_PACKAGE_NAME).length,
      1,
    );
    assert.equal(desktopPkg.dependencies["@deepseek-ai/dsh-base"], "0.2.2");

    // Remove cleans up package.json and symlinks while preserving existing entries
    const rmRes = configureDsh({ dshHome: tmpDshHome, remove: true });
    assert.equal(rmRes.action, "removed");
    const afterPkg = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
    assert.equal(afterPkg.dependencies[DSH_PACKAGE_NAME], undefined);
    assert.equal(afterPkg.dependencies["@deepseek-ai/dsh-base"], "0.2.2");
    assert.equal(afterPkg.dsh.profile.bundles.includes(DSH_PACKAGE_NAME), false);
    assert.equal(
      fs.existsSync(path.join(desktopDir, "node_modules", "@local", "dsh-agi")),
      false,
    );
  } finally {
    fs.rmSync(tmpDshHome, { recursive: true, force: true });
  }
});
