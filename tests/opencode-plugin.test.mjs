import { describe, expect, test, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MOCK_AGY_BIN = path.resolve(import.meta.dir, "fixtures", "mock-agy");

function createMockOpencodePluginModule() {
  return {
    Plugin: {
      define(def) {
        return def;
      },
    },
    Provider: {
      ID: {
        make(v) {
          return v;
        },
      },
    },
    Integration: {
      ID: {
        make(v) {
          return v;
        },
      },
    },
    Model: {
      ID: {
        make(v) {
          return v;
        },
      },
      VariantID: {
        make(v) {
          return v;
        },
      },
      Info: {
        default(providerID, id) {
          return {
            id,
            modelID: id,
            providerID,
            name: id,
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 200000, output: 32000 },
          };
        },
      },
    },
  };
}

mock.module("@opencode/plugin", () => createMockOpencodePluginModule());

const { default: agiPlugin } = await import(
  "../opencode/plugins/agi/src/index.ts"
);

function createMockContext(options = {}, { activeConnection = null, resolvedCredential = null } = {}) {
  const providers = new Map();
  const providerTransforms = [];
  const integrations = new Map();
  const integrationMethods = new Map();
  const connectionStatuses = [];
  const eventSubscribers = [];
  const aisdkHooks = new Map();
  const sessionHooks = new Map();
  const tools = new Map();
  const commands = new Map();
  const synthetics = [];
  let reloadCalls = 0;
  let currentActiveConnection = activeConnection;
  let currentResolvedCredential = resolvedCredential;

  const applyProviderTransforms = () => {
    const editor = {
      list: () => Array.from(providers.values()),
      get: (id) => providers.get(id),
      add: ({ info, models }) => {
        providers.set(info.id, {
          provider: { ...info },
          models: new Map(models.map((m) => [m.id, m])),
        });
        if (info.integrationID && !integrations.has(info.integrationID)) {
          integrations.set(info.integrationID, {
            id: info.integrationID,
            name: info.name,
          });
        }
      },
      update: (id, fn) => {
        const rec = providers.get(id);
        if (rec) fn(rec.provider);
      },
      remove: (id) => providers.delete(id),
      models: {
        set: (id, models) => {
          const rec = providers.get(id);
          if (rec) rec.models = new Map(models.map((m) => [m.id, m]));
        },
        update: (id, modelId, fn) => {
          const m = providers.get(id)?.models.get(modelId);
          if (m) fn(m);
        },
        remove: (id, modelId) => {
          providers.get(id)?.models.delete(modelId);
        },
      },
    };
    for (const cb of providerTransforms) cb(editor);
  };

  const ctx = {
    location: { directory: process.cwd() },
    options,
    provider: {
      transform: async (cb) => {
        providerTransforms.push(cb);
        applyProviderTransforms();
        return { dispose: async () => {} };
      },
      reload: async () => {
        reloadCalls += 1;
        applyProviderTransforms();
      },
    },
    integration: {
      transform: async (cb) => {
        cb({
          list: () => Array.from(integrations.values()),
          get: (id) => integrations.get(id),
          update: (id, fn) => {
            const item = integrations.get(id);
            if (item) fn(item);
          },
          remove: (id) => integrations.delete(id),
          method: {
            list: (integrationID) => integrationMethods.get(integrationID) || [],
            update: (input) => {
              const list = integrationMethods.get(input.integrationID) || [];
              list.push(input.method);
              integrationMethods.set(input.integrationID, list);
            },
            remove: (integrationID, method) => {
              const list = integrationMethods.get(integrationID) || [];
              integrationMethods.set(
                integrationID,
                list.filter((m) => m !== method),
              );
            },
          },
        });
        return { dispose: async () => {} };
      },
      reload: async () => {},
      connection: {
        active: async () => currentActiveConnection,
        resolve: async () => currentResolvedCredential,
        status: async (input) => {
          connectionStatuses.push(input);
        },
      },
    },
    event: {
      subscribe: ({ signal } = {}) => {
        const queue = [];
        let wake = null;
        let closed = false;
        const push = (evt) => {
          if (closed) return;
          if (wake) {
            const fn = wake;
            wake = null;
            fn({ value: evt, done: false });
          } else {
            queue.push(evt);
          }
        };
        const close = () => {
          closed = true;
          if (wake) {
            const fn = wake;
            wake = null;
            fn({ value: undefined, done: true });
          }
        };
        signal?.addEventListener("abort", close, { once: true });
        eventSubscribers.push({ push, close });
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (queue.length > 0) {
                  return Promise.resolve({ value: queue.shift(), done: false });
                }
                if (closed) {
                  return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) => {
                  wake = resolve;
                });
              },
            };
          },
        };
      },
    },
    aisdk: {
      hook: async (name, cb, opts) => {
        if (!aisdkHooks.has(name)) aisdkHooks.set(name, []);
        aisdkHooks.get(name).push({ cb, opts });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, cb, opts) => {
        if (!sessionHooks.has(name)) sessionHooks.set(name, []);
        sessionHooks.get(name).push({ cb, opts });
        return { dispose: async () => {} };
      },
      synthetic: async (input) => {
        synthetics.push(input);
      },
    },
    tool: {
      transform: async (cb) => {
        cb({
          namespace: () => {},
          add: (tool) => tools.set(tool.name, tool),
        });
        return { dispose: async () => {} };
      },
    },
    command: {
      transform: async (cb) => {
        cb({
          add: (cmd) => commands.set(cmd.name, cmd),
        });
        return { dispose: async () => {} };
      },
    },
  };

  return {
    ctx,
    providers,
    integrations,
    integrationMethods,
    connectionStatuses,
    aisdkHooks,
    sessionHooks,
    tools,
    commands,
    synthetics,
    setConnection(conn, cred) {
      currentActiveConnection = conn;
      currentResolvedCredential = cred;
    },
    emitEvent(evt) {
      for (const sub of eventSubscribers) sub.push(evt);
    },
    get reloadCalls() {
      return reloadCalls;
    },
  };
}

describe("OpenCode agi + agy acp integration", () => {
  test("registers native agy provider, streams LanguageModelV3, switches models, and keeps hello_greet", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-oc-basic-"));
    const prevAgiHome = process.env.AGI_HOME;
    const prevCfg = process.env.AGY_ACP_CONFIG;
    process.env.AGI_HOME = path.join(tmpRoot, ".agi");
    process.env.AGY_ACP_CONFIG = "0";

    const harness = createMockContext({
      greeting: "Hey",
      agyBin: MOCK_AGY_BIN,
      discoveryTimeoutMs: 4000,
    });

    const cleanup = await agiPlugin.setup(harness.ctx);
    try {
      // 1. Provider & models registered natively
      const agyProv = harness.providers.get("agy");
      expect(agyProv).toBeDefined();
      expect(agyProv.provider.activation).toBe("enabled");
      expect(agyProv.models.has("gemini-2.5-pro")).toBe(true);
      expect(agyProv.models.has("gemini-custom-preview")).toBe(true);
      const proModel = agyProv.models.get("gemini-2.5-pro");
      expect(proModel.variants.map((v) => v.id)).toEqual(["low", "medium", "high"]);

      // 2. Preserves hello_greet tool
      const greetTool = harness.tools.get("greet");
      expect(greetTool).toBeDefined();
      const greetOut = await greetTool.execute({ name: "OpenCode" }, {});
      expect(greetOut.content).toContain("Hey, OpenCode!");

      // 3. SDK & Language hooks resolve LanguageModelV3 for agy models
      const resolveLanguageModel = async (modelID) => {
        const modelInfo = agyProv.models.get(modelID);
        const sdkEvent = { model: modelInfo, package: "agy-acp", options: {} };
        for (const h of harness.aisdkHooks.get("sdk")) {
          if (!h.opts?.providerID || h.opts.providerID === "agy") await h.cb(sdkEvent);
        }
        expect(sdkEvent.sdk).toBeDefined();
        const langEvent = {
          model: modelInfo,
          sdk: sdkEvent.sdk,
          options: {},
        };
        for (const h of harness.aisdkHooks.get("language")) {
          if (!h.opts?.providerID || h.opts.providerID === "agy") await h.cb(langEvent);
        }
        return langEvent.language;
      };

      // 4. Context hook attaches sessionID & variant
      const ctxEvent = {
        sessionID: "oc_sess_1",
        agent: "build",
        model: { providerID: "agy", id: "gemini-2.5-pro", variant: "low" },
        system: [],
        messages: [],
        tools: {},
        options: {},
      };
      for (const h of harness.sessionHooks.get("context")) {
        await h.cb(ctxEvent);
      }
      expect(ctxEvent.system.some((s) => s.text.includes("hello_greet"))).toBe(true);
      expect(ctxEvent.options.agy.sessionID).toBe("oc_sess_1");
      expect(ctxEvent.options.agy.variant).toBe("low");

      // 5. Stream turn 1 on gemini-2.5-pro
      const lm1 = await resolveLanguageModel("gemini-2.5-pro");
      const { stream } = await lm1.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello OpenCode AGY" }] }],
        providerOptions: ctxEvent.options,
      });
      const reader = stream.getReader();
      const parts = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
      expect(parts[0].type).toBe("stream-start");
      expect(parts.some((p) => p.type === "reasoning-delta")).toBe(true);
      const streamedText = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("");
      expect(streamedText).toContain("model=gemini-2.5-pro effort=low turn=1");
      const finishPart = parts.find((p) => p.type === "finish");
      expect(finishPart.finishReason.unified).toBe("stop");
      expect(finishPart.usage.inputTokens.total).toBe(42);

      // 6. Mid-session /model switch to gemini-2.5-flash + variant "high"
      const lm2 = await resolveLanguageModel("gemini-2.5-flash");
      const gen2 = await lm2.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Hello OpenCode AGY" }] },
          { role: "assistant", content: [{ type: "text", text: streamedText }] },
          { role: "user", content: [{ type: "text", text: "Switched in /model" }] },
        ],
        providerOptions: {
          agy: { sessionID: "oc_sess_1", kind: "primary", variant: "high" },
        },
      });
      const genText = gen2.content.find((c) => c.type === "text")?.text || "";
      expect(genText).toContain("model=gemini-2.5-flash effort=high turn=2");
      expect(genText).toContain("Switched in /model");

      // 7. /agy-models & /agy-status commands emit synthetic output
      const cmdModels = harness.commands.get("agy-models");
      const cmdStatus = harness.commands.get("agy-status");
      expect(cmdModels).toBeDefined();
      expect(cmdStatus).toBeDefined();
      await cmdModels.execute({ sessionID: "oc_sess_1", prompt: [] });
      await cmdStatus.execute({ sessionID: "oc_sess_1", prompt: [] });
      expect(harness.synthetics.length).toBe(2);
      expect(harness.synthetics[0].text).toContain("agy/gemini-custom-preview");
      expect(harness.synthetics[1].text).toContain("Antigravity ACP status");
    } finally {
      await cleanup();
      if (prevAgiHome === undefined) delete process.env.AGI_HOME;
      else process.env.AGI_HOME = prevAgiHome;
      if (prevCfg === undefined) delete process.env.AGY_ACP_CONFIG;
      else process.env.AGY_ACP_CONFIG = prevCfg;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("integrates official agy acp sign-in with OpenCode native /connect and refreshes on credential update", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-oc-connect-"));
    const prevAgiHome = process.env.AGI_HOME;
    const prevCfg = process.env.AGY_ACP_CONFIG;
    const prevRequireAuth = process.env.MOCK_ACP_REQUIRE_AUTH;
    const prevApiKey = process.env.GEMINI_API_KEY;
    process.env.AGI_HOME = path.join(tmpRoot, ".agi");
    process.env.AGY_ACP_CONFIG = "0";
    process.env.MOCK_ACP_REQUIRE_AUTH = "1";
    delete process.env.GEMINI_API_KEY;

    const harness = createMockContext({
      agyBin: MOCK_AGY_BIN,
      geminiDir: "/tmp/agi-test-oc-gemini",
      appDataDir: "antigravity-acp",
      discoveryTimeoutMs: 2500,
    });

    const cleanup = await agiPlugin.setup(harness.ctx);
    try {
      // 1. Provider links to integrationID & registers native /connect methods
      const agyProv = harness.providers.get("agy");
      expect(agyProv.provider.integrationID).toBe("agy");
      const methods = harness.integrationMethods.get("agy");
      expect(Array.isArray(methods)).toBe(true);

      const cmdMethod = methods.find((m) => m.type === "command");
      expect(cmdMethod).toBeDefined();
      expect(cmdMethod.id).toBe("agy-acp-login");
      expect(cmdMethod.command).toEqual([
        MOCK_AGY_BIN,
        "acp",
        "--gemini-dir",
        "/tmp/agi-test-oc-gemini",
        "--app-data-dir",
        "antigravity-acp",
        "--login",
      ]);

      const keyMethod = methods.find((m) => m.type === "key");
      expect(keyMethod).toBeDefined();
      const envMethod = methods.find((m) => m.type === "env");
      expect(envMethod).toBeDefined();
      expect(envMethod.names).toEqual(["GEMINI_API_KEY"]);

      // 2. Initially unauthenticated (fallback models only)
      const connectTool = harness.tools.get("connect");
      expect(connectTool).toBeDefined();
      const initialStatus = JSON.parse((await connectTool.execute({ action: "status" })).content);
      expect(initialStatus.authenticated).toBe(false);
      expect(initialStatus.nativeCommand).toBe("/connect");

      // 3. Simulate user completing /connect with a GEMINI_API_KEY credential
      const fakeConn = { type: "credential", id: "cred_1", label: "Gemini Key", method: "key" };
      harness.setConnection(fakeConn, { type: "key", key: "test-gemini-key-from-connect" });
      harness.emitEvent({ type: "credential.updated" });

      for (let i = 0; i < 30; i++) {
        if (harness.providers.get("agy").models.has("gemini-custom-preview")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(harness.providers.get("agy").models.has("gemini-custom-preview")).toBe(true);
      expect(
        harness.connectionStatuses.some(
          (s) => s.integrationID === "agy" && s.status === undefined,
        ),
      ).toBe(true);

      // 4. /agy-connect command reports native /connect guidance & supports logout
      const connectCmd = harness.commands.get("agy-connect");
      expect(connectCmd).toBeDefined();
      await connectCmd.execute({ sessionID: "oc_sess_2" });
      expect(harness.synthetics.some((s) => s.text.includes("`/connect`"))).toBe(true);

      await connectCmd.execute({ sessionID: "oc_sess_2", arguments: "logout" });
      expect(harness.synthetics.some((s) => s.text.includes("Signed out of Antigravity ACP"))).toBe(true);
    } finally {
      await cleanup();
      if (prevAgiHome === undefined) delete process.env.AGI_HOME;
      else process.env.AGI_HOME = prevAgiHome;
      if (prevCfg === undefined) delete process.env.AGY_ACP_CONFIG;
      else process.env.AGY_ACP_CONFIG = prevCfg;
      if (prevRequireAuth === undefined) delete process.env.MOCK_ACP_REQUIRE_AUTH;
      else process.env.MOCK_ACP_REQUIRE_AUTH = prevRequireAuth;
      if (prevApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevApiKey;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("manages multi-account profiles via /agy-accounts command and agy_accounts tool", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-oc-accounts-"));
    const agiHome = path.join(tmpRoot, ".agi");
    const cfgPath = path.join(agiHome, "acp.json");
    const workDir = path.join(tmpRoot, "oc-work");
    const sideDir = path.join(tmpRoot, "oc-side");
    const prevAgiHome = process.env.AGI_HOME;
    const prevCfg = process.env.AGY_ACP_CONFIG;
    process.env.AGI_HOME = agiHome;
    process.env.AGY_ACP_CONFIG = cfgPath;

    const harness = createMockContext({
      agyBin: MOCK_AGY_BIN,
      discoveryTimeoutMs: 2500,
    });
    const cleanup = await agiPlugin.setup(harness.ctx);
    try {
      const accountsTool = harness.tools.get("accounts");
      const accountsCmd = harness.commands.get("agy-accounts");
      expect(accountsTool).toBeDefined();
      expect(accountsCmd).toBeDefined();

      const added = JSON.parse(
        (await accountsTool.execute({ action: "add", name: "work", dataDir: workDir })).content,
      );
      expect(added.ok).toBe(true);
      expect(added.activeAccount).toBe("work");
      expect(fs.existsSync(path.join(workDir, ".agi-account.json"))).toBe(true);

      await accountsCmd.execute({
        sessionID: "oc_sess_acct",
        arguments: `add side --data-dir "${sideDir}" --no-activate`,
      });
      await accountsCmd.execute({ sessionID: "oc_sess_acct", arguments: "list" });
      expect(harness.synthetics.some((s) => s.text.includes("`work`"))).toBe(true);
      expect(harness.synthetics.some((s) => s.text.includes("`side`"))).toBe(true);

      const switched = JSON.parse(
        (await accountsTool.execute({ action: "switch", name: "side" })).content,
      );
      expect(switched.account).toBe("side");
      expect(switched.dataDir).toBe(sideDir);

      const removed = JSON.parse(
        (await accountsTool.execute({ action: "remove", name: "side", purgeData: true })).content,
      );
      expect(removed.purgedData).toBe(true);
      expect(removed.activeAccount).toBe("work");
      expect(fs.existsSync(sideDir)).toBe(false);
    } finally {
      await cleanup();
      if (prevAgiHome === undefined) delete process.env.AGI_HOME;
      else process.env.AGI_HOME = prevAgiHome;
      if (prevCfg === undefined) delete process.env.AGY_ACP_CONFIG;
      else process.env.AGY_ACP_CONFIG = prevCfg;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("seeds from cache, finishes slow ACP discovery in background via provider.reload(), deduplicates variants, and preserves env GEMINI_API_KEY", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-oc-modern-"));
    const agiHome = path.join(tmpRoot, ".agi");
    const cfgPath = path.join(agiHome, "acp.json");
    const dataDir = path.join(agiHome, "antigravity");

    const prevAgiHome = process.env.AGI_HOME;
    const prevCfg = process.env.AGY_ACP_CONFIG;
    const prevDelay = process.env.MOCK_ACP_SESSION_DELAY_MS;
    const prevDual = process.env.MOCK_ACP_DUAL_MODELS;
    const prevRequireAuth = process.env.MOCK_ACP_REQUIRE_AUTH;
    const prevApiKey = process.env.GEMINI_API_KEY;

    process.env.AGI_HOME = agiHome;
    process.env.AGY_ACP_CONFIG = cfgPath;
    process.env.MOCK_ACP_SESSION_DELAY_MS = "300";
    process.env.MOCK_ACP_DUAL_MODELS = "1";
    process.env.MOCK_ACP_REQUIRE_AUTH = "1";
    process.env.GEMINI_API_KEY = "env-tos-key";

    try {
      // 1. Setup returns well before slow session/new completes so OpenCode plugin activation never times out
      const harness1 = createMockContext({
        agyBin: MOCK_AGY_BIN,
        geminiDir: dataDir,
        appDataDir: "antigravity-acp",
        discoveryTimeoutMs: 60,
        discoveryRpcTimeoutMs: 4000,
      });

      const t0 = Date.now();
      const cleanup1 = await agiPlugin.setup(harness1.ctx);
      const setupElapsedMs = Date.now() - t0;
      try {
        expect(setupElapsedMs).toBeLessThan(260);
        // Initially seeded with fallback while background discovery finishes
        expect(harness1.providers.get("agy").models.has("gemini-2.5-pro")).toBe(true);

        // Wait for background ACP discovery to complete & trigger ctx.provider.reload()
        for (let i = 0; i < 60; i++) {
          if (harness1.providers.get("agy").models.has("gemini-4-neon")) break;
          await new Promise((r) => setTimeout(r, 40));
        }

        const prov1 = harness1.providers.get("agy");
        expect(harness1.reloadCalls).toBeGreaterThanOrEqual(1);
        expect(prov1.models.has("gemini-4-neon")).toBe(true);
        expect(prov1.models.has("gemini-4-carbon")).toBe(true);
        expect(prov1.models.has("gemini-3.8-flash")).toBe(true);
        expect(prov1.models.has("gpt-oss-120b-medium")).toBe(true);
        // No flattened effort duplicates in /model
        expect(prov1.models.has("gemini-4-neon-high")).toBe(false);
        expect(prov1.models.has("gemini-4-neon-xhigh")).toBe(false);
        // Per-model variants preserved
        expect(prov1.models.get("gemini-4-neon").variants.map((v) => v.id)).toEqual([
          "low",
          "medium",
          "high",
          "xhigh",
        ]);
        expect(prov1.models.get("gemini-3.8-flash").variants.map((v) => v.id)).toEqual([
          "low",
          "medium",
          "high",
        ]);
      } finally {
        await cleanup1();
      }

      // 2. Subsequent startup with discoveryTimeoutMs=0 immediately seeds modern models from models-cache.json
      const harness2 = createMockContext({
        agyBin: MOCK_AGY_BIN,
        geminiDir: dataDir,
        appDataDir: "antigravity-acp",
        discoveryTimeoutMs: 0,
      });
      const cleanup2 = await agiPlugin.setup(harness2.ctx);
      try {
        const prov2 = harness2.providers.get("agy");
        expect(prov2.models.has("gemini-4-neon")).toBe(true);
        expect(prov2.models.has("gemini-3.8-flash")).toBe(true);
        expect(prov2.models.has("gemini-4-neon-high")).toBe(false);
      } finally {
        await cleanup2();
      }
    } finally {
      if (prevAgiHome === undefined) delete process.env.AGI_HOME;
      else process.env.AGI_HOME = prevAgiHome;
      if (prevCfg === undefined) delete process.env.AGY_ACP_CONFIG;
      else process.env.AGY_ACP_CONFIG = prevCfg;
      if (prevDelay === undefined) delete process.env.MOCK_ACP_SESSION_DELAY_MS;
      else process.env.MOCK_ACP_SESSION_DELAY_MS = prevDelay;
      if (prevDual === undefined) delete process.env.MOCK_ACP_DUAL_MODELS;
      else process.env.MOCK_ACP_DUAL_MODELS = prevDual;
      if (prevRequireAuth === undefined) delete process.env.MOCK_ACP_REQUIRE_AUTH;
      else process.env.MOCK_ACP_REQUIRE_AUTH = prevRequireAuth;
      if (prevApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevApiKey;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
