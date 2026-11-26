import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
}

export class JsonRpcStdioTransport {
  private readonly command: () => string;
  private readonly buildArgs: () => string[];
  private readonly getCwd: () => string;
  private readonly getEnv: () => NodeJS.ProcessEnv;
  private readonly defaultTimeoutMs: number;
  private readonly onRequest?: (msg: Record<string, unknown>) => void;
  private readonly onNotification?: (msg: Record<string, unknown>) => void;
  private readonly onDisconnect?: (err: Error) => void;

  proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  stderrTail: string[] = [];
  disposed = false;

  constructor(opts: {
    command: () => string;
    buildArgs: () => string[];
    getCwd: () => string;
    getEnv: () => NodeJS.ProcessEnv;
    defaultTimeoutMs?: number;
    onRequest?: (msg: Record<string, unknown>) => void;
    onNotification?: (msg: Record<string, unknown>) => void;
    onDisconnect?: (err: Error) => void;
  }) {
    this.command = opts.command;
    this.buildArgs = opts.buildArgs;
    this.getCwd = opts.getCwd;
    this.getEnv = opts.getEnv;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30000;
    this.onRequest = opts.onRequest;
    this.onNotification = opts.onNotification;
    this.onDisconnect = opts.onDisconnect;
  }

  isRunning(): boolean {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  ensureSpawned(): void {
    if (this.disposed) {
      throw new Error("AgyAcpClient has been disposed");
    }
    if (this.isRunning()) return;

    const child = spawn(this.command(), this.buildArgs(), {
      cwd: this.getCwd(),
      env: this.getEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc = child;

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

    const handleDisconnect = (reason: Error) => {
      if (this.proc !== child) return;
      this.proc = null;
      try {
        rl.close();
      } catch {
        // ignore
      }
      this.rl = null;

      for (const [, pending] of this.pendingRequests) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(reason);
      }
      this.pendingRequests.clear();
      this.onDisconnect?.(reason);
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

  private _writeMessage(payload: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("agy acp process is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  sendResponse(id: unknown, result: unknown): void {
    this._writeMessage({ jsonrpc: "2.0", id, result });
  }

  sendError(id: unknown, code: number, message: string): void {
    this._writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  sendNotification(method: string, params: unknown): void {
    this._writeMessage({ jsonrpc: "2.0", method, params });
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<Record<string, unknown>> {
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
      if (timer && typeof timer.unref === "function") timer.unref();

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
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
    if (!msg || typeof msg !== "object") return;

    if (msg.id !== undefined && msg.id !== null && !msg.method) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (!pending) return;
      this.pendingRequests.delete(msg.id as number);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error && typeof msg.error === "object") {
        const rpcErr = msg.error as { message?: string; code?: unknown; data?: unknown };
        const err = new Error(rpcErr.message || `ACP error (${pending.method})`) as Error & {
          code?: unknown;
          data?: unknown;
        };
        err.code = rpcErr.code;
        err.data = rpcErr.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && msg.id !== null && typeof msg.method === "string") {
      if (this.onRequest) {
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

    if (typeof msg.method === "string") {
      this.onNotification?.(msg);
    }
  }

  async shutdown(reasonMessage: string): Promise<void> {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
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
}
