import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export function resolveAcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGY_ACP_CONFIG === "0") return "";
  if (env.AGY_ACP_CONFIG && String(env.AGY_ACP_CONFIG).trim()) {
    return path.resolve(String(env.AGY_ACP_CONFIG).trim());
  }
  const baseDir =
    env.AGI_HOME && String(env.AGI_HOME).trim()
      ? path.resolve(String(env.AGI_HOME).trim())
      : path.join(os.homedir(), ".agi");
  return path.join(baseDir, "acp.json");
}

export function readPersistedAcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const cfgPath = resolveAcpConfigPath(env);
  if (!cfgPath) return {};
  try {
    if (!fs.existsSync(cfgPath)) return {};
    const raw = fs.readFileSync(cfgPath, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function buildLoginCommandArgs(options: {
  geminiDir?: string;
  appDataDir?: string;
} = {}): string[] {
  const args = ["acp"];
  if (typeof options.geminiDir === "string" && options.geminiDir.trim()) {
    args.push("--gemini-dir", options.geminiDir.trim());
  }
  if (typeof options.appDataDir === "string" && options.appDataDir.trim()) {
    args.push("--app-data-dir", options.appDataDir.trim());
  }
  args.push("--login");
  return args;
}

export interface AgyLoginCommand {
  bin: string;
  args: string[];
  command: string;
}

export interface AgyLogoutResult {
  ok: boolean;
  supported: boolean;
  message?: string;
}

export interface AgyModelSpec {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  efforts: string[];
}

export interface AgyEffortOption {
  value: string;
  name: string;
  description: string;
}

export interface AgyEffortConfig {
  configId: string;
  currentValue?: string;
  options: AgyEffortOption[];
}

export interface AgyDiscoveryResult {
  models: AgyModelSpec[];
  source: "acp" | "fallback";
  authenticated: boolean | null;
  modelConfigId: string | null;
  currentModelId: string | null;
  effortConfig: AgyEffortConfig | null;
  agentInfo: Record<string, unknown> | null;
  authMethods: Array<Record<string, unknown>>;
  error?: string;
}

export interface AgyPromptBlock {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export type AgyTurnEvent =
  | { type: "thought"; text: string }
  | { type: "text"; text: string }
  | {
      type: "tool";
      toolCallId?: string;
      title: string;
      name: string | null;
      status: string | null;
    }
  | { type: "usage"; usage: Record<string, unknown> };

export interface AgyTurnResult {
  sessionId: string;
  isNewSession: boolean;
  model: string;
  effort: string | null;
  text: string;
  thoughts: string;
  stopReason: string;
  usage: Record<string, unknown> | null;
}

export interface AgyClientOptions {
  agyBin?: string;
  geminiDir?: string;
  appDataDir?: string;
  sandbox?: boolean;
  autoApprove?: boolean;
  authMethod?: string;
  cwd?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  usePersistedConfig?: boolean;
  fallbackModels?: AgyModelSpec[];
  rpcTimeoutMs?: number;
  discoveryTtlMs?: number;
  authCooldownMs?: number;
  policyCooldownMs?: number;
  maxSessions?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  modelConfigId: string | null;
  currentModel: string | null;
  effortConfigId: string | null;
  currentEffort: string | null;
  sentTurnCount: number;
  updatedAt: number;
}

interface ActiveTurn {
  permissionPolicy: "allow" | "reject";
  handleUpdate: (update: Record<string, unknown>) => void;
}

export const DEFAULT_FALLBACK_MODELS: readonly AgyModelSpec[] = Object.freeze([
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Antigravity ACP default reasoning and coding model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsImages: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast Antigravity ACP coding and chat model",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsImages: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    description: "Lightweight high-throughput Antigravity ACP model",
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    supportsImages: true,
    efforts: ["low", "medium"],
  },
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    description: "Balanced Antigravity ACP multimodal model",
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    supportsImages: true,
    efforts: ["low", "medium"],
  },
]);

export class AgyAuthRequiredError extends Error {
  readonly code = -32000;
  readonly authMethods: Array<Record<string, unknown>>;

  constructor(message: string, authMethods: Array<Record<string, unknown>> = []) {
    super(message);
    this.name = "AgyAuthRequiredError";
    this.authMethods = authMethods;
  }
}

export class AgyPolicyCooldownError extends Error {
  readonly code = 403;
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs = 0) {
    super(message);
    this.name = "AgyPolicyCooldownError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function normalizeModelId(rawId: unknown): string {
  if (typeof rawId !== "string") return "";
  let id = rawId.trim();
  for (const prefix of ["anthropic-agy/", "antigravity/", "agy/"]) {
    if (id.toLowerCase().startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  return id.trim();
}

export function parseFallbackModels(rawValue: unknown): AgyModelSpec[] {
  if (Array.isArray(rawValue) && rawValue.length > 0) {
    const mapped = rawValue
      .map((item): AgyModelSpec | null => {
        if (typeof item === "string") {
          const id = normalizeModelId(item);
          return id
            ? {
                id,
                name: id,
                description: "Antigravity ACP model",
                contextWindow: 1000000,
                maxOutputTokens: 65536,
                supportsImages: true,
                efforts: ["low", "medium", "high"],
              }
            : null;
        }
        if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
          const obj = item as Record<string, unknown>;
          const id = normalizeModelId(obj.id);
          if (!id) return null;
          return {
            id,
            name: typeof obj.name === "string" && obj.name ? obj.name : id,
            description:
              typeof obj.description === "string" ? obj.description : "Antigravity ACP model",
            contextWindow:
              typeof obj.contextWindow === "number" ? obj.contextWindow : 1000000,
            maxOutputTokens:
              typeof obj.maxOutputTokens === "number" ? obj.maxOutputTokens : 65536,
            supportsImages: obj.supportsImages !== false,
            efforts: Array.isArray(obj.efforts)
              ? obj.efforts.map(String)
              : ["low", "medium", "high"],
          };
        }
        return null;
      })
      .filter((x): x is AgyModelSpec => x !== null);
    if (mapped.length > 0) return mapped;
  }

  if (typeof rawValue === "string" && rawValue.trim()) {
    const trimmed = rawValue.trim();
    if (trimmed.startsWith("[")) {
      try {
        return parseFallbackModels(JSON.parse(trimmed));
      } catch {
        // fall through
      }
    }
    const parts = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.map((entry) => {
        const colonIdx = entry.indexOf(":");
        const id = normalizeModelId(colonIdx === -1 ? entry : entry.slice(0, colonIdx));
        const name = colonIdx === -1 ? id : entry.slice(colonIdx + 1).trim() || id;
        return {
          id,
          name,
          description: "Antigravity ACP model",
          contextWindow: 1000000,
          maxOutputTokens: 65536,
          supportsImages: true,
          efforts: ["low", "medium", "high"],
        };
      });
    }
  }

  return DEFAULT_FALLBACK_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
}

function flattenSelectOptions(options: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(options)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of options) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (Array.isArray(obj.options)) {
      for (const nested of obj.options) {
        if (nested && typeof nested === "object" && (nested as Record<string, unknown>).value != null) {
          out.push(nested as Record<string, unknown>);
        }
      }
    } else if (obj.value != null) {
      out.push(obj);
    }
  }
  return out;
}

export function extractEffortConfigFromSessionResult(
  result: Record<string, unknown> | null | undefined,
): AgyEffortConfig | null {
  const configOptions = Array.isArray(result?.configOptions)
    ? (result.configOptions as Array<Record<string, unknown>>)
    : [];
  const opt = configOptions.find(
    (entry) =>
      entry &&
      entry.type === "select" &&
      (entry.category === "thought_level" ||
        ["thought_level", "reasoning_effort", "effort", "thinking"].includes(
          String(entry.id || "").toLowerCase(),
        )),
  );
  if (!opt) return null;
  const values = flattenSelectOptions(opt.options).map((o) => ({
    value: String(o.value),
    name: typeof o.name === "string" && o.name ? o.name : String(o.value),
    description: typeof o.description === "string" ? o.description : "",
  }));
  return {
    configId: String(opt.id),
    currentValue: opt.currentValue != null ? String(opt.currentValue) : undefined,
    options: values,
  };
}

export function extractModelsFromSessionResult(
  result: Record<string, unknown> | null | undefined,
): {
  modelConfigId: string | null;
  currentModelId: string | null;
  effortConfig: AgyEffortConfig | null;
  models: AgyModelSpec[];
} {
  const byId = new Map<string, AgyModelSpec>();
  let modelConfigId: string | null = null;
  let currentModelId: string | null = null;

  const effortConfig = extractEffortConfigFromSessionResult(result);
  const effortValues = effortConfig
    ? effortConfig.options.map((o) => o.value)
    : ["low", "medium", "high"];

  const configOptions = Array.isArray(result?.configOptions)
    ? (result.configOptions as Array<Record<string, unknown>>)
    : [];
  const modelOpt = configOptions.find(
    (entry) =>
      entry &&
      entry.type === "select" &&
      (entry.category === "model" || String(entry.id || "").toLowerCase() === "model"),
  );

  if (modelOpt) {
    modelConfigId = String(modelOpt.id);
    if (modelOpt.currentValue != null) {
      currentModelId = normalizeModelId(String(modelOpt.currentValue));
    }
    for (const item of flattenSelectOptions(modelOpt.options)) {
      const id = normalizeModelId(String(item.value));
      if (!id) continue;
      const meta =
        item._meta && typeof item._meta === "object"
          ? (item._meta as Record<string, unknown>)
          : {};
      byId.set(id, {
        id,
        name: typeof item.name === "string" && item.name ? item.name : id,
        description:
          typeof item.description === "string" && item.description
            ? item.description
            : "Antigravity ACP model",
        contextWindow:
          typeof meta.contextWindow === "number" ? meta.contextWindow : 1000000,
        maxOutputTokens:
          typeof meta.maxOutputTokens === "number" ? meta.maxOutputTokens : 65536,
        supportsImages: meta.supportsImages !== false,
        efforts: Array.isArray(meta.efforts)
          ? meta.efforts.map(String)
          : [...effortValues],
      });
    }
  }

  const legacyModels = result?.models as Record<string, unknown> | undefined;
  if (legacyModels && typeof legacyModels === "object") {
    if (!currentModelId && typeof legacyModels.currentModelId === "string") {
      currentModelId = normalizeModelId(legacyModels.currentModelId);
    }
    const available = Array.isArray(legacyModels.availableModels)
      ? (legacyModels.availableModels as Array<Record<string, unknown>>)
      : [];
    for (const item of available) {
      if (!item || typeof item !== "object") continue;
      const rawId = item.modelId ?? item.id ?? item.value;
      if (typeof rawId !== "string") continue;
      const id = normalizeModelId(rawId);
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        name: typeof item.name === "string" && item.name ? item.name : id,
        description:
          typeof item.description === "string" && item.description
            ? item.description
            : "Antigravity ACP model",
        contextWindow:
          typeof item.contextWindow === "number" ? item.contextWindow : 1000000,
        maxOutputTokens:
          typeof item.maxOutputTokens === "number" ? item.maxOutputTokens : 65536,
        supportsImages: item.supportsImages !== false,
        efforts: [...effortValues],
      });
    }
  }

  return {
    modelConfigId,
    currentModelId,
    effortConfig,
    models: Array.from(byId.values()),
  };
}

function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof AgyAuthRequiredError) return true;
  const code = (err as { code?: unknown }).code;
  if (code === -32000) return true;
  const msg = String((err as { message?: unknown }).message || "");
  return /authentication required|not authenticated|sign in|login required/i.test(msg);
}

function isPolicyOrQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof AgyPolicyCooldownError) return true;
  const code = Number((err as { code?: unknown }).code);
  if (code === 403 || code === 429) return true;
  const msg = String((err as { message?: unknown }).message || "");
  return /permission_denied|403|terms of service|account.*(?:disabled|suspended|banned)|service has been disabled|resource_exhausted|too many requests|rate.?limit/i.test(
    msg,
  );
}

function extractTextFromContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractTextFromContent).filter(Boolean).join("");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") return obj.text;
    if (typeof obj.text === "string") return obj.text;
    if (obj.content) return extractTextFromContent(obj.content);
  }
  return "";
}

function selectPermissionOutcome(
  options: Array<Record<string, unknown>> | undefined,
  policy: "allow" | "reject",
): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const list = Array.isArray(options) ? options : [];
  if (policy === "allow") {
    const allowOnce = list.find((o) => o?.kind === "allow_once");
    if (allowOnce && typeof allowOnce.optionId === "string") {
      return { outcome: "selected", optionId: allowOnce.optionId };
    }
    const allowAlways = list.find((o) => o?.kind === "allow_always");
    if (allowAlways && typeof allowAlways.optionId === "string") {
      return { outcome: "selected", optionId: allowAlways.optionId };
    }
    const fallbackAllow = list.find((o) =>
      String(o?.kind || o?.optionId || "").toLowerCase().includes("allow"),
    );
    if (fallbackAllow && typeof fallbackAllow.optionId === "string") {
      return { outcome: "selected", optionId: fallbackAllow.optionId };
    }
    if (typeof list[0]?.optionId === "string") {
      return { outcome: "selected", optionId: list[0].optionId };
    }
    return { outcome: "cancelled" };
  }

  const rejectOnce = list.find((o) => o?.kind === "reject_once");
  if (rejectOnce && typeof rejectOnce.optionId === "string") {
    return { outcome: "selected", optionId: rejectOnce.optionId };
  }
  const rejectAlways = list.find((o) => o?.kind === "reject_always");
  if (rejectAlways && typeof rejectAlways.optionId === "string") {
    return { outcome: "selected", optionId: rejectAlways.optionId };
  }
  return { outcome: "cancelled" };
}

export class AgyAcpClient {
  readonly env: NodeJS.ProcessEnv;
  readonly agyBin: string;
  readonly geminiDir: string;
  readonly appDataDir: string;
  readonly sandbox: boolean;
  readonly autoApprove: boolean;
  readonly authMethod: string;
  readonly defaultCwd: string;
  readonly rpcTimeoutMs: number;
  readonly discoveryTtlMs: number;
  readonly authCooldownMs: number;
  readonly policyCooldownMs: number;
  readonly maxSessions: number;
  readonly fallbackModels: AgyModelSpec[];
  readonly extraArgs: string[];

  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private initPromise: Promise<Record<string, unknown>> | null = null;
  private initResult: Record<string, unknown> | null = null;
  private authenticated: boolean | null = null;
  private lastDiscovery: AgyDiscoveryResult | null = null;
  private lastDiscoveryAt = 0;
  private lastError: string | null = null;
  private lastPolicyError: string | null = null;
  private authCooldownUntil = 0;
  private policyCooldownUntil = 0;
  private stderrTail: string[] = [];
  private sessions = new Map<string, SessionState>();
  private activeTurns = new Map<string, ActiveTurn>();
  private sessionQueues = new Map<string, Promise<unknown>>();
  private disposed = false;

  constructor(options: AgyClientOptions = {}) {
    this.env = options.env || process.env;
    const persisted =
      options.usePersistedConfig === false ? {} : readPersistedAcpConfig(this.env);
    this.agyBin = options.agyBin || this.env.AGY_BIN || "agy";
    this.geminiDir = String(
      options.geminiDir ??
        this.env.AGY_GEMINI_DIR ??
        (typeof persisted.geminiDir === "string" ? persisted.geminiDir : ""),
    ).trim();
    this.appDataDir = String(
      options.appDataDir ??
        this.env.AGY_APP_DATA_DIR ??
        (typeof persisted.appDataDir === "string" ? persisted.appDataDir : ""),
    ).trim();
    this.sandbox =
      typeof options.sandbox === "boolean"
        ? options.sandbox
        : this.env.AGY_SANDBOX === "1";
    this.autoApprove =
      typeof options.autoApprove === "boolean"
        ? options.autoApprove
        : this.env.AGY_AUTO_APPROVE !== "0";
    this.authMethod = String(
      options.authMethod ??
        this.env.AGY_AUTH_METHOD ??
        (typeof persisted.authMethod === "string" ? persisted.authMethod : ""),
    ).trim();
    this.defaultCwd = options.cwd || process.cwd();
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30000;
    this.discoveryTtlMs = options.discoveryTtlMs ?? 60000;
    this.authCooldownMs = options.authCooldownMs ?? 30000;
    this.policyCooldownMs = options.policyCooldownMs ?? 300000;
    this.maxSessions = options.maxSessions ?? 32;
    this.fallbackModels =
      Array.isArray(options.fallbackModels) && options.fallbackModels.length > 0
        ? options.fallbackModels
        : parseFallbackModels(this.env.AGY_FALLBACK_MODELS);

    const envExtraArgs =
      typeof this.env.AGY_ACP_ARGS === "string" && this.env.AGY_ACP_ARGS.trim()
        ? this.env.AGY_ACP_ARGS.trim().split(/\s+/)
        : [];
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : envExtraArgs;
  }

  private _buildArgs(): string[] {
    const args = ["acp"];
    if (this.geminiDir) args.push("--gemini-dir", this.geminiDir);
    if (this.appDataDir) args.push("--app-data-dir", this.appDataDir);
    if (this.sandbox) args.push("--sandbox");
    if (this.autoApprove) args.push("--dangerously-skip-permissions");
    if (this.extraArgs.length > 0) args.push(...this.extraArgs);
    return args;
  }

  getLoginCommand(): AgyLoginCommand {
    const args = buildLoginCommandArgs({
      geminiDir: this.geminiDir,
      appDataDir: this.appDataDir,
    });
    return {
      bin: this.agyBin,
      args,
      command: [this.agyBin, ...args].join(" "),
    };
  }

  formatLoginCommand(): string {
    return this.getLoginCommand().command;
  }

  private _formatLoginCommand(): string {
    return this.formatLoginCommand();
  }

  clearCooldown(): void {
    this.authCooldownUntil = 0;
    this.policyCooldownUntil = 0;
    this.lastPolicyError = null;
  }

  async setApiKey(apiKey: string | null | undefined): Promise<boolean> {
    const nextKey = typeof apiKey === "string" ? apiKey.trim() : "";
    const prevKey =
      typeof this.env.GEMINI_API_KEY === "string" ? this.env.GEMINI_API_KEY.trim() : "";
    if (nextKey === prevKey) return false;
    const nextEnv: NodeJS.ProcessEnv = { ...this.env };
    if (nextKey) {
      nextEnv.GEMINI_API_KEY = nextKey;
    } else {
      delete nextEnv.GEMINI_API_KEY;
    }
    this.env = nextEnv;
    this.clearCooldown();
    await this.restart();
    return true;
  }

  private _ensureSpawned(): void {
    if (this.disposed) {
      throw new Error("AgyAcpClient has been disposed");
    }
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return;
    }

    const child = spawn(this.agyBin, this._buildArgs(), {
      cwd: this.defaultCwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = child;
    this.initResult = null;
    this.initPromise = null;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 40) {
          this.stderrTail.shift();
        }
      }
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.rl = rl;

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      this._handleIncoming(msg);
    });

    const onDisconnect = (reason: unknown) => {
      if (this.proc !== child) return;
      this.proc = null;
      this.initResult = null;
      this.initPromise = null;
      this.sessions.clear();
      try {
        rl.close();
      } catch {
        // ignore
      }
      this.rl = null;

      const err = reason instanceof Error ? reason : new Error(String(reason));
      this.lastError = err.message;
      for (const [, pending] of this.pendingRequests) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingRequests.clear();
      this.activeTurns.clear();
    };

    child.on("error", (err) => {
      onDisconnect(new Error(`Failed to spawn '${this.agyBin} acp': ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      const detail = this.stderrTail.slice(-3).join(" | ");
      onDisconnect(
        new Error(
          `agy acp exited (code=${code ?? "null"}, signal=${signal ?? "null"})${
            detail ? `: ${detail}` : ""
          }`,
        ),
      );
    });
  }

  private _writeMessage(payload: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("agy acp process is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private _request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.rpcTimeoutMs,
  ): Promise<Record<string, unknown>> {
    this._ensureSpawned();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(id);
              reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      if (timer && typeof timer.unref === "function") timer.unref();
      this.pendingRequests.set(id, {
        resolve: (val) => resolve((val as Record<string, unknown>) || {}),
        reject,
        timer,
        method,
      });
      try {
        this._writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private _handleIncoming(msg: Record<string, unknown>): void {
    if (msg.id !== undefined && msg.id !== null && typeof msg.method !== "string") {
      const pending = this.pendingRequests.get(Number(msg.id));
      if (!pending) return;
      this.pendingRequests.delete(Number(msg.id));
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as Record<string, unknown>;
        const err = new Error(
          typeof errObj.message === "string"
            ? errObj.message
            : `ACP error (${pending.method})`,
        ) as Error & { code?: unknown; data?: unknown };
        err.code = errObj.code;
        err.data = errObj.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && msg.id !== null && typeof msg.method === "string") {
      if (msg.method === "session/request_permission") {
        const params = (msg.params as Record<string, unknown>) || {};
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
        const turn = sessionId ? this.activeTurns.get(sessionId) : null;
        const policy: "allow" | "reject" = turn
          ? turn.permissionPolicy
          : this.autoApprove
            ? "allow"
            : "reject";
        const outcome = selectPermissionOutcome(
          params.options as Array<Record<string, unknown>> | undefined,
          policy,
        );
        try {
          this._writeMessage({ jsonrpc: "2.0", id: msg.id, result: { outcome } });
        } catch {
          // ignore
        }
        return;
      }

      try {
        this._writeMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
        });
      } catch {
        // ignore
      }
      return;
    }

    if (msg.method === "session/update") {
      const params = (msg.params as Record<string, unknown>) || {};
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const update = params.update as Record<string, unknown> | undefined;
      if (!update || typeof update !== "object") return;

      if (
        update.sessionUpdate === "config_option_update" &&
        Array.isArray(update.configOptions)
      ) {
        const extracted = extractModelsFromSessionResult({
          configOptions: update.configOptions,
        });
        if (extracted.models.length > 0 && this.lastDiscovery) {
          this.lastDiscovery = {
            ...this.lastDiscovery,
            models: extracted.models,
            modelConfigId: extracted.modelConfigId || this.lastDiscovery.modelConfigId,
            effortConfig: extracted.effortConfig || this.lastDiscovery.effortConfig,
          };
        }
      }

      const turn = sessionId ? this.activeTurns.get(sessionId) : null;
      if (turn) turn.handleUpdate(update);
    }
  }

  async initialize(timeoutMs = this.rpcTimeoutMs): Promise<Record<string, unknown>> {
    if (this.initResult) return this.initResult;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const result = await this._request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "agi-opencode-acp-plugin",
            version: "0.2.0",
          },
        },
        timeoutMs,
      );
      this.initResult = result || {};
      return this.initResult;
    })();

    try {
      return await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async authenticate(methodId: string, timeoutMs = this.rpcTimeoutMs): Promise<Record<string, unknown>> {
    await this.initialize(timeoutMs);
    const result = await this._request("authenticate", { methodId }, timeoutMs);
    this.authenticated = true;
    this.clearCooldown();
    return result;
  }

  async logout(timeoutMs = this.rpcTimeoutMs): Promise<AgyLogoutResult> {
    await this.initialize(timeoutMs);
    const caps = this.initResult?.agentCapabilities as Record<string, unknown> | undefined;
    const authCaps = caps?.auth as Record<string, unknown> | undefined;
    if (!authCaps || !("logout" in authCaps)) {
      return {
        ok: false,
        supported: false,
        message: "Connected agy acp server does not advertise auth.logout capability.",
      };
    }
    const sessionIds = Array.from(this.sessions.values()).map((s) => s.sessionId);
    this.sessions.clear();
    await Promise.all(sessionIds.map((id) => this._closeSessionBestEffort(id)));
    await this._request("logout", {}, timeoutMs);
    this.authenticated = false;
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.clearCooldown();
    return { ok: true, supported: true };
  }

  private _resolveAutoAuthMethod(): string {
    if (this.authMethod) return this.authMethod;
    if (this.env.GEMINI_API_KEY && String(this.env.GEMINI_API_KEY).trim()) {
      return "gemini-api-key";
    }
    return "";
  }

  private _tripPolicyCooldown(err: unknown): AgyPolicyCooldownError {
    const msg = err instanceof Error ? err.message : String(err || "Antigravity policy/quota error");
    this.lastPolicyError = msg;
    this.policyCooldownUntil = Date.now() + this.policyCooldownMs;
    return new AgyPolicyCooldownError(
      `Antigravity ACP paused for ${Math.ceil(this.policyCooldownMs / 1000)}s to prevent retry-loop abuse/bans: ${msg}`,
      this.policyCooldownMs,
    );
  }

  private async _createSessionRaw(
    cwd: string,
    timeoutMs = this.rpcTimeoutMs,
    { bypassAuthCooldown = false }: { bypassAuthCooldown?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (now < this.policyCooldownUntil) {
      const remaining = this.policyCooldownUntil - now;
      throw new AgyPolicyCooldownError(
        `Antigravity ACP is in safety cooldown (${Math.ceil(remaining / 1000)}s remaining) after: ${this.lastPolicyError || "policy/quota error"}`,
        remaining,
      );
    }

    if (!bypassAuthCooldown && now < this.authCooldownUntil && !this._resolveAutoAuthMethod()) {
      const methods = Array.isArray(this.initResult?.authMethods)
        ? (this.initResult.authMethods as Array<Record<string, unknown>>)
        : [];
      throw new AgyAuthRequiredError(
        `Antigravity ACP requires authentication. Run '${this._formatLoginCommand()}' or set GEMINI_API_KEY.`,
        methods,
      );
    }

    await this.initialize(timeoutMs);
    const tryNew = () =>
      this._request(
        "session/new",
        {
          cwd: cwd || this.defaultCwd,
          mcpServers: [],
        },
        timeoutMs,
      );

    try {
      const res = await tryNew();
      this.authenticated = true;
      this.authCooldownUntil = 0;
      return res;
    } catch (err) {
      if (isPolicyOrQuotaError(err)) {
        throw this._tripPolicyCooldown(err);
      }
      if (!isAuthError(err)) throw err;
      const methodId = this._resolveAutoAuthMethod();
      if (methodId) {
        try {
          await this.authenticate(methodId, timeoutMs);
          const retried = await tryNew();
          this.authenticated = true;
          this.authCooldownUntil = 0;
          return retried;
        } catch (retryErr) {
          if (isPolicyOrQuotaError(retryErr)) {
            throw this._tripPolicyCooldown(retryErr);
          }
          if (!isAuthError(retryErr)) throw retryErr;
        }
      }
      this.authenticated = false;
      this.authCooldownUntil = Date.now() + this.authCooldownMs;
      const methods = Array.isArray(this.initResult?.authMethods)
        ? (this.initResult.authMethods as Array<Record<string, unknown>>)
        : [];
      throw new AgyAuthRequiredError(
        `Antigravity ACP requires authentication. Run '${this._formatLoginCommand()}' or set GEMINI_API_KEY.`,
        methods,
      );
    }
  }

  private async _closeSessionBestEffort(sessionId: string): Promise<void> {
    if (!sessionId || !this.proc) return;
    try {
      await this._request("session/close", { sessionId }, 2000);
    } catch {
      // ignore
    }
  }

  async discoverModels({
    cwd,
    forceRefresh = false,
    timeoutMs = 2500,
  }: { cwd?: string; forceRefresh?: boolean; timeoutMs?: number } = {}): Promise<AgyDiscoveryResult> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.lastDiscovery &&
      now - this.lastDiscoveryAt < this.discoveryTtlMs
    ) {
      return this.lastDiscovery;
    }

    try {
      const sessionRes = await this._createSessionRaw(
        cwd || this.defaultCwd,
        timeoutMs,
        { bypassAuthCooldown: forceRefresh },
      );
      const sessionId = String(sessionRes.sessionId || "");
      const extracted = extractModelsFromSessionResult(sessionRes);
      await this._closeSessionBestEffort(sessionId);

      const models =
        extracted.models.length > 0
          ? extracted.models
          : this.fallbackModels.map((m) => ({ ...m, efforts: [...m.efforts] }));

      this.lastError = null;
      this.lastDiscovery = {
        models,
        source: extracted.models.length > 0 ? "acp" : "fallback",
        authenticated: true,
        modelConfigId: extracted.modelConfigId,
        currentModelId: extracted.currentModelId || models[0]?.id || null,
        effortConfig: extracted.effortConfig,
        agentInfo: (this.initResult?.agentInfo as Record<string, unknown>) || null,
        authMethods: Array.isArray(this.initResult?.authMethods)
          ? (this.initResult.authMethods as Array<Record<string, unknown>>)
          : [],
      };
      this.lastDiscoveryAt = Date.now();
      return this.lastDiscovery;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.lastDiscovery = {
        models: this.fallbackModels.map((m) => ({ ...m, efforts: [...m.efforts] })),
        source: "fallback",
        authenticated: isAuthError(err) ? false : this.authenticated,
        modelConfigId: null,
        currentModelId: this.fallbackModels[0]?.id || null,
        effortConfig: null,
        agentInfo: (this.initResult?.agentInfo as Record<string, unknown>) || null,
        authMethods: Array.isArray(this.initResult?.authMethods)
          ? (this.initResult.authMethods as Array<Record<string, unknown>>)
          : [],
        error: message,
      };
      this.lastDiscoveryAt = Date.now();
      return this.lastDiscovery;
    }
  }

  private async _setSessionModel(sessionState: SessionState, modelId: string): Promise<void> {
    const target = normalizeModelId(modelId);
    if (!target || sessionState.currentModel === target) return;
    const configId = sessionState.modelConfigId || "model";
    try {
      await this._request("session/set_config_option", {
        sessionId: sessionState.sessionId,
        configId,
        value: target,
      });
      sessionState.currentModel = target;
      return;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const msg = err instanceof Error ? err.message : String(err);
      const isMethodMissing = code === -32601 || /method not found|unsupported/i.test(msg);
      if (!isMethodMissing && sessionState.modelConfigId) {
        try {
          await this._request("session/set_model", {
            sessionId: sessionState.sessionId,
            modelId: target,
          });
          sessionState.currentModel = target;
          return;
        } catch {
          throw err;
        }
      }
    }

    await this._request("session/set_model", {
      sessionId: sessionState.sessionId,
      modelId: target,
    });
    sessionState.currentModel = target;
  }

  private async _setSessionEffort(sessionState: SessionState, effort: string): Promise<void> {
    if (!effort || sessionState.currentEffort === effort) return;
    const configId = sessionState.effortConfigId;
    if (!configId) return;
    try {
      await this._request("session/set_config_option", {
        sessionId: sessionState.sessionId,
        configId,
        value: effort,
      });
      sessionState.currentEffort = effort;
    } catch {
      // ignore unsupported effort overrides
    }
  }

  private _evictSessionsIfNeeded(): void {
    while (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (!oldestKey) break;
      const old = this.sessions.get(oldestKey);
      this.sessions.delete(oldestKey);
      if (old?.sessionId) {
        void this._closeSessionBestEffort(old.sessionId);
      }
    }
  }

  getCachedTurnCount(conversationKey?: string): number {
    if (!conversationKey) return 0;
    return this.sessions.get(conversationKey)?.sentTurnCount || 0;
  }

  async getOrCreateSession({
    conversationKey,
    cwd,
    modelId,
    effort,
    auxiliary = false,
  }: {
    conversationKey?: string;
    cwd?: string;
    modelId?: string;
    effort?: string;
    auxiliary?: boolean;
  }): Promise<{ state: SessionState; isNew: boolean }> {
    const resolvedCwd = cwd || this.defaultCwd;
    let state: SessionState | null = null;
    let isNew = true;

    if (!auxiliary && conversationKey && this.sessions.has(conversationKey)) {
      const existing = this.sessions.get(conversationKey)!;
      if (existing.cwd === resolvedCwd) {
        this.sessions.delete(conversationKey);
        this.sessions.set(conversationKey, existing);
        existing.updatedAt = Date.now();
        state = existing;
        isNew = false;
      } else {
        this.sessions.delete(conversationKey);
        void this._closeSessionBestEffort(existing.sessionId);
      }
    }

    if (!state) {
      const sessionRes = await this._createSessionRaw(resolvedCwd);
      const extracted = extractModelsFromSessionResult(sessionRes);
      state = {
        sessionId: String(sessionRes.sessionId),
        cwd: resolvedCwd,
        modelConfigId: extracted.modelConfigId,
        currentModel: extracted.currentModelId,
        effortConfigId: extracted.effortConfig?.configId || null,
        currentEffort: extracted.effortConfig?.currentValue || null,
        sentTurnCount: 0,
        updatedAt: Date.now(),
      };
      if (!auxiliary && conversationKey) {
        this._evictSessionsIfNeeded();
        this.sessions.set(conversationKey, state);
      }
    }

    if (modelId) await this._setSessionModel(state, modelId);
    if (effort) await this._setSessionEffort(state, effort);

    return { state, isNew };
  }

  private _enqueueForKey<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
    const queueKey = key || "__ephemeral__";
    const prev = this.sessionQueues.get(queueKey) || Promise.resolve();
    const run = prev.then(fn, fn);
    const sentinel = run.then(
      () => {
        if (this.sessionQueues.get(queueKey) === sentinel) {
          this.sessionQueues.delete(queueKey);
        }
      },
      () => {
        if (this.sessionQueues.get(queueKey) === sentinel) {
          this.sessionQueues.delete(queueKey);
        }
      },
    );
    this.sessionQueues.set(queueKey, sentinel);
    return run;
  }

  async promptTurn({
    conversationKey,
    cwd,
    modelId,
    effort,
    promptBlocks,
    auxiliary = false,
    signal,
    onEvent,
  }: {
    conversationKey?: string;
    cwd?: string;
    modelId?: string;
    effort?: string;
    promptBlocks: AgyPromptBlock[];
    auxiliary?: boolean;
    signal?: AbortSignal;
    onEvent?: (evt: AgyTurnEvent) => void;
  }): Promise<AgyTurnResult> {
    if (signal?.aborted) {
      throw new Error("Request aborted");
    }

    return this._enqueueForKey(auxiliary ? undefined : conversationKey, async () => {
      const { state, isNew } = await this.getOrCreateSession({
        conversationKey,
        cwd,
        modelId,
        effort,
        auxiliary,
      });

      if (signal?.aborted) {
        if (auxiliary) {
          void this._closeSessionBestEffort(state.sessionId);
        }
        return {
          sessionId: state.sessionId,
          isNewSession: isNew,
          model: state.currentModel || normalizeModelId(modelId),
          effort: state.currentEffort || effort || null,
          text: "",
          thoughts: "",
          stopReason: "cancelled",
          usage: null,
        };
      }

      const sessionId = state.sessionId;
      let text = "";
      let thoughts = "";
      let usage: Record<string, unknown> | null = null;
      const permissionPolicy: "allow" | "reject" = auxiliary
        ? "reject"
        : this.autoApprove
          ? "allow"
          : "reject";

      this.activeTurns.set(sessionId, {
        permissionPolicy,
        handleUpdate(update) {
          const kind = update.sessionUpdate;
          if (kind === "agent_message_chunk") {
            const delta = extractTextFromContent(update.content);
            if (delta) {
              text += delta;
              onEvent?.({ type: "text", text: delta });
            }
            return;
          }
          if (kind === "agent_thought_chunk") {
            const delta = extractTextFromContent(update.content);
            if (delta) {
              thoughts += delta;
              onEvent?.({ type: "thought", text: delta });
            }
            return;
          }
          if (kind === "tool_call" || kind === "tool_call_update") {
            onEvent?.({
              type: "tool",
              toolCallId:
                typeof update.toolCallId === "string" ? update.toolCallId : undefined,
              title: String(update.title || update.name || "tool"),
              name: typeof update.name === "string" ? update.name : null,
              status: typeof update.status === "string" ? update.status : null,
            });
            return;
          }
          if (kind === "usage_update") {
            usage = (update.usage as Record<string, unknown>) || update;
            onEvent?.({ type: "usage", usage });
          }
        },
      });

      const onAbort = () => {
        void this.cancel(sessionId);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const promptRes = await this._request(
          "session/prompt",
          {
            sessionId,
            prompt: Array.isArray(promptBlocks) ? promptBlocks : [],
          },
          0,
        );

        if (!auxiliary) {
          state.sentTurnCount += 1;
          state.updatedAt = Date.now();
        }

        const mergedUsage =
          (promptRes.usage as Record<string, unknown> | undefined) || usage || null;
        return {
          sessionId,
          isNewSession: isNew,
          model: state.currentModel || normalizeModelId(modelId),
          effort: state.currentEffort || effort || null,
          text,
          thoughts,
          stopReason: String(promptRes.stopReason || "end_turn"),
          usage: mergedUsage,
        };
      } catch (err) {
        if (isPolicyOrQuotaError(err)) {
          throw this._tripPolicyCooldown(err);
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        this.activeTurns.delete(sessionId);
        if (auxiliary) {
          void this._closeSessionBestEffort(sessionId);
        }
      }
    });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!sessionId || !this.proc) return;
    try {
      this._writeMessage({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      });
    } catch {
      // ignore
    }
  }

  status(): Record<string, unknown> {
    const caps = this.initResult?.agentCapabilities as Record<string, unknown> | undefined;
    const authCaps = caps?.auth as Record<string, unknown> | undefined;
    return {
      running: Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null),
      pid: this.proc?.pid ?? null,
      agyBin: this.agyBin,
      geminiDir: this.geminiDir || null,
      appDataDir: this.appDataDir || null,
      loginCommand: this.formatLoginCommand(),
      canLogout: Boolean(authCaps && "logout" in authCaps),
      agentInfo: this.initResult?.agentInfo ?? null,
      authMethods: this.initResult?.authMethods ?? [],
      authenticated: this.authenticated,
      activeSessions: this.sessions.size,
      modelsCount: this.lastDiscovery?.models?.length ?? this.fallbackModels.length,
      modelSource: this.lastDiscovery?.source ?? "fallback",
      authCooldownUntil: this.authCooldownUntil || null,
      policyCooldownUntil: this.policyCooldownUntil || null,
      lastPolicyError: this.lastPolicyError,
      lastError: this.lastError,
      stderrTail: [...this.stderrTail],
    };
  }

  private async _shutdownProcess(reasonMessage: string): Promise<void> {
    const sessionIds = Array.from(this.sessions.values()).map((s) => s.sessionId);
    this.sessions.clear();
    await Promise.all(sessionIds.map((id) => this._closeSessionBestEffort(id)));

    for (const [, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reasonMessage));
    }
    this.pendingRequests.clear();
    this.activeTurns.clear();

    const child = this.proc;
    this.proc = null;
    this.initResult = null;
    this.initPromise = null;
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        // ignore
      }
      this.rl = null;
    }

    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, 500);
        if (typeof killTimer.unref === "function") killTimer.unref();

        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        try {
          child.kill("SIGTERM");
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
    }
  }

  async restart(): Promise<void> {
    if (this.disposed) return;
    await this._shutdownProcess("AgyAcpClient restarted");
    this.lastDiscovery = null;
    this.lastDiscoveryAt = 0;
    this.clearCooldown();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this._shutdownProcess("AgyAcpClient disposed");
  }
}
