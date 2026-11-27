import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import dshPlugin, { apply, name as pluginName, inject as pluginInject } from "../deepseek-harness/plugins/agi/src/index.mjs";
import { createDshGuiServer } from "../deepseek-harness/plugins/agi/src/gui-server.mjs";
import {
  configureDsh,
  configureDshProfile,
  listDshProfiles,
  DSH_PACKAGE_NAME,
} from "../deepseek-harness/plugins/agi/scripts/setup-dsh.mjs";
import { runDshConnect } from "../deepseek-harness/plugins/agi/scripts/agy-dsh-connect.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGY_BIN = path.join(__dirname, "fixtures", "mock-agy");
const DSH_CLIENT_BUNDLE_PATH = path.resolve(
  __dirname,
  "../deepseek-harness/plugins/agi/src/client/index.js",
);

function createMockCordisContext() {
  const adapters = new Map();
  const configurableProviders = [];
  const commands = new Map();
  const fetchRoutes = new Map();
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
    connection: {
      fetch: {
        register(route) {
          fetchRoutes.set(route.path, route);
          return () => {
            fetchRoutes.delete(route.path);
          };
        },
      },
    },
    emit(event, ...args) {
      events.push({ event, args });
    },
    inject(deps, fn) {
      if (deps.includes("commands") || deps.includes("connection")) {
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
    fetchRoutes,
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

test("DeepSeek Harness /agy-accounts manages multiple accounts in isolated data folders", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dsh-accounts-"));
  const agiHome = path.join(tmpRoot, ".agi");
  const cfgPath = path.join(agiHome, "acp.json");
  const workDir = path.join(tmpRoot, "work-dir");
  const sideDir = path.join(tmpRoot, "side-dir");
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

  const harness = createMockCordisContext();
  const instance = apply(harness.ctx, {
    agyBin: MOCK_AGY_BIN,
    env,
  });

  try {
    const accountsCmd = harness.commands.get("agy-accounts");
    assert.ok(accountsCmd);

    const addWork = await accountsCmd.handler({ rawInput: `add work --data-dir "${workDir}"` });
    assert.equal(addWork.kind, "success");
    assert.match(addWork.text, /Added account 'work'/);
    assert.ok(fs.existsSync(path.join(workDir, ".agi-account.json")));

    // Sign in on 'work'
    const loginRes = await runDshConnect({
      action: "login",
      account: "work",
      agyBin: MOCK_AGY_BIN,
      env,
      stdio: "pipe",
    });
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.authenticated, true);

    const addSide = await accountsCmd.handler({
      rawInput: `add side --data-dir "${sideDir}" --no-activate`,
    });
    assert.equal(addSide.kind, "success");

    const listOut = await accountsCmd.handler({ rawInput: "list" });
    assert.equal(listOut.kind, "success");
    assert.match(listOut.text, /\* work/);
    assert.match(listOut.text, /side/);

    const useSide = await accountsCmd.handler({ rawInput: "use side" });
    assert.equal(useSide.kind, "success");
    assert.match(useSide.text, /Switched active account to 'side'/);
    assert.match(useSide.text, /authenticated=false/);

    const rmSide = await accountsCmd.handler({ rawInput: "remove side --purge" });
    assert.equal(rmSide.kind, "success");
    assert.match(rmSide.text, /purgedData=true/);
    assert.equal(fs.existsSync(sideDir), false);
  } finally {
    await harness.disposeAll();
    await instance.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("DSH plugin /api/agi manages accounts, API keys without leaks, Google OAuth login polling, and /agy-gui", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-dsh-gui-api-"));
  const agiHome = path.join(tmpRoot, "agi-home");
  const workDir = path.join(tmpRoot, "work-gemini");
  const altDir = path.join(tmpRoot, "alt-gemini");

  const harness = createMockCordisContext();
  const instance = apply(harness.ctx, {
    agyBin: MOCK_AGY_BIN,
    env: {
      ...process.env,
      AGI_HOME: agiHome,
      MOCK_ACP_REQUIRE_AUTH: "1",
      MOCK_ACP_LOGIN_URL: "https://accounts.google.com/o/oauth2/v2/auth?mock=1",
      MOCK_ACP_LOGIN_DELAY_MS: "50",
    },
  });

  const apiRoute = harness.fetchRoutes.get("/api/agi");
  assert.ok(apiRoute, "Expected /api/agi fetch route to register");

  async function callApi(method, body) {
    const req = new Request("http://127.0.0.1/api/agi", {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await apiRoute.fetch(req);
    return { status: res.status, data: await res.json() };
  }

  try {
    // 1. Add account & activate
    const added = await callApi("POST", {
      action: "account-add",
      name: "work",
      label: "Work Account",
      dataDir: workDir,
      activate: true,
    });
    assert.equal(added.status, 200);
    assert.equal(added.data.activeAccount, "work");
    assert.equal(added.data.status.authenticated, false);
    assert.equal(added.data.auth.authenticated, false);

    // 2. Add second account without activating, update it
    await callApi("POST", {
      action: "account-add",
      name: "alt",
      dataDir: altDir,
      activate: false,
    });
    const updated = await callApi("POST", {
      action: "account-update",
      name: "alt",
      label: "Alt Account Updated",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.accounts.find((a) => a.name === "alt")?.label, "Alt Account Updated");

    // 3. Authenticate with API key on alt without exposing raw secret in JSON
    const secretKey = "AIza-super-secret-do-not-leak";
    const keyRes = await callApi("POST", {
      action: "auth-api-key",
      account: "alt",
      apiKey: secretKey,
      persist: true,
    });
    assert.equal(keyRes.status, 200);
    assert.equal(JSON.stringify(keyRes.data).includes(secretKey), false);
    assert.equal(keyRes.data.accounts.find((a) => a.name === "alt")?.hasStoredApiKey, true);
    assert.equal(keyRes.data.accounts.find((a) => a.name === "alt")?.probed?.authenticated, true);

    // Clear stored API key cleanly
    const clrRes = await callApi("POST", { action: "auth-api-key-clear", account: "alt" });
    assert.equal(clrRes.status, 200);
    assert.equal(clrRes.data.accounts.find((a) => a.name === "alt")?.hasStoredApiKey, false);

    // 4. Start Google login on 'work' and poll until succeeded
    const startLogin = await callApi("POST", {
      action: "login-google-start",
      account: "work",
    });
    assert.equal(startLogin.status, 200);
    assert.ok(["running", "succeeded"].includes(startLogin.data.loginSession.status));

    let polled = startLogin.data;
    const deadline = Date.now() + 5000;
    while (polled.loginSession.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
      polled = (await callApi("POST", { action: "login-google-status" })).data;
    }
    assert.equal(polled.loginSession.status, "succeeded");
    assert.equal(polled.loginSession.authUrl, "https://accounts.google.com/o/oauth2/v2/auth?mock=1");

    // 5. Probe accounts + logout + switch + remove with purge
    const probed = await callApi("POST", { action: "probe-accounts" });
    assert.equal(probed.status, 200);
    assert.equal(probed.data.accounts.find((a) => a.name === "work")?.probed?.authenticated, true);

    const switched = await callApi("POST", { action: "account-use", name: "alt" });
    assert.equal(switched.status, 200);
    assert.equal(switched.data.activeAccount, "alt");

    const removed = await callApi("POST", {
      action: "account-remove",
      name: "alt",
      purgeData: true,
    });
    assert.equal(removed.status, 200);
    assert.equal(fs.existsSync(altDir), false);

    // 6. Unknown action returns clean 400
    const badAction = await callApi("POST", { action: "not-a-real-action" });
    assert.equal(badAction.status, 400);
    assert.equal(badAction.data.ok, false);

    // 7. /agy-gui slash command status/start/stop
    const guiCmd = harness.commands.get("agy-gui");
    assert.ok(guiCmd);
    const guiStatus = await guiCmd.handler({ rawInput: "status" });
    assert.equal(guiStatus.kind, "success");
    assert.match(guiStatus.text, /not running/i);

    const guiStarted = await guiCmd.handler({ rawInput: "start" });
    assert.equal(guiStarted.kind, "success");
    assert.match(guiStarted.text, /http:\/\/127\.0\.0\.1:\d+/);

    const guiStopped = await guiCmd.handler({ rawInput: "stop" });
    assert.equal(guiStopped.kind, "success");
    assert.match(guiStopped.text, /stopped/i);
  } finally {
    await harness.disposeAll();
    await instance.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("Standalone createDshGuiServer serves GUI HTML, enforces loopback Origin, and executes /api/agi", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agi-dsh-standalone-"));
  const agiHome = path.join(tmpRoot, "agi-home");

  const gui = createDshGuiServer({
    host: "127.0.0.1",
    port: 0,
    agyBin: MOCK_AGY_BIN,
    env: { ...process.env, AGI_HOME: agiHome },
  });
  const started = await gui.start();

  try {
    const htmlRes = await fetch(started.url);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Antigravity \(ACP\)/);
    assert.match(html, /\/api\/agi/);

    const getRes = await fetch(`${started.url}/api/agi`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.ok, true);
    assert.equal(getData.provider.id, "agy");

    const postRes = await fetch(`${started.url}/api/agi`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: started.url },
      body: JSON.stringify({
        action: "account-add",
        name: "solo",
        label: "Solo Account",
        activate: true,
      }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.activeAccount, "solo");

    // Non-loopback Origin must be rejected with 403
    const evilOriginRes = await fetch(`${started.url}/api/agi`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ action: "state" }),
    });
    assert.equal(evilOriginRes.status, 403);
  } finally {
    await gui.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("DSH client bundle registers @local/dsh-agi via window.__ModuleLoader__ with settings.section, plugins.item, and locale", () => {
  const bundleCode = fs.readFileSync(DSH_CLIENT_BUNDLE_PATH, "utf8");
  let loadedModule = null;
  const mockReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (v) => [typeof v === "function" ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, "@local/dsh-agi");
          loadedModule = factory((dep) => {
            if (dep === "react") return mockReact;
            throw new Error(`Unexpected dependency ${dep}`);
          });
        },
      },
    },
    navigator: { language: "en-US" },
  };
  vm.runInNewContext(bundleCode, sandbox);

  assert.ok(loadedModule);
  assert.equal(loadedModule.name, "agi-acp");
  assert.deepEqual(Array.from(loadedModule.inject), ["slots", "locale"]);

  const registeredLocales = {};
  const injectedSlots = [];
  const registeredSlots = [];
  loadedModule.apply({
    locale: {
      current: "en",
      register(ns, dict) {
        registeredLocales[ns] = dict;
      },
      t(key) {
        return key;
      },
    },
    slots: {
      inject(name, factory) {
        injectedSlots.push(name);
        return factory();
      },
      register(meta, component) {
        registeredSlots.push({ meta, component });
        return () => {};
      },
    },
  });

  assert.ok(registeredLocales["agi-acp"]?.en?.title);
  assert.ok(registeredLocales["agi-acp"]?.zh?.title);
  assert.deepEqual(injectedSlots, ["plugins.bundle.config"]);
  assert.equal(registeredSlots.length, 1);
  assert.equal(registeredSlots[0].meta.name, "plugins.bundle.config");
  assert.equal(registeredSlots[0].meta.key, "@local/dsh-agi");
  assert.equal(typeof registeredSlots[0].component, "function");

  // Only renders inside plugin detail, never on the plugin summary row
  assert.equal(registeredSlots[0].component({ view: "summary" }), null);
  const detailEl = registeredSlots[0].component({ view: "detail" });
  assert.equal(typeof detailEl?.type, "function");
  const defaultEl = registeredSlots[0].component({});
  assert.equal(typeof defaultEl?.type, "function");
});
