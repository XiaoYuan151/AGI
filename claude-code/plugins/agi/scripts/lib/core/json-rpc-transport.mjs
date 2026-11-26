import { spawn } from "node:child_process";
import readline from "node:readline";

/**
 * JSON-RPC 2.0 stdio subprocess transport for `agy acp`.
 */
export class JsonRpcStdioTransport {
  constructor({
    command,
    buildArgs,
    getCwd,
    getEnv,
    defaultTimeoutMs = 30000,
    onRequest,
    onNotification,
    onDisconnect,
    spawnImpl = spawn,
  }) {
    this.command = command;
    this.buildArgs = buildArgs;
    this.getCwd = getCwd;
    this.getEnv = getEnv;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onDisconnect = onDisconnect;
    this.spawnImpl = spawnImpl;

    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pendingRequests = new Map();
    this.stderrTail = [];
    this.disposed = false;
  }

  isRunning() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  get pid() {
    return this.proc?.pid ?? null;
  }

  ensureSpawned() {
    if (this.disposed) {
      throw new Error("AgyAcpClient has been disposed");
    }
    if (this.isRunning()) {
      return;
    }

    const args = this.buildArgs();
    const child = this.spawnImpl(this.command(), args, {
      cwd: this.getCwd(),
      env: this.getEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
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
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      this._handleIncoming(msg);
    });

    const handleDisconnect = (reason) => {
      if (this.proc !== child) return;
      this.proc = null;
      try {
        rl.close();
      } catch {
        // ignore
      }
      this.rl = null;

      const err = reason instanceof Error ? reason : new Error(String(reason));
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingRequests.clear();
      if (typeof this.onDisconnect === "function") {
        this.onDisconnect(err);
      }
    };

    child.on("error", (err) => {
      handleDisconnect(
        new Error(`Failed to spawn '${this.command()} acp': ${err.message}`),
      );
    });

    child.on("exit", (code, signal) => {
      const detail = this.stderrTail.slice(-3).join(" | ");
      const msg = `agy acp exited (code=${code ?? "null"}, signal=${signal ?? "null"})${
        detail ? `: ${detail}` : ""
      }`;
      handleDisconnect(new Error(msg));
    });
  }

  _writeMessage(payload) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("agy acp process is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  sendResponse(id, result) {
    this._writeMessage({ jsonrpc: "2.0", id, result });
  }

  sendError(id, code, message) {
    this._writeMessage({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  sendNotification(method, params) {
    this._writeMessage({ jsonrpc: "2.0", method, params });
  }

  request(method, params, timeoutMs = this.defaultTimeoutMs) {
    this.ensureSpawned();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pendingRequests.delete(id);
              reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
      this.pendingRequests.set(id, { resolve, reject, timer, method });
      try {
        this._writeMessage({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  _handleIncoming(msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || `ACP error (${pending.method})`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && msg.id !== null && typeof msg.method === "string") {
      if (typeof this.onRequest === "function") {
        this.onRequest(msg);
      } else {
        try {
          this.sendError(msg.id, -32601, `Unsupported client method: ${msg.method}`);
        } catch {
          // ignore
        }
      }
      return;
    }

    if (typeof msg.method === "string" && typeof this.onNotification === "function") {
      this.onNotification(msg);
    }
  }

  async shutdown(reasonMessage) {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reasonMessage));
    }
    this.pendingRequests.clear();

    const child = this.proc;
    this.proc = null;
    if (this.rl) {
      try {
        this.rl.close();
      } catch {
        // ignore
      }
      this.rl = null;
    }

    if (child && child.exitCode === null && !child.killed) {
      await new Promise((resolve) => {
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
}
