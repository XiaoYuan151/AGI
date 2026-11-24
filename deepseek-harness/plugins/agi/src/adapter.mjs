import crypto from "node:crypto";
import fs from "node:fs";
import {
  AgyAuthRequiredError,
  AgyPolicyCooldownError,
  normalizeModelId,
} from "./lib/agy-acp-client.mjs";

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function summarizeContentBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool-call") {
      parts.push(`[Tool call: ${block.name || "tool"}(${block.arguments || "{}"})]`);
    } else if (block.type === "image") {
      const name = block.attachment?.name || block.attachment?.id || "image";
      parts.push(`[Image: ${name}]`);
    } else if (block.type === "file") {
      const name = block.attachment?.name || block.attachment?.id || "file";
      parts.push(`[File: ${name}]`);
    }
  }
  return parts.join("\n");
}

function imageBlockToAcp(block) {
  if (block.offloaded) {
    return {
      type: "text",
      text: `[Offloaded image: ${block.attachment?.name || block.attachment?.id || "image"}]`,
    };
  }
  const att = block.attachment || {};
  if (typeof att.base64 === "string" && att.base64) {
    return {
      type: "image",
      data: att.base64,
      mimeType: att.mediaType || att.mimeType || "image/png",
    };
  }
  if (typeof att.data === "string" && att.data) {
    const match = att.data.match(/^data:([^;]+);base64,(.+)$/);
    return {
      type: "image",
      data: match ? match[2] : att.data,
      mimeType: match ? match[1] : att.mediaType || att.mimeType || "image/png",
    };
  }
  if (att.data instanceof Uint8Array) {
    return {
      type: "image",
      data: Buffer.from(att.data).toString("base64"),
      mimeType: att.mediaType || att.mimeType || "image/png",
    };
  }
  if (typeof att.path === "string" && att.path) {
    try {
      const bytes = fs.readFileSync(att.path);
      return {
        type: "image",
        data: bytes.toString("base64"),
        mimeType: att.mediaType || att.mimeType || "image/png",
      };
    } catch {
      // Fall back to text placeholder below
    }
  }
  return {
    type: "text",
    text: `[Attached image: ${att.name || att.id || "image"}]`,
  };
}

function messageToAcpBlocks(msg) {
  const blocks = [];
  if (!msg) return blocks;
  if (typeof msg.content === "string") {
    if (msg.content) blocks.push({ type: "text", text: msg.content });
    return blocks;
  }
  if (!Array.isArray(msg.content)) return blocks;

  if (msg.role === "tool") {
    const text = summarizeContentBlocks(msg.content);
    const label = msg.isError ? "Tool error" : "Tool result";
    blocks.push({
      type: "text",
      text: `[${label} (${msg.toolCallId || "call"})]\n${text}`,
    });
    return blocks;
  }

  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push(imageBlockToAcp(block));
    } else if (block.type === "file") {
      const att = block.attachment || {};
      blocks.push({
        type: "text",
        text: `[Attached file: ${att.name || att.id || "file"}]`,
      });
    } else if (block.type === "tool-call") {
      blocks.push({
        type: "text",
        text: `[Tool call: ${block.name || "tool"}(${block.arguments || "{}"})]`,
      });
    }
  }
  return blocks;
}

export function buildAcpPromptFromDsh(
  messages,
  { system = "", existingTurnCount = 0, auxiliary = false } = {},
) {
  const list = Array.isArray(messages) ? messages : [];
  const systemParts = [];
  if (typeof system === "string" && system.trim()) {
    systemParts.push(system.trim());
  }
  for (const msg of list) {
    if (msg?.role === "system") {
      const txt = summarizeContentBlocks(msg.content).trim();
      if (txt) systemParts.push(txt);
    }
  }
  const systemText = systemParts.join("\n\n");
  const nonSystem = list.filter((m) => m && m.role !== "system" && m.role !== "developer");

  if (existingTurnCount > 0 && !auxiliary) {
    let lastAssistantIdx = -1;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (nonSystem[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    const tail = nonSystem.slice(lastAssistantIdx + 1);
    const blocks = [];
    for (const msg of tail) {
      blocks.push(...messageToAcpBlocks(msg));
    }
    if (blocks.length > 0) return blocks;
  }

  const blocks = [];
  if (auxiliary && systemText) {
    blocks.push({ type: "text", text: `[System instructions]\n${systemText}` });
  }

  if (nonSystem.length <= 1) {
    if (nonSystem[0]) {
      blocks.push(...messageToAcpBlocks(nonSystem[0]));
    }
  } else {
    let lastNonAssistantIdx = nonSystem.length - 1;
    while (lastNonAssistantIdx > 0 && nonSystem[lastNonAssistantIdx].role === "assistant") {
      lastNonAssistantIdx--;
    }
    const prior = nonSystem.slice(0, lastNonAssistantIdx);
    const priorLines = prior
      .map((m) => {
        const text = summarizeContentBlocks(m.content).trim();
        if (!text) return "";
        const label =
          m.role === "assistant"
            ? "Assistant"
            : m.role === "tool"
              ? `Tool(${m.toolCallId || "result"})`
              : "User";
        return `${label}: ${text}`;
      })
      .filter(Boolean);

    if (priorLines.length > 0) {
      blocks.push({
        type: "text",
        text: `[Prior conversation context]\n${priorLines.join("\n\n")}\n\n[Current user message]`,
      });
    }
    for (const msg of nonSystem.slice(lastNonAssistantIdx)) {
      if (msg.role !== "assistant") {
        blocks.push(...messageToAcpBlocks(msg));
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

function mapUsageToDsh(usage) {
  if (!usage || typeof usage !== "object") return null;
  const rawInput =
    typeof usage.inputTokens === "number"
      ? usage.inputTokens
      : typeof usage.promptTokens === "number"
        ? usage.promptTokens
        : typeof usage.input_tokens === "number"
          ? usage.input_tokens
          : undefined;
  const rawOutput =
    typeof usage.outputTokens === "number"
      ? usage.outputTokens
      : typeof usage.completionTokens === "number"
        ? usage.completionTokens
        : typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : undefined;
  if (rawInput === undefined && rawOutput === undefined) return null;

  const cacheReadTokens =
    typeof usage.cachedReadTokens === "number"
      ? usage.cachedReadTokens
      : typeof usage.cacheReadTokens === "number"
        ? usage.cacheReadTokens
        : undefined;
  const cacheWriteTokens =
    typeof usage.cachedWriteTokens === "number"
      ? usage.cachedWriteTokens
      : typeof usage.cacheWriteTokens === "number"
        ? usage.cacheWriteTokens
        : undefined;
  const reasoningTokens =
    typeof usage.thoughtTokens === "number"
      ? usage.thoughtTokens
      : typeof usage.reasoningTokens === "number"
        ? usage.reasoningTokens
        : undefined;

  const inputTokens = rawInput ?? 0;
  const outputTokens = rawOutput ?? 0;
  const totalTokens =
    typeof usage.totalTokens === "number"
      ? usage.totalTokens
      : inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function mapErrorToDshFailure(err) {
  if (err instanceof AgyAuthRequiredError || err?.code === -32000) {
    return {
      code: "ACCOUNT_SIGN_IN_REQUIRED",
      message: err.message || "Antigravity ACP requires authentication.",
    };
  }
  if (err instanceof AgyPolicyCooldownError || err?.code === 403 || err?.code === 429) {
    return {
      code: "RATE_LIMITED",
      status: err?.code === 403 ? 403 : 429,
      ...(typeof err?.retryAfterMs === "number" && err.retryAfterMs > 0
        ? { providerRetryAfterMs: err.retryAfterMs }
        : {}),
      message: err.message || "Antigravity ACP rate/policy cooldown active.",
    };
  }
  return {
    code: "PROVIDER_ERROR",
    message: err instanceof Error ? err.message : String(err),
  };
}

function deriveConversationKey(options) {
  if (options?.sessionId && String(options.sessionId).trim()) {
    return `dsh:${String(options.sessionId).trim()}`;
  }
  const firstUser = (options?.messages || []).find((m) => m?.role === "user");
  const seed = firstUser ? summarizeContentBlocks(firstUser.content) : "";
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 20);
  return `dsh:${hash}`;
}

function createAsyncQueue() {
  const items = [];
  let resolver = null;
  let closed = false;

  return {
    push(value) {
      if (closed) return;
      if (resolver) {
        const fn = resolver;
        resolver = null;
        fn({ value, done: false });
      } else {
        items.push(value);
      }
    },
    close() {
      closed = true;
      if (resolver) {
        const fn = resolver;
        resolver = null;
        fn({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length > 0) {
            return Promise.resolve({ value: items.shift(), done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            resolver = resolve;
          });
        },
      };
    },
  };
}

/**
 * Native DeepSeek Harness LlmAdapter backed directly by official `agy acp` over stdio.
 * Implements the full @deepseek-ai/dsh-llm LlmAdapter interface without runtime dependencies.
 */
export class AgyDshAdapter {
  constructor({
    client,
    providerId = "agy",
    providerName = "Antigravity (ACP)",
    cwd = process.cwd(),
    showToolActivity = true,
  }) {
    this.client = client;
    this.providerId = providerId;
    this.providerName = providerName;
    this.cwd = cwd;
    this.showToolActivity = showToolActivity;
  }

  providerInfo(provider) {
    return {
      id: provider,
      name: this.providerName,
    };
  }

  providerRetryPolicy(_provider) {
    return undefined;
  }

  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return {
      width: image.width,
      height: image.height,
      maxBytes: image.bytes,
    };
  }

  async listModels(provider) {
    const discovery = await this.client.discoverModels({
      cwd: this.cwd,
      forceRefresh: false,
      timeoutMs: 4000,
    });
    const models = discovery.models || this.client.fallbackModels;
    return models.map((m) => ({
      provider,
      id: m.id,
      name: m.name || m.id,
      ...(m.description ? { description: m.description } : {}),
      inputModalities: m.supportsImages === false ? ["text"] : ["text", "image"],
    }));
  }

  async resolveModel(provider, model, signal) {
    if (signal?.aborted) {
      throw new Error("Model resolution aborted");
    }
    const normalized = normalizeModelId(model) || String(model);
    const discovery =
      this.client.lastDiscovery ||
      (await this.client.discoverModels({
        cwd: this.cwd,
        forceRefresh: false,
        timeoutMs: 2500,
      }));
    const list = discovery?.models || this.client.fallbackModels;
    const spec =
      list.find((m) => normalizeModelId(m.id) === normalized) || {
        id: normalized,
        name: normalized,
        description: "Antigravity ACP model",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        supportsImages: true,
        efforts: ["low", "medium", "high"],
      };

    const efforts =
      Array.isArray(spec.efforts) && spec.efforts.length > 0
        ? spec.efforts
        : ["low", "medium", "high"];

    return {
      provider,
      id: spec.id,
      name: spec.name || spec.id,
      ...(spec.description ? { description: spec.description } : {}),
      inputModalities: spec.supportsImages === false ? ["text"] : ["text", "image"],
      context: {
        contextWindow: spec.contextWindow || 1000000,
      },
      defaultMaxTokens: spec.maxOutputTokens || 65536,
      reasoning: {
        efforts: efforts.map((id) => ({
          id,
          name: capitalize(id),
        })),
        defaultEffort: efforts.includes("medium") ? "medium" : efforts[0],
      },
    };
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  async *stream(options) {
    const auxiliary = Boolean(options?.purpose);
    const conversationKey = deriveConversationKey(options);
    const existingTurnCount = auxiliary ? 0 : this.client.getCachedTurnCount(conversationKey);
    const promptBlocks = buildAcpPromptFromDsh(options?.messages || [], {
      system: options?.system || "",
      existingTurnCount,
      auxiliary,
    });
    const modelId = normalizeModelId(options?.model) || String(options?.model || "");
    const effort =
      typeof options?.reasoningEffort === "string" && options.reasoningEffort.trim()
        ? options.reasoningEffort.trim()
        : undefined;

    const queue = createAsyncQueue();
    let nextBlockIndex = 0;
    let activeReasoningIdx = null;
    let activeReasoningText = "";
    let activeTextIdx = null;
    let activeText = "";

    const closeReasoning = () => {
      if (activeReasoningIdx === null) return;
      queue.push({
        type: "block-end",
        index: activeReasoningIdx,
        block: { type: "reasoning", text: activeReasoningText },
      });
      activeReasoningIdx = null;
      activeReasoningText = "";
    };

    const closeText = () => {
      if (activeTextIdx === null) return;
      queue.push({
        type: "block-end",
        index: activeTextIdx,
        block: { type: "text", text: activeText },
      });
      activeTextIdx = null;
      activeText = "";
    };

    const ensureTextOpen = () => {
      closeReasoning();
      if (activeTextIdx === null) {
        activeTextIdx = nextBlockIndex++;
        activeText = "";
        queue.push({
          type: "block-start",
          index: activeTextIdx,
          blockType: "text",
        });
      }
    };

    const turnPromise = this.client
      .promptTurn({
        conversationKey,
        cwd: this.cwd,
        modelId,
        effort,
        promptBlocks,
        auxiliary,
        signal: options?.signal,
        onEvent: (evt) => {
          if (evt.type === "thought") {
            closeText();
            if (activeReasoningIdx === null) {
              activeReasoningIdx = nextBlockIndex++;
              activeReasoningText = "";
              queue.push({
                type: "block-start",
                index: activeReasoningIdx,
                blockType: "reasoning",
              });
            }
            activeReasoningText += evt.text;
            queue.push({
              type: "reasoning-delta",
              index: activeReasoningIdx,
              text: evt.text,
            });
            return;
          }
          if (evt.type === "text") {
            ensureTextOpen();
            activeText += evt.text;
            queue.push({
              type: "text-delta",
              index: activeTextIdx,
              text: evt.text,
            });
            return;
          }
          if (evt.type === "tool" && this.showToolActivity) {
            const label = evt.status ? `${evt.title} (${evt.status})` : evt.title;
            const note = `\n[agy tool: ${label}]\n`;
            ensureTextOpen();
            activeText += note;
            queue.push({
              type: "text-delta",
              index: activeTextIdx,
              text: note,
            });
          }
        },
      })
      .then((result) => {
        closeReasoning();
        closeText();

        const usage = mapUsageToDsh(result.usage);
        if (usage) {
          queue.push({ type: "usage", usage });
        }

        if (result.stopReason === "cancelled" || options?.signal?.aborted) {
          queue.push({
            type: "finish",
            reason: {
              kind: "aborted",
              failure: { code: "ABORTED", message: "Request cancelled" },
            },
          });
        } else if (result.stopReason === "max_tokens") {
          queue.push({ type: "finish", reason: { kind: "max-tokens" } });
        } else {
          queue.push({ type: "finish", reason: { kind: "stop" } });
        }
        queue.close();
      })
      .catch((err) => {
        closeReasoning();
        closeText();
        const aborted = Boolean(options?.signal?.aborted) || /aborted|cancelled/i.test(String(err?.message || ""));
        queue.push({
          type: "finish",
          reason: aborted
            ? {
                kind: "aborted",
                failure: { code: "ABORTED", message: err?.message || "Request aborted" },
              }
            : {
                kind: "error",
                failure: mapErrorToDshFailure(err),
              },
        });
        queue.close();
      });

    try {
      for await (const chunk of queue) {
        yield chunk;
      }
    } finally {
      await turnPromise.catch(() => {});
    }
  }
}
