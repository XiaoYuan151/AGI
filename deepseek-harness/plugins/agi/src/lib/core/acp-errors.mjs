export class AgyAuthRequiredError extends Error {
  constructor(message, authMethods = []) {
    super(message);
    this.name = "AgyAuthRequiredError";
    this.code = -32000;
    this.authMethods = authMethods;
  }
}

export class AgyPolicyCooldownError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);
    this.name = "AgyPolicyCooldownError";
    this.code = 403;
    this.retryAfterMs = retryAfterMs;
  }
}

const AUTH_METHOD_ALIASES = Object.freeze({
  "api-key": "gemini-api-key",
  enterprise: "oauth-business",
  vertex: "agent-platform",
  google: "oauth-personal",
});

export function normalizeAuthMethodId(rawMethod, fallback = "") {
  const trimmed = typeof rawMethod === "string" ? rawMethod.trim() : "";
  if (!trimmed) return fallback;
  const lower = trimmed.toLowerCase();
  return AUTH_METHOD_ALIASES[lower] || trimmed;
}

export function isAuthError(err) {
  if (!err) return false;
  if (err instanceof AgyAuthRequiredError) return true;
  if (err.code === -32000) return true;
  const msg = String(err.message || "");
  return /authentication required|not authenticated|sign in|login required/i.test(msg);
}

export function isPolicyOrQuotaError(err) {
  if (!err) return false;
  if (err instanceof AgyPolicyCooldownError) return true;
  const code = Number(err.code);
  if (code === 403 || code === 429) return true;
  const msg = String(err.message || "");
  return /permission_denied|403|terms of service|account.*(?:disabled|suspended|banned)|service has been disabled|resource_exhausted|too many requests|rate.?limit/i.test(
    msg,
  );
}

export function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractTextFromContent).filter(Boolean).join("");
  }
  if (typeof content === "object") {
    if (content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    if (typeof content.text === "string") return content.text;
    if (content.content) return extractTextFromContent(content.content);
  }
  return "";
}

export function selectPermissionOutcome(options, policy) {
  const list = Array.isArray(options) ? options : [];
  if (policy === "allow") {
    const allowOnce = list.find((o) => o?.kind === "allow_once");
    if (allowOnce) return { outcome: "selected", optionId: allowOnce.optionId };
    const allowAlways = list.find((o) => o?.kind === "allow_always");
    if (allowAlways) return { outcome: "selected", optionId: allowAlways.optionId };
    const fallbackAllow = list.find((o) =>
      String(o?.kind || o?.optionId || "").toLowerCase().includes("allow"),
    );
    if (fallbackAllow) return { outcome: "selected", optionId: fallbackAllow.optionId };
    if (list[0]?.optionId) return { outcome: "selected", optionId: list[0].optionId };
    return { outcome: "cancelled" };
  }

  const rejectOnce = list.find((o) => o?.kind === "reject_once");
  if (rejectOnce) return { outcome: "selected", optionId: rejectOnce.optionId };
  const rejectAlways = list.find((o) => o?.kind === "reject_always");
  if (rejectAlways) return { outcome: "selected", optionId: rejectAlways.optionId };
  return { outcome: "cancelled" };
}

/**
 * Manages auth & policy cooldown windows to prevent retry-loop abuse against upstream ACP.
 */
export class CooldownPolicy {
  constructor({ authCooldownMs = 30000, policyCooldownMs = 300000 } = {}) {
    this.authCooldownMs = authCooldownMs;
    this.policyCooldownMs = policyCooldownMs;
    this.authCooldownUntil = 0;
    this.policyCooldownUntil = 0;
    this.lastPolicyError = null;
  }

  clear() {
    this.authCooldownUntil = 0;
    this.policyCooldownUntil = 0;
    this.lastPolicyError = null;
  }

  clearAuth() {
    this.authCooldownUntil = 0;
  }

  tripAuth() {
    this.authCooldownUntil = Date.now() + this.authCooldownMs;
  }

  tripPolicy(err) {
    const msg = String(err?.message || err || "Antigravity policy/quota error");
    this.lastPolicyError = msg;
    this.policyCooldownUntil = Date.now() + this.policyCooldownMs;
    return new AgyPolicyCooldownError(
      `Antigravity ACP paused for ${Math.ceil(this.policyCooldownMs / 1000)}s to prevent retry-loop abuse/bans: ${msg}`,
      this.policyCooldownMs,
    );
  }

  checkPolicy() {
    const now = Date.now();
    if (now < this.policyCooldownUntil) {
      const remaining = this.policyCooldownUntil - now;
      throw new AgyPolicyCooldownError(
        `Antigravity ACP is in safety cooldown (${Math.ceil(remaining / 1000)}s remaining) after: ${this.lastPolicyError || "policy/quota error"}`,
        remaining,
      );
    }
  }

  isAuthCoolingDown() {
    return Date.now() < this.authCooldownUntil;
  }
}
