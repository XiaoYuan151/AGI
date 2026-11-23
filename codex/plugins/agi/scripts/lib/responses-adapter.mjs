import crypto from "node:crypto";
import { normalizeModelId } from "./agy-acp-client.mjs";

export const AGY_CODEX_PREFIX = "agy/";

export function resolveCodexAgyModelId(model, knownIds = []) {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  for (const prefix of ["agy/", "antigravity/", "anthropic-agy/"]) {
    if (lower.startsWith(prefix)) {
      const stripped = trimmed.slice(prefix.length).trim();
      return stripped || null;
    }
  }

  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("codex-")
  ) {
    return null;
  }

  const knownSet = new Set(
    (Array.isArray(knownIds) ? knownIds : []).map((id) => normalizeModelId(String(id))),
  );
  if (knownSet.has(trimmed) || lower.startsWith("gemini-")) {
    return trimmed;
  }
  return null;
}

function mapReasoningEffortObjects(efforts = ["low", "medium", "high"]) {
  const descriptions = {
    minimal: "Minimal reasoning for instant responses",
    low: "Fast responses with lighter reasoning",
    medium: "Balances speed and reasoning depth for everyday tasks",
    high: "Greater reasoning depth for complex problems",
    xhigh: "Extra high reasoning depth for complex problems",
    max: "Maximum reasoning depth for the hardest problems",
  };
  return efforts.map((e) => {
    const effort = String(e).toLowerCase();
    return {
      effort,
      description: descriptions[effort] || `Reasoning effort: ${effort}`,
    };
  });
}

export function buildCodexModelCatalog(
  agyModels = [],
  { bundledModels = [], includeBundled = false } = {},
) {
  const agyEntries = agyModels.map((m, idx) => {
    const rawId = normalizeModelId(m.id);
    const slug = `${AGY_CODEX_PREFIX}${rawId}`;
    const baseName = m.name && m.name !== rawId ? m.name : rawId;
    const displayName = baseName.startsWith("AGY") ? baseName : `AGY · ${baseName}`;
    const efforts =
      Array.isArray(m.efforts) && m.efforts.length > 0
        ? m.efforts
        : ["low", "medium", "high"];
    const defaultEffort = efforts.includes("medium") ? "medium" : efforts[0] || "medium";
    const ctxWindow = typeof m.contextWindow === "number" ? m.contextWindow : 1000000;

    return {
      slug,
      display_name: displayName,
      description: m.description
        ? m.description.endsWith(`(${rawId})`)
          ? m.description
          : `${m.description} (${rawId})`
        : `Antigravity ACP model (${rawId})`,
      default_reasoning_level: defaultEffort,
      supported_reasoning_levels: mapReasoningEffortObjects(efforts),
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: idx + 1,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      default_verbosity: "medium",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: {
        mode: "tokens",
        limit: 10000,
      },
      supports_image_detail_original: true,
      context_window: ctxWindow,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: m.supportsImages === false ? ["text"] : ["text", "image"],
      supports_search_tool: false,
      supports_experimental_context: false,
      use_responses_lite: false,
      supports_reasoning_effort_updates: true,
      base_instructions: "",
    };
  });

  if (!includeBundled || !Array.isArray(bundledModels) || bundledModels.length === 0) {
    return { models: agyEntries };
  }

  const seenSlugs = new Set(agyEntries.map((m) => m.slug));
  const shiftedBundled = bundledModels
    .filter((m) => m && typeof m.slug === "string" && !seenSlugs.has(m.slug))
    .map((m, idx) => ({
      ...m,
      priority: agyEntries.length + (typeof m.priority === "number" ? m.priority : idx + 1),
    }));

  return {
    models: [...agyEntries, ...shiftedBundled],
  };
}

export function formatOpenAiModelsList(agyModels = []) {
  return {
    object: "list",
    data: agyModels.map((m) => {
      const rawId = normalizeModelId(m.id);
      const id = `${AGY_CODEX_PREFIX}${rawId}`;
      const baseName = m.name && m.name !== rawId ? m.name : rawId;
      return {
        id,
        object: "model",
        created: 1767225600,
        owned_by: "antigravity-acp",
        display_name: baseName.startsWith("AGY") ? baseName : `AGY · ${baseName}`,
        description: m.description || `Antigravity ACP (${rawId})`,
      };
    }),
  };
}

function extractTextFromResponsesContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (
      (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function responsesItemToAcpBlocks(item) {
  const blocks = [];
  if (!item || typeof item !== "object") return blocks;

  if (item.type === "function_call_output") {
    const out =
      typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    if (out) {
      blocks.push({ type: "text", text: `[Tool result]\n${out}` });
    }
    return blocks;
  }

  if (typeof item.content === "string") {
    if (item.content) blocks.push({ type: "text", text: item.content });
    return blocks;
  }

  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (!part || typeof part !== "object") continue;
      if (
        (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string" &&
        part.text
      ) {
        blocks.push({ type: "text", text: part.text });
      } else if (part.type === "input_image" && typeof part.image_url === "string") {
        const match = part.image_url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          blocks.push({
            type: "image",
            mimeType: match[1],
            data: match[2],
          });
        } else {
          blocks.push({ type: "text", text: `[Image URL: ${part.image_url}]` });
        }
      }
    }
  }
  return blocks;
}

function itemRole(item) {
  if (!item || typeof item !== "object") return "user";
  if (item.type === "reasoning" || item.type === "function_call") return "assistant";
  if (item.type === "function_call_output") return "user";
  return item.role || "user";
}

function itemSummaryText(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type === "function_call") {
    return `[Tool call: ${item.name || "tool"}(${item.arguments || "{}"})]`;
  }
  if (item.type === "function_call_output") {
    const out =
      typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    return `[Tool result: ${out}]`;
  }
  if (item.type === "reasoning") {
    return "";
  }
  return extractTextFromResponsesContent(item.content);
}

export function isAuxiliaryResponsesRequest(body) {
  if (!body || typeof body !== "object") return false;
  const inst = String(body.instructions || "").toLowerCase();
  if (
    /generate a concise title|short title|summarize this thread|thread title/i.test(inst)
  ) {
    return true;
  }
  if (
    typeof body.max_output_tokens === "number" &&
    body.max_output_tokens <= 128 &&
    (!Array.isArray(body.tools) || body.tools.length === 0) &&
    inst.length > 0
  ) {
    return true;
  }
  return false;
}

export function deriveCodexConversationKey(body, headers = {}, responseSessionMap = null) {
  if (
    typeof body?.previous_response_id === "string" &&
    responseSessionMap &&
    responseSessionMap.has(body.previous_response_id)
  ) {
    return responseSessionMap.get(body.previous_response_id);
  }

  if (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key.trim()) {
    return `codex:${body.prompt_cache_key.trim()}`;
  }

  const headerSession = headers["session_id"] || headers["x-codex-session-id"];
  if (typeof headerSession === "string" && headerSession.trim()) {
    return `codex:${headerSession.trim()}`;
  }

  const inputItems = Array.isArray(body?.input)
    ? body.input
    : typeof body?.input === "string"
      ? [{ role: "user", content: body.input }]
      : [];
  const firstUser = inputItems.find((it) => itemRole(it) === "user");
  const seed = firstUser ? itemSummaryText(firstUser) : "";
  const hash = crypto
    .createHash("sha256")
    .update(`${String(body?.instructions || "").slice(0, 200)}\n${seed}`)
    .digest("hex")
    .slice(0, 20);
  return `codex:${hash}`;
}

export function buildPromptFromResponsesRequest(
  body,
  { existingTurnCount = 0, auxiliary = false } = {},
) {
  const input = body?.input;
  const items = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? [{ type: "message", role: "user", content: input }]
      : [];

  if (existingTurnCount > 0 && !auxiliary) {
    let lastAssistantIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (itemRole(items[i]) === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    const tail = items.slice(lastAssistantIdx + 1);
    const blocks = [];
    for (const item of tail) {
      if (itemRole(item) === "developer" || itemRole(item) === "system") continue;
      blocks.push(...responsesItemToAcpBlocks(item));
    }
    if (blocks.length > 0) return blocks;
  }

  const blocks = [];
  if (auxiliary && typeof body?.instructions === "string" && body.instructions.trim()) {
    blocks.push({
      type: "text",
      text: `[System instructions]\n${body.instructions.trim()}`,
    });
  }

  const nonSystem = items.filter(
    (it) => itemRole(it) !== "developer" && itemRole(it) !== "system",
  );
  if (nonSystem.length <= 1) {
    if (nonSystem[0]) {
      blocks.push(...responsesItemToAcpBlocks(nonSystem[0]));
    }
  } else {
    let lastUserIdx = nonSystem.length - 1;
    while (lastUserIdx > 0 && itemRole(nonSystem[lastUserIdx]) !== "user") {
      lastUserIdx--;
    }
    const prior = nonSystem.slice(0, lastUserIdx);
    const priorLines = prior
      .map((it) => {
        const text = itemSummaryText(it).trim();
        if (!text) return "";
        const role = itemRole(it) === "assistant" ? "Assistant" : "User";
        return `${role}: ${text}`;
      })
      .filter(Boolean);

    if (priorLines.length > 0) {
      blocks.push({
        type: "text",
        text: `[Prior conversation context]\n${priorLines.join("\n\n")}\n\n[Current user message]`,
      });
    }
    if (nonSystem[lastUserIdx]) {
      blocks.push(...responsesItemToAcpBlocks(nonSystem[lastUserIdx]));
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

export function extractCodexEffort(body) {
  const effort = body?.reasoning?.effort;
  if (typeof effort === "string" && effort.trim()) {
    return effort.trim().toLowerCase();
  }
  return undefined;
}

export function extractCodexCwdHint(body, defaultCwd) {
  const sources = [String(body?.instructions || "")];
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      const role = itemRole(item);
      if (role === "developer" || role === "user" || role === "system") {
        const txt = itemSummaryText(item);
        if (txt.includes("<cwd>") || txt.includes("Working directory")) {
          sources.push(txt);
        }
      }
    }
  }
  for (const src of sources) {
    const xmlMatch = src.match(/<cwd>([^<]+)<\/cwd>/i);
    if (xmlMatch?.[1]?.trim().startsWith("/")) return xmlMatch[1].trim();
    const lineMatch = src.match(/Working directory:\s*([^\n\r]+)/i);
    if (lineMatch?.[1]?.trim().startsWith("/")) return lineMatch[1].trim();
  }
  return defaultCwd;
}

function estimateResponsesInputTokens(body) {
  const instLen = typeof body?.instructions === "string" ? body.instructions.length : 0;
  const inputLen =
    typeof body?.input === "string"
      ? body.input.length
      : Array.isArray(body?.input)
        ? body.input.map((it) => itemSummaryText(it)).join("\n").length
        : 0;
  return Math.max(1, Math.ceil((instLen + inputLen) / 4));
}

function buildResponsesUsage(usage, inputEstimate, outputText, thoughtText) {
  const inputTokens =
    typeof usage?.inputTokens === "number"
      ? usage.inputTokens
      : typeof usage?.promptTokens === "number"
        ? usage.promptTokens
        : inputEstimate;
  const reasoningTokens = thoughtText ? Math.max(1, Math.ceil(thoughtText.length / 4)) : 0;
  const textTokens = outputText ? Math.max(1, Math.ceil(outputText.length / 4)) : 0;
  const outputTokens =
    typeof usage?.outputTokens === "number"
      ? usage.outputTokens
      : typeof usage?.completionTokens === "number"
        ? usage.completionTokens
        : Math.max(1, textTokens + reasoningTokens);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: inputTokens + outputTokens,
  };
}

export function sendOpenAiError(res, status, code, message, type = "api_error") {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        message,
        type,
        code,
      },
    }),
  );
}

function writeResponsesEvent(res, seqRef, eventType, payload) {
  const data = {
    type: eventType,
    sequence_number: seqRef.value++,
    ...payload,
  };
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

function rememberResponseSession(responseSessionMap, responseId, conversationKey) {
  if (!responseSessionMap || !conversationKey) return;
  responseSessionMap.set(responseId, conversationKey);
  while (responseSessionMap.size > 256) {
    const oldest = responseSessionMap.keys().next().value;
    if (!oldest) break;
    responseSessionMap.delete(oldest);
  }
}

export async function streamResponsesSse(
  req,
  res,
  reqBody,
  resolvedModelId,
  acpClient,
  options = {},
) {
  const responseSessionMap = options.responseSessionMap || null;
  const auxiliary = isAuxiliaryResponsesRequest(reqBody);
  const conversationKey = auxiliary
    ? undefined
    : deriveCodexConversationKey(reqBody, req.headers, responseSessionMap);
  const existingTurnCount = conversationKey
    ? acpClient.getCachedTurnCount(conversationKey)
    : 0;
  const promptBlocks = buildPromptFromResponsesRequest(reqBody, {
    existingTurnCount,
    auxiliary,
  });
  const effort = extractCodexEffort(reqBody);
  const cwd = extractCodexCwdHint(reqBody, options.defaultCwd || process.cwd());
  const inputEstimate = estimateResponsesInputTokens(reqBody);

  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on("close", onClose);

  const responseId = `resp_agy_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const reasoningItemId = `rs_agy_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const msgItemId = `msg_agy_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const modelName = reqBody.model || `${AGY_CODEX_PREFIX}${resolvedModelId}`;

  const baseResponse = (status, output = [], usage = null) => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    model: modelName,
    output,
    usage,
  });

  const seqRef = { value: 0 };
  let headersSent = false;
  let nextOutputIdx = 0;
  let reasoningIdx = null;
  let reasoningClosed = false;
  let reasoningAccum = "";
  let msgIdx = null;
  let msgClosed = false;
  let msgAccum = "";

  const ensureHeadersAndStart = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Agy-Model": resolvedModelId,
    });
    writeResponsesEvent(res, seqRef, "response.created", {
      response: baseResponse("in_progress"),
    });
    writeResponsesEvent(res, seqRef, "response.in_progress", {
      response: baseResponse("in_progress"),
    });
  };

  const ensureReasoningItem = () => {
    ensureHeadersAndStart();
    if (reasoningIdx === null) {
      reasoningIdx = nextOutputIdx++;
      writeResponsesEvent(res, seqRef, "response.output_item.added", {
        output_index: reasoningIdx,
        item: {
          id: reasoningItemId,
          type: "reasoning",
          status: "in_progress",
          summary: [],
        },
      });
      writeResponsesEvent(res, seqRef, "response.reasoning_summary_part.added", {
        item_id: reasoningItemId,
        output_index: reasoningIdx,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
  };

  const closeReasoningItem = () => {
    if (reasoningIdx !== null && !reasoningClosed) {
      reasoningClosed = true;
      writeResponsesEvent(res, seqRef, "response.reasoning_summary_text.done", {
        item_id: reasoningItemId,
        output_index: reasoningIdx,
        summary_index: 0,
        text: reasoningAccum,
      });
      writeResponsesEvent(res, seqRef, "response.reasoning_summary_part.done", {
        item_id: reasoningItemId,
        output_index: reasoningIdx,
        summary_index: 0,
        part: { type: "summary_text", text: reasoningAccum },
      });
      writeResponsesEvent(res, seqRef, "response.output_item.done", {
        output_index: reasoningIdx,
        item: {
          id: reasoningItemId,
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: reasoningAccum }],
        },
      });
    }
  };

  const ensureMessageItem = () => {
    ensureHeadersAndStart();
    closeReasoningItem();
    if (msgIdx === null) {
      msgIdx = nextOutputIdx++;
      writeResponsesEvent(res, seqRef, "response.output_item.added", {
        output_index: msgIdx,
        item: {
          id: msgItemId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      });
      writeResponsesEvent(res, seqRef, "response.content_part.added", {
        item_id: msgItemId,
        output_index: msgIdx,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
  };

  const closeMessageItem = () => {
    if (msgIdx !== null && !msgClosed) {
      msgClosed = true;
      writeResponsesEvent(res, seqRef, "response.output_text.done", {
        item_id: msgItemId,
        output_index: msgIdx,
        content_index: 0,
        text: msgAccum,
      });
      writeResponsesEvent(res, seqRef, "response.content_part.done", {
        item_id: msgItemId,
        output_index: msgIdx,
        content_index: 0,
        part: { type: "output_text", text: msgAccum, annotations: [] },
      });
      writeResponsesEvent(res, seqRef, "response.output_item.done", {
        output_index: msgIdx,
        item: {
          id: msgItemId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: msgAccum, annotations: [] }],
        },
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
          if (msgIdx !== null) return;
          ensureReasoningItem();
          reasoningAccum += evt.text;
          writeResponsesEvent(res, seqRef, "response.reasoning_summary_text.delta", {
            item_id: reasoningItemId,
            output_index: reasoningIdx,
            summary_index: 0,
            delta: evt.text,
          });
        } else if (evt.type === "tool" && options.showToolActivity !== false) {
          if (msgIdx === null) {
            ensureReasoningItem();
            const line = `[agy tool: ${evt.title}${evt.status ? ` (${evt.status})` : ""}]\n`;
            reasoningAccum += line;
            writeResponsesEvent(res, seqRef, "response.reasoning_summary_text.delta", {
              item_id: reasoningItemId,
              output_index: reasoningIdx,
              summary_index: 0,
              delta: line,
            });
          }
        } else if (evt.type === "text" && evt.text) {
          ensureMessageItem();
          msgAccum += evt.text;
          writeResponsesEvent(res, seqRef, "response.output_text.delta", {
            item_id: msgItemId,
            output_index: msgIdx,
            content_index: 0,
            delta: evt.text,
          });
        }
      },
    });

    ensureHeadersAndStart();
    closeReasoningItem();
    if (msgIdx === null) {
      ensureMessageItem();
    }
    closeMessageItem();

    const output = [];
    if (reasoningIdx !== null) {
      output.push({
        id: reasoningItemId,
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: reasoningAccum }],
      });
    }
    output.push({
      id: msgItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: msgAccum, annotations: [] }],
    });

    const usage = buildResponsesUsage(
      result.usage,
      inputEstimate,
      result.text || msgAccum,
      result.thoughts || reasoningAccum,
    );

    if (!auxiliary) {
      rememberResponseSession(responseSessionMap, responseId, conversationKey);
    }

    writeResponsesEvent(res, seqRef, "response.completed", {
      response: baseResponse("completed", output, usage),
    });
    res.end();
  } catch (err) {
    const status = err?.code === -32000 ? 401 : 502;
    const code = err?.code === -32000 ? "authentication_required" : "acp_error";
    const type = err?.code === -32000 ? "authentication_error" : "api_error";
    if (!headersSent) {
      sendOpenAiError(res, status, code, err.message || "Antigravity ACP error", type);
    } else if (!res.writableEnded) {
      writeResponsesEvent(res, seqRef, "response.failed", {
        response: {
          ...baseResponse("failed"),
          error: { code, message: err.message || "Antigravity ACP error" },
        },
      });
      res.end();
    }
  } finally {
    res.off("close", onClose);
  }
}

export async function handleResponsesJson(
  req,
  res,
  reqBody,
  resolvedModelId,
  acpClient,
  options = {},
) {
  const responseSessionMap = options.responseSessionMap || null;
  const auxiliary = isAuxiliaryResponsesRequest(reqBody);
  const conversationKey = auxiliary
    ? undefined
    : deriveCodexConversationKey(reqBody, req.headers, responseSessionMap);
  const existingTurnCount = conversationKey
    ? acpClient.getCachedTurnCount(conversationKey)
    : 0;
  const promptBlocks = buildPromptFromResponsesRequest(reqBody, {
    existingTurnCount,
    auxiliary,
  });
  const effort = extractCodexEffort(reqBody);
  const cwd = extractCodexCwdHint(reqBody, options.defaultCwd || process.cwd());
  const inputEstimate = estimateResponsesInputTokens(reqBody);

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

    const responseId = `resp_agy_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const output = [];
    if (result.thoughts) {
      output.push({
        id: `rs_agy_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: result.thoughts }],
      });
    }
    output.push({
      id: `msg_agy_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: result.text || "", annotations: [] }],
    });

    if (!auxiliary) {
      rememberResponseSession(responseSessionMap, responseId, conversationKey);
    }

    const usage = buildResponsesUsage(
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
        id: responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: reqBody.model || `${AGY_CODEX_PREFIX}${resolvedModelId}`,
        output,
        output_text: result.text || "",
        usage,
      }),
    );
  } catch (err) {
    const status = err?.code === -32000 ? 401 : 502;
    const code = err?.code === -32000 ? "authentication_required" : "acp_error";
    const type = err?.code === -32000 ? "authentication_error" : "api_error";
    sendOpenAiError(res, status, code, err.message || "Antigravity ACP error", type);
  } finally {
    res.off("close", onClose);
  }
}

export async function proxyToUpstreamOpenAi(
  req,
  res,
  rawBody,
  upstreamUrl = "https://api.openai.com",
) {
  const base = upstreamUrl.replace(/\/+$/, "");
  const reqPath = req.url?.startsWith("/v1/") ? req.url : `/v1${req.url}`;
  const targetUrl = base.endsWith("/v1") && req.url?.startsWith("/v1")
    ? `${base.slice(0, -3)}${req.url}`
    : `${base}${reqPath}`;

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

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : rawBody,
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
    sendOpenAiError(
      res,
      502,
      "upstream_error",
      `Upstream OpenAI proxy failed: ${err.message}`,
    );
  }
}
