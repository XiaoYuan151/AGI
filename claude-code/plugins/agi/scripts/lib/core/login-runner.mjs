import { spawn } from "node:child_process";

const MAX_OUTPUT_LINES = 80;

export function buildLoginCommandArgs({ geminiDir = "", appDataDir = "" } = {}) {
  const args = ["acp"];
  if (typeof geminiDir === "string" && geminiDir.trim()) {
    args.push("--gemini-dir", geminiDir.trim());
  }
  if (typeof appDataDir === "string" && appDataDir.trim()) {
    args.push("--app-data-dir", appDataDir.trim());
  }
  args.push("--login");
  return args;
}

export function extractAuthUrlFromOutput(text) {
  if (typeof text !== "string" || !text) return null;
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g);
  if (!matches || matches.length === 0) return null;
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?)\]]+$/, "");
    if (/^https?:\/\//i.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

export function runAgyInteractiveLogin({
  agyBin = "agy",
  geminiDir = "",
  appDataDir = "",
  env = process.env,
  cwd = process.cwd(),
  stdio = "inherit",
} = {}) {
  const args = buildLoginCommandArgs({ geminiDir, appDataDir });
  const command = [agyBin, ...args].join(" ");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ command, bin: agyBin, args, ...result });
    };
    let child;
    try {
      child = spawn(agyBin, args, { cwd, env, stdio });
    } catch (err) {
      finish({ ok: false, exitCode: null, signal: null, error: err.message });
      return;
    }
    child.once("error", (err) => {
      finish({ ok: false, exitCode: null, signal: null, error: err.message });
    });
    child.once("exit", (code, signal) => {
      finish({
        ok: code === 0,
        exitCode: code,
        signal: signal ?? null,
        ...(code === 0 ? {} : { error: `${command} exited with code ${code ?? "null"}` }),
      });
    });
  });
}

function makeIdleState() {
  return {
    status: "idle",
    account: null,
    dataDir: null,
    appDataDir: null,
    command: "",
    authUrl: null,
    outputTail: [],
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
  };
}

/**
 * Manages asynchronous `agy acp --login` subprocesses for GUI / HTTP hosts.
 * Captures OAuth URLs and output lines without blocking request handlers.
 */
export class InteractiveLoginManager {
  constructor({ spawnImpl = spawn } = {}) {
    this.spawnImpl = spawnImpl;
    this.state = makeIdleState();
    this._child = null;
    this._cancelling = false;
    this._killTimer = null;
  }

  getState() {
    return {
      ...this.state,
      outputTail: [...this.state.outputTail],
    };
  }

  _appendOutput(chunk) {
    const text = String(chunk || "");
    const foundUrl = extractAuthUrlFromOutput(text);
    if (foundUrl && !this.state.authUrl) {
      this.state.authUrl = foundUrl;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      this.state.outputTail.push(trimmed);
      if (this.state.outputTail.length > MAX_OUTPUT_LINES) {
        this.state.outputTail.shift();
      }
      if (!this.state.authUrl) {
        const lineUrl = extractAuthUrlFromOutput(trimmed);
        if (lineUrl) this.state.authUrl = lineUrl;
      }
    }
  }

  start({
    account = null,
    agyBin = "agy",
    geminiDir = "",
    appDataDir = "",
    env = process.env,
    cwd = process.cwd(),
    onComplete,
  } = {}) {
    if (this.state.status === "running" && this._child) {
      throw new Error("A Google sign-in session is already running.");
    }

    const args = buildLoginCommandArgs({ geminiDir, appDataDir });
    const command = [agyBin, ...args].join(" ");

    this._cancelling = false;
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }

    this.state = {
      status: "running",
      account: account || null,
      dataDir: geminiDir || null,
      appDataDir: appDataDir || null,
      command,
      authUrl: null,
      outputTail: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
    };

    let child;
    try {
      child = this.spawnImpl(agyBin, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.state.status = "failed";
      this.state.finishedAt = new Date().toISOString();
      this.state.error = err.message;
      const snap = this.getState();
      if (typeof onComplete === "function") {
        void Promise.resolve(onComplete(snap)).catch(() => {});
      }
      return snap;
    }

    this._child = child;
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this._appendOutput(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => this._appendOutput(chunk));
    }

    let settled = false;
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      if (this._killTimer) {
        clearTimeout(this._killTimer);
        this._killTimer = null;
      }
      if (this._child === child) {
        this._child = null;
      }
      Object.assign(this.state, patch, {
        finishedAt: new Date().toISOString(),
      });
      const snap = this.getState();
      if (typeof onComplete === "function") {
        void Promise.resolve(onComplete(snap)).catch(() => {});
      }
    };

    child.once("error", (err) => {
      finish({
        status: this._cancelling ? "cancelled" : "failed",
        exitCode: null,
        signal: null,
        error: this._cancelling ? "Sign-in cancelled." : err.message,
      });
    });

    child.once("exit", (code, signal) => {
      if (this._cancelling) {
        finish({
          status: "cancelled",
          exitCode: code,
          signal: signal ?? null,
          error: "Sign-in cancelled.",
        });
        return;
      }
      finish({
        status: code === 0 ? "succeeded" : "failed",
        exitCode: code,
        signal: signal ?? null,
        error: code === 0 ? null : `${command} exited with code ${code ?? "null"}`,
      });
    });

    return this.getState();
  }

  cancel() {
    if (this.state.status !== "running" || !this._child) {
      return this.getState();
    }
    this._cancelling = true;
    const child = this._child;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    this._killTimer = setTimeout(() => {
      if (this._child === child && child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 1500);
    if (typeof this._killTimer.unref === "function") {
      this._killTimer.unref();
    }
    this.state.status = "cancelled";
    this.state.finishedAt = new Date().toISOString();
    this.state.error = "Sign-in cancelled.";
    return this.getState();
  }

  dispose() {
    if (this._child && this.state.status === "running") {
      this.cancel();
    }
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
  }
}
