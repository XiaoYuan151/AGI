import crypto from "node:crypto";
import { normalizeModelId } from "./agy-acp-client.mjs";

export const AGY_MODEL_PREFIX = "anthropic-agy/";
export const LOCAL_PLACEHOLDER_TOKEN = "agy-acp-local";

export function resolveAgyModelId(model, knownIds = []) {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  for (const prefix of ["anthropic-agy/", "antigravity/", "agy/"]) {
    if (lower.startsWith(prefix)) {
      const stripped = trimmed.slice(prefix.length).trim();
      return stripped || null;
    }
  }

  if (lower.startsWith("claude-")) {
    return null;
  }

  const knownSet = new Set(
    (Array.isArray(knownIds) ? knownIds : []).map((id) => normalizeModelId(String(id))),
  );
  if (knownSet.has(trimmed)) {
    return trimmed;
  }

  if (lower.startsWith("gemini-")) {
    return trimmed;
  }

  return null;
}

export function formatAnthropicModelsList(models = []) {
  const data = models.map((m) => {
    const rawId = normalizeModelId(m.id);
    const id = `${AGY_MODEL_PREFIX}${rawId}`;
    const displayBase = m.name && m.name !== rawId ? m.name : rawId;
    const displayName = displayBase.startsWith("AGY")
      ? displayBase
      : `AGY · ${displayBase}`;
    const description = m.description
      ? `${m.description} (${rawId})`
      : `Antigravity ACP (${rawId})`;
    return {
      id,
      display_name: displayName,
      description,
      type: "model",
      created_at: "2026-01-01T00:00:00Z",
    };
  });

  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

function extractTextFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      // omit internal thinking from history replay
    } else if (block.type === "tool_use") {
      parts.push(`[Tool call: ${block.name || "tool"}(${JSON.stringify(block.input ?? {})})]`);
    } else if (block.type === "tool_result") {
      const inner = extractTextFromAnthropicContent(block.content);
      if (inner) parts.push(`[Tool result: ${inner}]`);
    }
  }
  return parts.join("\n");
}

function extractSystemText(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && item.type === "text" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function isAuxiliaryAnthropicRequest(body) {
  if (!body || typeof body !== "object") return false;
  const sysText = extractSystemText(body.system).toLowerCase();
  if (
    /write a (?:5-10 word |short )?title|summarize this coding session|new conversation topic|extract any file paths|quota-?free|command suggestion|classify whether/i.test(
      sysText,
    )
  ) {
    return true;
  }
  if (
    typeof body.max_tokens === "number" &&
    body.max_tokens <= 128 &&
    (!Array.isArray(body.tools) || body.tools.length === 0) &&
    Array.isArray(body.messages) &&
    body.messages.length === 1 &&
    sysText.length > 0
  ) {
    return true;
  }
  return false;
}

export function extractAnthropicEffort(body) {
  const explicit = body?.output_config?.effort;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim().toLowerCase();
  }
  const thinking = body?.thinking;
  if (thinking && typeof thinking === "object") {
    if (thinking.type === "disabled") return "low";
    if (typeof thinking.budget_tokens === "number") {
      if (thinking.budget_tokens <= 2048) return "low";
      if (thinking.budget_tokens <= 8192) return "medium";
      return "high";
    }
    if (thinking.type === "enabled" || thinking.type === "adaptive") {
      return "high";
    }
  }
  return undefined;
}

export function extractWorkingDirectoryHint(body, defaultCwd) {
  const sysText = extractSystemText(body?.system);
  const match = sysText.match(/(?:Primary working directory|Working directory):\s*([^\n\r]+)/i);
  if (match && match[1]) {
    const candidate = match[1].trim();
    if (candidate.startsWith("/")) return candidate;
  }
  return defaultCwd;
}

export function deriveAnthropicConversationKey(body, headers = {}) {
  const headerId =
    headers["x-claude-session-id"] ||
    headers["x-session-id"] ||
    headers["x-conversation-id"];
  if (typeof headerId === "string" && headerId.trim()) {
    return `claude:${headerId.trim()}`;
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const firstUser = messages.find((m) => m && m.role === "user");
  const seed = firstUser ? extractTextFromAnthropicContent(firstUser.content) : "";
  const userTag = typeof body?.metadata?.user_id === "string" ? body.metadata.user_id : "";
  const hash = crypto
    .createHash("sha256")
    .update(`${userTag}\n${seed}`)
    .digest("hex")
    .slice(0, 20);
  return `claude:${hash}`;
}

function contentToAcpBlocks(content) {
  const blocks = [];
  if (typeof content === "string") {
    if (content) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (
      part.type === "image" &&
      part.source?.type === "base64" &&
      typeof part.source.data === "string"
    ) {
      blocks.push({
        type: "image",
        data: part.source.data,
        mimeType: part.source.media_type || "image/png",
      });
    } else if (part.type === "tool_result") {
      const text = extractTextFromAnthropicContent(part.content);
      if (text) {
        blocks.push({ type: "text", text: `[Tool result]\n${text}` });
      }
    }
  }
  return blocks;
}

export function buildPromptFromAnthropicRequest(
  body,
  { existingTurnCount = 0, auxiliary = false } = {},
) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const sysText = extractSystemText(body?.system);

  if (existingTurnCount > 0 && !auxiliary) {
    // Continuing an existing ACP session: send only the trailing user turn(s) since the last assistant reply.
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    const tail = messages.slice(lastAssistantIdx + 1);
    const blocks = [];
    for (const msg of tail) {
      blocks.push(...contentToAcpBlocks(msg?.content));
    }
    if (blocks.length > 0) return blocks;
  }

  // New ACP session (fresh conversation, auxiliary request, or mid-conversation switch)
  const blocks = [];
  if (auxiliary && sysText) {
    blocks.push({ type: "text", text: `[System instructions]\n${sysText}` });
  }

  if (messages.length <= 1) {
    if (messages[0]) {
      blocks.push(...contentToAcpBlocks(messages[0].content));
    }
  } else {
    let lastUserIdx = messages.length - 1;
    while (lastUserIdx > 0 && messages[lastUserIdx]?.role !== "user") {
      lastUserIdx--;
    }
    const prior = messages.slice(0, lastUserIdx);
    const priorLines = prior
      .map((m) => {
        const text = extractTextFromAnthropicContent(m?.content).trim();
        if (!text) return "";
        const role = m.role === "assistant" ? "Assistant" : "User";
        return `${role}: ${text}`;
      })
      .filter(Boolean);

    if (priorLines.length > 0) {
      blocks.push({
        type: "text",
        text: `[Prior conversation context]\n${priorLines.join("\n\n")}\n\n[Current user message]`,
      });
    }
    if (messages[lastUserIdx]) {
      blocks.push(...contentToAcpBlocks(messages[lastUserIdx].content));
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

export function estimateAnthropicTokens(body) {
  const sys = extractSystemText(body?.system);
  const msgs = Array.isArray(body?.messages)
    ? body.messages.map((m) => extractTextFromAnthropicContent(m?.content)).join("\n")
    : "";
  const totalChars = sys.length + msgs.length;
  return Math.max(1, Math.ceil(totalChars / 4));
}

function mapStopReason(acpStopReason) {
  if (acpStopReason === "max_tokens") return "max_tokens";
  if (acpStopReason === "refusal") return "refusal";
  return "end_turn";
}

function writeSseEvent(res, eventName, data) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function extractUsageTokens(usage, inputEstimate, outputText, thoughtText) {
  const inputTokens =
    typeof usage?.inputTokens === "number"
      ? usage.inputTokens
      : typeof usage?.promptTokens === "number"
        ? usage.promptTokens
        : inputEstimate;
  const outputTokens =
    typeof usage?.outputTokens === "number"
      ? usage.outputTokens
      : typeof usage?.completionTokens === "number"
        ? usage.completionTokens
        : Math.max(1, Math.ceil((outputText.length + thoughtText.length) / 4));
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

export function sendAnthropicError(res, status, type, message) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: {
        type,
        message,
      },
    }),
  );
}

export async function streamAnthropicSse(
  req,
  res,
  reqBody,
  resolvedModelId,
  acpClient,
  options = {},
) {
  const auxiliary = isAuxiliaryAnthropicRequest(reqBody);
  const conversationKey = auxiliary
    ? undefined
    : deriveAnthropicConversationKey(reqBody, req.headers);
  const existingTurnCount = conversationKey
    ? acpClient.getCachedTurnCount(conversationKey)
    : 0;
  const promptBlocks = buildPromptFromAnthropicRequest(reqBody, {
    existingTurnCount,
    auxiliary,
  });
  const effort = extractAnthropicEffort(reqBody);
  const cwd = extractWorkingDirectoryHint(reqBody, options.defaultCwd || process.cwd());
  const inputEstimate = estimateAnthropicTokens(reqBody);

  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on("close", onClose);

  const msgId = `msg_agy_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let headersSent = false;
  let nextBlockIdx = 0;
  let thinkingIdx = null;
  let thinkingClosed = false;
  let textIdx = null;
  let textClosed = false;

  const ensureHeadersAndStart = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Agy-Model": resolvedModelId,
    });
    writeSseEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: reqBody.model || `anthropic-agy/${resolvedModelId}`,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputEstimate,
          output_tokens: 0,
        },
      },
    });
  };

  const ensureThinkingBlock = () => {
    ensureHeadersAndStart();
    if (thinkingIdx === null) {
      thinkingIdx = nextBlockIdx++;
      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: thinkingIdx,
        content_block: { type: "thinking", thinking: "" },
      });
    }
  };

  const closeThinkingBlock = () => {
    if (thinkingIdx !== null && !thinkingClosed) {
      thinkingClosed = true;
      writeSseEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: thinkingIdx,
      });
    }
  };

  const ensureTextBlock = () => {
    ensureHeadersAndStart();
    closeThinkingBlock();
    if (textIdx === null) {
      textIdx = nextBlockIdx++;
      writeSseEvent(res, "content_block_start", {
        type: "content_block_start",
        index: textIdx,
        content_block: { type: "text", text: "" },
      });
    }
  };

  try {
    const result = await acpClient.promptTurn({
      conversationKey,
      cwd,
      modelId: resolvedModelId,
      effort,
      promptBlocks,
      auxiliary,
      signal: ac.signal,
      onEvent(evt) {
        if (evt.type === "thought" && evt.text) {
          if (textIdx !== null) return;
          ensureThinkingBlock();
          writeSseEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: thinkingIdx,
            delta: { type: "thinking_delta", thinking: evt.text },
          });
        } else if (evt.type === "tool" && options.showToolActivity !== false) {
          if (textIdx === null) {
            ensureThinkingBlock();
            const line = `[agy tool: ${evt.title}${evt.status ? ` (${evt.status})` : ""}]\n`;
            writeSseEvent(res, "content_block_delta", {
              type: "content_block_delta",
              index: thinkingIdx,
              delta: { type: "thinking_delta", thinking: line },
            });
          }
        } else if (evt.type === "text" && evt.text) {
          ensureTextBlock();
          writeSseEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: textIdx,
            delta: { type: "text_delta", text: evt.text },
          });
        }
      },
    });

    ensureHeadersAndStart();
    closeThinkingBlock();
    if (textIdx === null) {
      ensureTextBlock();
      if (!result.text) {
        writeSseEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: textIdx,
          delta: { type: "text_delta", text: "" },
        });
      }
    }
    if (textIdx !== null && !textClosed) {
      textClosed = true;
      writeSseEvent(res, "content_block_stop", {
        type: "content_block_stop",
        index: textIdx,
      });
    }

    const usage = extractUsageTokens(
      result.usage,
      inputEstimate,
      result.text || "",
      result.thoughts || "",
    );

    writeSseEvent(res, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapStopReason(result.stopReason),
        stop_sequence: null,
      },
      usage: { output_tokens: usage.output_tokens },
    });
    writeSseEvent(res, "message_stop", { type: "message_stop" });
    res.end();
  } catch (err) {
    const status = err?.code === -32000 ? 401 : 502;
    const errorType = err?.code === -32000 ? "authentication_error" : "api_error";
    if (!headersSent) {
      sendAnthropicError(res, status, errorType, err.message || "Antigravity ACP error");
    } else if (!res.writableEnded) {
      writeSseEvent(res, "error", {
        type: "error",
        error: { type: errorType, message: err.message || "Antigravity ACP error" },
      });
      res.end();
    }
  } finally {
    res.off("close", onClose);
  }
}

export async function handleAnthropicJson(
  req,
  res,
  reqBody,
  resolvedModelId,
  acpClient,
  options = {},
) {
  const auxiliary = isAuxiliaryAnthropicRequest(reqBody);
  const conversationKey = auxiliary
    ? undefined
    : deriveAnthropicConversationKey(reqBody, req.headers);
  const existingTurnCount = conversationKey
    ? acpClient.getCachedTurnCount(conversationKey)
    : 0;
  const promptBlocks = buildPromptFromAnthropicRequest(reqBody, {
    existingTurnCount,
    auxiliary,
  });
  const effort = extractAnthropicEffort(reqBody);
  const cwd = extractWorkingDirectoryHint(reqBody, options.defaultCwd || process.cwd());
  const inputEstimate = estimateAnthropicTokens(reqBody);

  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on("close", onClose);

  try {
    const result = await acpClient.promptTurn({
      conversationKey,
      cwd,
      modelId: resolvedModelId,
      effort,
      promptBlocks,
      auxiliary,
      signal: ac.signal,
    });

    const content = [];
    if (result.thoughts) {
      content.push({ type: "thinking", thinking: result.thoughts });
    }
    content.push({ type: "text", text: result.text || "" });

    const usage = extractUsageTokens(
      result.usage,
      inputEstimate,
      result.text || "",
      result.thoughts || "",
    );

    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Agy-Model": resolvedModelId,
    });
    res.end(
      JSON.stringify({
        id: `msg_agy_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
        type: "message",
        role: "assistant",
        model: reqBody.model || `anthropic-agy/${resolvedModelId}`,
        content,
        stop_reason: mapStopReason(result.stopReason),
        stop_sequence: null,
        usage,
      }),
    );
  } catch (err) {
    const status = err?.code === -32000 ? 401 : 502;
    const errorType = err?.code === -32000 ? "authentication_error" : "api_error";
    sendAnthropicError(res, status, errorType, err.message || "Antigravity ACP error");
  } finally {
    res.off("close", onClose);
  }
}

export async function proxyToUpstreamAnthropic(
  req,
  res,
  rawBody,
  upstreamUrl = "https://api.anthropic.com",
) {
  const authHeader = String(req.headers.authorization || "");
  const xApiKey = String(req.headers["x-api-key"] || "");
  const isPlaceholder =
    xApiKey === LOCAL_PLACEHOLDER_TOKEN ||
    authHeader === `Bearer ${LOCAL_PLACEHOLDER_TOKEN}`;

  if (isPlaceholder && upstreamUrl.includes("api.anthropic.com")) {
    sendAnthropicError(
      res,
      401,
      "authentication_error",
      "Native Anthropic models require your own Anthropic credential (or claude.ai login). Select an AGY model (anthropic-agy/*) in /model, or reconfigure with '--auth-mode preserve'.",
    );
    return;
  }

  const base = upstreamUrl.replace(/\/+$/, "");
  const targetUrl = `${base}${req.url}`;
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (
      [
        "host",
        "content-length",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "accept-encoding",
      ].includes(lower)
    ) {
      continue;
    }
    if (v !== undefined) {
      forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  if (isPlaceholder) {
    if (forwardHeaders["x-api-key"] === LOCAL_PLACEHOLDER_TOKEN) {
      delete forwardHeaders["x-api-key"];
    }
    if (forwardHeaders.authorization === `Bearer ${LOCAL_PLACEHOLDER_TOKEN}`) {
      delete forwardHeaders.authorization;
    }
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : rawBody,
      redirect: "manual",
    });

    const outHeaders = {};
    upstreamRes.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lower)) {
        return;
      }
      outHeaders[key] = value;
    });
    res.writeHead(upstreamRes.status, outHeaders);
    if (!upstreamRes.body || req.method === "HEAD") {
      res.end();
      return;
    }
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) {
        res.write(Buffer.from(value));
      }
    }
    if (!res.writableEnded) {
      res.end();
    }
  } catch (err) {
    sendAnthropicError(
      res,
      502,
      "api_error",
      `Upstream Anthropic proxy failed: ${err.message}`,
    );
  }
}
