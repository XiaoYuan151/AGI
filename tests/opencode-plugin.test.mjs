import { describe, expect, test, mock } from "bun:test";
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

function createMockContext(options = {}) {
  const providers = new Map();
  const providerTransforms = [];
  const aisdkHooks = new Map();
  const sessionHooks = new Map();
  const tools = new Map();
  const commands = new Map();
  const synthetics = [];
  let reloadCalls = 0;

  const applyProviderTransforms = () => {
    const editor = {
      list: () => Array.from(providers.values()),
      get: (id) => providers.get(id),
      add: ({ info, models }) => {
        providers.set(info.id, {
          provider: { ...info },
          models: new Map(models.map((m) => [m.id, m])),
        });
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
    aisdkHooks,
    sessionHooks,
    tools,
    commands,
    synthetics,
    get reloadCalls() {
      return reloadCalls;
    },
  };
}

describe("OpenCode agi + agy acp integration", () => {
  test("registers native agy provider, streams LanguageModelV3, switches models, and keeps hello_greet", async () => {
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
    }
  });
});
