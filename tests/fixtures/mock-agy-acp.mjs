#!/usr/bin/env node
import readline from "node:readline";

const requireAuth = process.env.MOCK_ACP_REQUIRE_AUTH === "1";
const legacyModels = process.env.MOCK_ACP_LEGACY_MODELS === "1";
const requestPermission = process.env.MOCK_ACP_REQUEST_PERMISSION === "1";
const emitToolCalls = process.env.MOCK_ACP_EMIT_TOOL_CALLS === "1";
const ignoreCancel = process.env.MOCK_ACP_IGNORE_CANCEL === "1";

let authenticated = !requireAuth;
let nextSessionNum = 1;
const sessions = new Map();

const MODELS = [
  {
    value: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Pro reasoning model",
    _meta: { contextWindow: 1000000, maxOutputTokens: 65536 },
  },
  {
    value: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast coding model",
    _meta: { contextWindow: 1000000, maxOutputTokens: 65536 },
  },
  {
    value: "gemini-custom-preview",
    name: "Gemini Custom Preview",
    description: "Custom preview model",
    _meta: { contextWindow: 500000, maxOutputTokens: 32768 },
  },
];

const EFFORTS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

let pendingPermId = 9000;
const pendingPermissions = new Map();

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function makeSessionPayload(session) {
  if (legacyModels) {
    return {
      sessionId: session.sessionId,
      models: {
        currentModelId: session.model,
        availableModels: MODELS.map((m) => ({
          modelId: m.value,
          name: m.name,
          description: m.description,
        })),
      },
    };
  }
  return {
    sessionId: session.sessionId,
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: session.model,
        options: [
          {
            group: "gemini",
            name: "Gemini",
            options: MODELS,
          },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking Level",
        type: "select",
        category: "thought_level",
        currentValue: session.effort,
        options: EFFORTS,
      },
    ],
  };
}

function extractPromptText(prompt) {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return String(block.text || "");
      if (block.type === "image") return `[image:${block.mimeType || "image/png"}]`;
      return "";
    })
    .filter(Boolean)
    .join(" | ");
}

function requestClientPermission(sessionId) {
  const id = pendingPermId++;
  return new Promise((resolve) => {
    pendingPermissions.set(id, resolve);
    write({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: `tc_${id}`, title: "Run shell test" },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject_once", kind: "reject_once", name: "Reject once" },
        ],
      },
    });
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Response to server->client request
  if (msg.id !== undefined && msg.id !== null && typeof msg.method !== "string") {
    const resolver = pendingPermissions.get(msg.id);
    if (resolver) {
      pendingPermissions.delete(msg.id);
      resolver(msg.result);
    }
    return;
  }

  // Notification
  if (msg.id === undefined || msg.id === null) {
    if (msg.method === "session/cancel" && !ignoreCancel) {
      const s = sessions.get(msg.params?.sessionId);
      if (s) s.cancelled = true;
    }
    return;
  }

  const { id, method, params = {} } = msg;

  try {
    if (method === "initialize") {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: true },
            sessionCapabilities: { close: {} },
          },
          agentInfo: { name: "Mock Antigravity ACP", version: "1.5.15-mock" },
          authMethods: [
            { id: "oauth-personal", name: "Log in with Google" },
            { id: "gemini-api-key", name: "Gemini API key" },
          ],
        },
      });
      return;
    }

    if (method === "authenticate") {
      if (params.methodId === "gemini-api-key" && process.env.GEMINI_API_KEY) {
        authenticated = true;
        write({ jsonrpc: "2.0", id, result: {} });
      } else if (params.methodId === "oauth-personal" && process.env.MOCK_ALLOW_OAUTH === "1") {
        authenticated = true;
        write({ jsonrpc: "2.0", id, result: {} });
      } else {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "Authentication failed" },
        });
      }
      return;
    }

    if (method === "session/new") {
      if (!authenticated) {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "Authentication required" },
        });
        return;
      }
      const sessionId = `sess_${nextSessionNum++}`;
      const session = {
        sessionId,
        cwd: params.cwd || process.cwd(),
        model: "gemini-2.5-pro",
        effort: "medium",
        turns: 0,
        cancelled: false,
      };
      sessions.set(sessionId, session);
      write({ jsonrpc: "2.0", id, result: makeSessionPayload(session) });
      return;
    }

    if (method === "session/close") {
      sessions.delete(params.sessionId);
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "session/set_config_option") {
      const s = sessions.get(params.sessionId);
      if (!s) {
        write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown session" } });
        return;
      }
      if (legacyModels) {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
        return;
      }
      if (params.configId === "model") s.model = String(params.value);
      if (params.configId === "thought_level") s.effort = String(params.value);
      write({ jsonrpc: "2.0", id, result: makeSessionPayload(s) });
      return;
    }

    if (method === "session/set_model") {
      const s = sessions.get(params.sessionId);
      if (!s) {
        write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown session" } });
        return;
      }
      s.model = String(params.modelId);
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "session/prompt") {
      const s = sessions.get(params.sessionId);
      if (!s) {
        write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown session" } });
        return;
      }
      s.turns += 1;
      s.cancelled = false;
      const promptText = extractPromptText(params.prompt);

      if (promptText.includes("WAIT_FOREVER")) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: s.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "waiting for cancel" },
            },
          },
        });
        const check = setInterval(() => {
          if (s.cancelled) {
            clearInterval(check);
            write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
          }
        }, 20);
        if (typeof check.unref === "function") check.unref();
        return;
      }

      let permDecision = "none";
      if (requestPermission) {
        const permRes = await requestClientPermission(s.sessionId);
        permDecision =
          permRes?.outcome?.outcome === "selected"
            ? permRes.outcome.optionId
            : permRes?.outcome?.outcome || "cancelled";
      }

      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: s.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: `Thinking on ${s.model} (effort=${s.effort}).` },
          },
        },
      });

      if (emitToolCalls) {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: s.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc_1",
              title: "Read workspace",
              status: "completed",
            },
          },
        });
      }

      const replyText = `[mock-acp model=${s.model} effort=${s.effort} turn=${s.turns} perm=${permDecision} session=${s.sessionId}] ${promptText}`;
      const half = Math.ceil(replyText.length / 2);
      for (const chunk of [replyText.slice(0, half), replyText.slice(half)]) {
        if (!chunk) continue;
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: s.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: chunk },
            },
          },
        });
      }

      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: s.sessionId,
          update: {
            sessionUpdate: "usage_update",
            usage: { inputTokens: 42, outputTokens: 17 },
          },
        },
      });

      write({
        jsonrpc: "2.0",
        id,
        result: {
          stopReason: "end_turn",
          usage: { inputTokens: 42, outputTokens: 17 },
        },
      });
      return;
    }

    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err.message },
    });
  }
});
