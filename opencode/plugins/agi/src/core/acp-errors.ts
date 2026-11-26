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

export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof AgyAuthRequiredError) return true;
  const code = (err as { code?: unknown }).code;
  if (code === -32000) return true;
  const msg = String((err as { message?: unknown }).message || "");
  return /authentication required|not authenticated|sign in|login required/i.test(msg);
}

export function isPolicyOrQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof AgyPolicyCooldownError) return true;
  const code = Number((err as { code?: unknown }).code);
  if (code === 403 || code === 429) return true;
  const msg = String((err as { message?: unknown }).message || "");
  return /permission_denied|403|terms of service|account.*(?:disabled|suspended|banned)|service has been disabled|resource_exhausted|too many requests|rate.?limit/i.test(
    msg,
  );
}

export function extractTextFromContent(content: unknown): string {
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

export function selectPermissionOutcome(
  options: unknown,
  policy: "allow" | "reject",
): { outcome: string; optionId?: string } {
  const list = Array.isArray(options)
    ? (options as Array<{ kind?: string; optionId?: string }>)
    : [];
  if (policy === "allow") {
    const allowOnce = list.find((o) => o?.kind === "allow_once");
    if (allowOnce?.optionId) return { outcome: "selected", optionId: allowOnce.optionId };
    const allowAlways = list.find((o) => o?.kind === "allow_always");
    if (allowAlways?.optionId) return { outcome: "selected", optionId: allowAlways.optionId };
    const fallbackAllow = list.find((o) =>
      String(o?.kind || o?.optionId || "").toLowerCase().includes("allow"),
    );
    if (fallbackAllow?.optionId) {
      return { outcome: "selected", optionId: fallbackAllow.optionId };
    }
    if (list[0]?.optionId) return { outcome: "selected", optionId: list[0].optionId };
    return { outcome: "cancelled" };
  }

  const rejectOnce = list.find((o) => o?.kind === "reject_once");
  if (rejectOnce?.optionId) return { outcome: "selected", optionId: rejectOnce.optionId };
  const rejectAlways = list.find((o) => o?.kind === "reject_always");
  if (rejectAlways?.optionId) return { outcome: "selected", optionId: rejectAlways.optionId };
  return { outcome: "cancelled" };
}

export class CooldownPolicy {
  readonly authCooldownMs: number;
  readonly policyCooldownMs: number;
  authCooldownUntil = 0;
  policyCooldownUntil = 0;
  lastPolicyError: string | null = null;

  constructor({
    authCooldownMs = 30000,
    policyCooldownMs = 300000,
  }: {
    authCooldownMs?: number;
    policyCooldownMs?: number;
  } = {}) {
    this.authCooldownMs = authCooldownMs;
    this.policyCooldownMs = policyCooldownMs;
  }

  clear(): void {
    this.authCooldownUntil = 0;
    this.policyCooldownUntil = 0;
    this.lastPolicyError = null;
  }

  clearAuth(): void {
    this.authCooldownUntil = 0;
  }

  tripAuth(): void {
    this.authCooldownUntil = Date.now() + this.authCooldownMs;
  }

  tripPolicy(err: unknown): AgyPolicyCooldownError {
    const msg =
      err instanceof Error ? err.message : String(err || "Antigravity policy/quota error");
    this.lastPolicyError = msg;
    this.policyCooldownUntil = Date.now() + this.policyCooldownMs;
    return new AgyPolicyCooldownError(
      `Antigravity ACP paused for ${Math.ceil(this.policyCooldownMs / 1000)}s to prevent retry-loop abuse/bans: ${msg}`,
      this.policyCooldownMs,
    );
  }

  checkPolicy(): void {
    const now = Date.now();
    if (now < this.policyCooldownUntil) {
      const remaining = this.policyCooldownUntil - now;
      throw new AgyPolicyCooldownError(
        `Antigravity ACP is in safety cooldown (${Math.ceil(remaining / 1000)}s remaining) after: ${this.lastPolicyError || "policy/quota error"}`,
        remaining,
      );
    }
  }

  isAuthCoolingDown(): boolean {
    return Date.now() < this.authCooldownUntil;
  }
}
