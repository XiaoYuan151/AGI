import crypto from "node:crypto";
import type { AgyAcpClient, AgyPromptBlock } from "./acp-client.js";

export interface V3TextPart {
  type: "text";
  text: string;
}

export interface V3ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface V3FilePart {
  type: "file";
  filename?: string;
  data: Uint8Array | string | URL;
  mediaType: string;
}

export interface V3ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface V3ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output?: unknown;
}

export type V3PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<V3TextPart | V3FilePart> }
  | {
      role: "assistant";
      content: Array<
        V3TextPart | V3FilePart | V3ReasoningPart | V3ToolCallPart | V3ToolResultPart
      >;
    }
  | { role: "tool"; content: Array<V3ToolResultPart | Record<string, unknown>> };

export interface V3CallOptions {
  prompt: V3PromptMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface V3Usage {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
}

export interface V3FinishReason {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  raw: string | undefined;
}

export type V3StreamPart =
  | { type: "stream-start"; warnings: unknown[] }
  | { type: "response-metadata"; id?: string; timestamp?: Date; modelId?: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "finish"; usage: V3Usage; finishReason: V3FinishReason }
  | { type: "error"; error: unknown };

export interface AgyLanguageModel {
  readonly specificationVersion: "v3";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]>;
  doGenerate(options: V3CallOptions): Promise<{
    content: Array<V3TextPart | V3ReasoningPart>;
    finishReason: V3FinishReason;
    usage: V3Usage;
    warnings: unknown[];
  }>;
  doStream(options: V3CallOptions): Promise<{
    stream: ReadableStream<V3StreamPart>;
  }>;
}

function summarizeMessageText(msg: V3PromptMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  const parts: string[] = [];
  for (const part of msg.content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(p.text);
    } else if (p.type === "tool-call") {
      parts.push(`[Tool call: ${String(p.toolName || "tool")}(${JSON.stringify(p.input ?? {})})]`);
    } else if (p.type === "tool-result") {
      parts.push(`[Tool result (${String(p.toolName || "tool")}): ${JSON.stringify(p.output ?? "")}]`);
    }
  }
  return parts.join("\n");
}

function fileDataToBase64(data: Uint8Array | string | URL): string | null {
  if (typeof data === "string") {
    const match = data.match(/^data:[^;]+;base64,(.+)$/);
    return match ? match[1] : data;
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString("base64");
  }
  return null;
}

function messagePartsToAcpBlocks(msg: V3PromptMessage): AgyPromptBlock[] {
  const blocks: AgyPromptBlock[] = [];
  if (typeof msg.content === "string") {
    if (msg.content) blocks.push({ type: "text", text: msg.content });
    return blocks;
  }
  if (!Array.isArray(msg.content)) return blocks;

  for (const part of msg.content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string" && p.text) {
      blocks.push({ type: "text", text: p.text });
    } else if (p.type === "file" && typeof p.mediaType === "string") {
      if (p.mediaType.startsWith("image/")) {
        const b64 = fileDataToBase64(p.data as Uint8Array | string | URL);
        if (b64) {
          blocks.push({ type: "image", data: b64, mimeType: p.mediaType });
          continue;
        }
      }
      blocks.push({
        type: "text",
        text: `[Attached file: ${String(p.filename || p.mediaType)}]`,
      });
    } else if (p.type === "tool-result") {
      blocks.push({
        type: "text",
        text: `[Tool result (${String(p.toolName || "tool")})]\n${JSON.stringify(p.output ?? "")}`,
      });
    }
  }
  return blocks;
}

function deriveConversationKey(
  providerID: string,
  options: V3CallOptions,
): string {
  const meta = options.providerOptions?.[providerID];
  if (meta && typeof meta.sessionID === "string" && meta.sessionID.trim()) {
    return `opencode:${meta.sessionID.trim()}`;
  }
  const firstUser = (options.prompt || []).find((m) => m.role === "user");
  const seed = firstUser ? summarizeMessageText(firstUser) : "";
  const hash = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 20);
  return `opencode:${hash}`;
}

export function buildAcpPromptFromV3(
  prompt: V3PromptMessage[],
  { existingTurnCount = 0, auxiliary = false }: { existingTurnCount?: number; auxiliary?: boolean } = {},
): AgyPromptBlock[] {
  const messages = Array.isArray(prompt) ? prompt : [];
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n\n");

  const nonSystem = messages.filter((m) => m.role !== "system");

  if (existingTurnCount > 0 && !auxiliary) {
    let lastAssistantIdx = -1;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      if (nonSystem[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    const tail = nonSystem.slice(lastAssistantIdx + 1);
    const blocks: AgyPromptBlock[] = [];
    for (const msg of tail) {
      blocks.push(...messagePartsToAcpBlocks(msg));
    }
    if (blocks.length > 0) return blocks;
  }

  const blocks: AgyPromptBlock[] = [];
  if (auxiliary && systemText) {
    blocks.push({ type: "text", text: `[System instructions]\n${systemText}` });
  }

  if (nonSystem.length <= 1) {
    if (nonSystem[0]) {
      blocks.push(...messagePartsToAcpBlocks(nonSystem[0]));
    }
  } else {
    let lastUserIdx = nonSystem.length - 1;
    while (lastUserIdx > 0 && nonSystem[lastUserIdx].role === "assistant") {
      lastUserIdx--;
    }
    const prior = nonSystem.slice(0, lastUserIdx);
    const priorLines = prior
      .map((m) => {
        const text = summarizeMessageText(m).trim();
        if (!text) return "";
        const label = m.role === "assistant" ? "Assistant" : "User";
        return `${label}: ${text}`;
      })
      .filter(Boolean);

    if (priorLines.length > 0) {
      blocks.push({
        type: "text",
        text: `[Prior conversation context]\n${priorLines.join("\n\n")}\n\n[Current user message]`,
      });
    }
    for (const msg of nonSystem.slice(lastUserIdx)) {
      if (msg.role !== "assistant") {
        blocks.push(...messagePartsToAcpBlocks(msg));
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

function estimatePromptTokens(prompt: V3PromptMessage[]): number {
  const chars = (prompt || []).map(summarizeMessageText).join("\n").length;
  return Math.max(1, Math.ceil(chars / 4));
}

function mapFinishReason(stopReason: string): V3FinishReason {
  if (stopReason === "max_tokens") return { unified: "length", raw: stopReason };
  if (stopReason === "refusal") return { unified: "content-filter", raw: stopReason };
  if (stopReason === "cancelled") return { unified: "other", raw: stopReason };
  return { unified: "stop", raw: stopReason || "end_turn" };
}

function toV3Usage(
  usage: Record<string, unknown> | null,
  inputEstimate: number,
  text: string,
  thoughts: string,
): V3Usage {
  const inputTotal =
    typeof usage?.inputTokens === "number"
      ? usage.inputTokens
      : typeof usage?.promptTokens === "number"
        ? usage.promptTokens
        : inputEstimate;
  const textTokens = text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
  const reasoningTokens = thoughts ? Math.max(1, Math.ceil(thoughts.length / 4)) : 0;
  const outputTotal =
    typeof usage?.outputTokens === "number"
      ? usage.outputTokens
      : typeof usage?.completionTokens === "number"
        ? usage.completionTokens
        : Math.max(1, textTokens + reasoningTokens);

  return {
    inputTokens: {
      total: inputTotal,
      noCache: inputTotal,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: outputTotal,
      text: textTokens,
      reasoning: reasoningTokens,
    },
  };
}

export function createAgyLanguageModel({
  providerID,
  modelId,
  client,
  cwd,
  showToolActivity = true,
}: {
  providerID: string;
  modelId: string;
  client: AgyAcpClient;
  cwd: string;
  showToolActivity?: boolean;
}): AgyLanguageModel {
  function resolveCallMeta(options: V3CallOptions) {
    const providerMeta = options.providerOptions?.[providerID] || {};
    const kind = typeof providerMeta.kind === "string" ? providerMeta.kind : "primary";
    const auxiliary = kind !== "primary";
    const effortRaw = providerMeta.variant ?? providerMeta.reasoningEffort ?? providerMeta.effort;
    const effort = typeof effortRaw === "string" && effortRaw.trim() ? effortRaw.trim() : undefined;
    const callCwd =
      typeof providerMeta.cwd === "string" && providerMeta.cwd.trim()
        ? providerMeta.cwd.trim()
        : cwd;
    const conversationKey = auxiliary
      ? undefined
      : deriveConversationKey(providerID, options);
    const existingTurnCount = conversationKey
      ? client.getCachedTurnCount(conversationKey)
      : 0;
    const promptBlocks = buildAcpPromptFromV3(options.prompt, {
      existingTurnCount,
      auxiliary,
    });
    const inputEstimate = estimatePromptTokens(options.prompt);
    return {
      auxiliary,
      effort,
      callCwd,
      conversationKey,
      promptBlocks,
      inputEstimate,
    };
  }

  return {
    specificationVersion: "v3",
    provider: providerID,
    modelId,
    supportedUrls: {},

    async doGenerate(options: V3CallOptions) {
      const meta = resolveCallMeta(options);
      const result = await client.promptTurn({
        conversationKey: meta.conversationKey,
        cwd: meta.callCwd,
        modelId,
        effort: meta.effort,
        promptBlocks: meta.promptBlocks,
        auxiliary: meta.auxiliary,
        signal: options.abortSignal,
      });

      const content: Array<V3TextPart | V3ReasoningPart> = [];
      if (result.thoughts) {
        content.push({ type: "reasoning", text: result.thoughts });
      }
      content.push({ type: "text", text: result.text || "" });

      return {
        content,
        finishReason: mapFinishReason(result.stopReason),
        usage: toV3Usage(
          result.usage,
          meta.inputEstimate,
          result.text || "",
          result.thoughts || "",
        ),
        warnings: [],
      };
    },

    async doStream(options: V3CallOptions) {
      const meta = resolveCallMeta(options);
      const reasoningId = `reasoning_${crypto.randomUUID().slice(0, 8)}`;
      const textId = `text_${crypto.randomUUID().slice(0, 8)}`;
      const streamAc = new AbortController();
      const forwardAbort = () => streamAc.abort();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          streamAc.abort();
        } else {
          options.abortSignal.addEventListener("abort", forwardAbort, { once: true });
        }
      }

      const stream = new ReadableStream<V3StreamPart>({
        start(controller) {
          let reasoningStarted = false;
          let reasoningEnded = false;
          let textStarted = false;
          let closed = false;

          const enqueue = (part: V3StreamPart) => {
            if (!closed) controller.enqueue(part);
          };

          const endReasoning = () => {
            if (reasoningStarted && !reasoningEnded) {
              reasoningEnded = true;
              enqueue({ type: "reasoning-end", id: reasoningId });
            }
          };

          enqueue({ type: "stream-start", warnings: [] });
          enqueue({
            type: "response-metadata",
            id: `resp_${crypto.randomUUID().slice(0, 12)}`,
            timestamp: new Date(),
            modelId,
          });

          void client
            .promptTurn({
              conversationKey: meta.conversationKey,
              cwd: meta.callCwd,
              modelId,
              effort: meta.effort,
              promptBlocks: meta.promptBlocks,
              auxiliary: meta.auxiliary,
              signal: streamAc.signal,
              onEvent(evt) {
                if (evt.type === "thought" && evt.text) {
                  if (textStarted) return;
                  if (!reasoningStarted) {
                    reasoningStarted = true;
                    enqueue({ type: "reasoning-start", id: reasoningId });
                  }
                  enqueue({ type: "reasoning-delta", id: reasoningId, delta: evt.text });
                } else if (evt.type === "tool" && showToolActivity) {
                  if (!textStarted) {
                    if (!reasoningStarted) {
                      reasoningStarted = true;
                      enqueue({ type: "reasoning-start", id: reasoningId });
                    }
                    enqueue({
                      type: "reasoning-delta",
                      id: reasoningId,
                      delta: `[agy tool: ${evt.title}${evt.status ? ` (${evt.status})` : ""}]\n`,
                    });
                  }
                } else if (evt.type === "text" && evt.text) {
                  endReasoning();
                  if (!textStarted) {
                    textStarted = true;
                    enqueue({ type: "text-start", id: textId });
                  }
                  enqueue({ type: "text-delta", id: textId, delta: evt.text });
                }
              },
            })
            .then((result) => {
              endReasoning();
              if (!textStarted) {
                textStarted = true;
                enqueue({ type: "text-start", id: textId });
                if (result.text) {
                  enqueue({ type: "text-delta", id: textId, delta: result.text });
                }
              }
              enqueue({ type: "text-end", id: textId });
              enqueue({
                type: "finish",
                finishReason: mapFinishReason(result.stopReason),
                usage: toV3Usage(
                  result.usage,
                  meta.inputEstimate,
                  result.text || "",
                  result.thoughts || "",
                ),
              });
              closed = true;
              controller.close();
            })
            .catch((err) => {
              endReasoning();
              if (textStarted) {
                enqueue({ type: "text-end", id: textId });
              }
              enqueue({ type: "error", error: err });
              closed = true;
              controller.close();
            })
            .finally(() => {
              options.abortSignal?.removeEventListener("abort", forwardAbort);
            });
        },
        cancel() {
          streamAc.abort();
        },
      });

      return { stream };
    },
  };
}
