import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

type JsonRpcId = string | number;

type JsonRpcErrorPayload = {
  code?: number;
  message?: string;
  data?: unknown;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
    windowsHide: boolean;
  },
) => ChildProcessWithoutNullStreams;

export type CodexAppServerNotification = {
  method: string;
  params?: unknown;
};

export type CodexAppServerClientOptions = {
  binary: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: SpawnProcess;
  onNotification?: (notification: CodexAppServerNotification) => void;
  onClose?: (error: CodexAppServerTransportError) => void;
  onLog?: (message: string) => void;
};

export class CodexAppServerRpcError extends Error {
  readonly code: number | null;
  readonly data: unknown;

  constructor(method: string, payload: JsonRpcErrorPayload) {
    super(payload.message ?? `codex app-server request failed: ${method}`);
    this.name = "CodexAppServerRpcError";
    this.code = typeof payload.code === "number" ? payload.code : null;
    this.data = payload.data;
  }
}

export class CodexAppServerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerTransportError";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_LIMIT = 8_000;

/**
 * Minimal JSON-RPC client for `codex app-server --stdio`.
 *
 * The app-server protocol is newline-delimited JSON-RPC-like messages without
 * the standard `jsonrpc: "2.0"` field. Requests are `{ id, method, params }`;
 * responses are `{ id, result }` or `{ id, error }`; notifications are
 * `{ method, params }`.
 */
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly onNotification?: (notification: CodexAppServerNotification) => void;
  private readonly onClose?: (error: CodexAppServerTransportError) => void;
  private readonly onLog?: (message: string) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stdout: Interface;
  private readonly exitWaiters: Array<() => void> = [];
  private nextId = 1;
  private closed = false;
  private exited = false;
  private closeNotified = false;
  private shutdownRequested = false;
  private stderrTail = "";

  private constructor(options: Required<Pick<CodexAppServerClientOptions, "binary">> & CodexAppServerClientOptions) {
    const spawnProcess = options.spawnProcess ?? spawn;
    this.child = spawnProcess(options.binary, ["app-server", "--stdio"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onNotification = options.onNotification;
    this.onClose = options.onClose;
    this.onLog = options.onLog;

    this.stdout = createInterface({ input: this.child.stdout });
    this.stdout.on("line", (line) => this.handleLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_LIMIT);
    });
    this.child.on("error", (err) => {
      const error = new CodexAppServerTransportError(err.message);
      this.markExited();
      this.closeWithError(error);
    });
    this.child.on("exit", (code, signal) => {
      this.markExited();
      if (this.shutdownRequested) {
        this.closeExpectedly();
        return;
      }
      const detail = this.stderrTail.trim();
      const suffix = detail ? ` stderr: ${detail}` : "";
      const error = new CodexAppServerTransportError(
        `codex app-server exited${code === null ? "" : ` with code ${code}`}${
          signal ? ` signal ${signal}` : ""
        }.${suffix}`,
      );
      this.closeWithError(error);
    });
  }

  static async start(options: CodexAppServerClientOptions): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options);
    try {
      await client.initialize();
    } catch (err) {
      await client.shutdown();
      throw err;
    }
    return client;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "first-tree",
        title: "First Tree",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
    return result;
  }

  request(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new CodexAppServerTransportError("codex app-server transport is closed"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const key = idKey(id);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new CodexAppServerTransportError(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(key, { method, resolve, reject, timer });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(err instanceof Error ? err : new CodexAppServerTransportError(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async shutdown(timeoutMs = 1_000): Promise<void> {
    this.shutdownRequested = true;
    if (this.exited) return;
    if (!this.closed) {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new CodexAppServerTransportError("codex app-server client shut down"));
      }
      this.pending.clear();
      this.safeCloseStdout();
      try {
        this.child.stdin.end();
      } catch {
        // best effort shutdown
      }
    }
    this.safeKill("SIGTERM");
    const terminated = await this.waitForExit(timeoutMs);
    if (!terminated) {
      this.safeKill("SIGKILL");
      await this.waitForExit(500);
    }
  }

  private write(message: Record<string, unknown>): void {
    const line = `${JSON.stringify(message)}\n`;
    const ok = this.child.stdin.write(line);
    if (!ok) {
      this.onLog?.(`codex app-server stdin backpressure while sending ${String(message.method ?? "response")}`);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      this.onLog?.(`codex app-server emitted malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const record = asRecord(parsed);
    if (!record) return;

    if ("id" in record && ("result" in record || "error" in record)) {
      this.handleResponse(record);
      return;
    }

    if (typeof record.method === "string" && "id" in record) {
      this.write({
        id: record.id,
        error: { code: -32601, message: `First Tree does not handle app-server request ${record.method}` },
      });
      return;
    }

    if (typeof record.method === "string") {
      this.onNotification?.({
        method: record.method,
        ...("params" in record ? { params: record.params } : {}),
      });
    }
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = record.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const pending = this.pending.get(idKey(id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(idKey(id));
    if ("error" in record) {
      pending.reject(new CodexAppServerRpcError(pending.method, parseRpcError(record.error)));
      return;
    }
    pending.resolve(record.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private closeExpectedly(): void {
    this.closed = true;
    this.rejectAll(new CodexAppServerTransportError("codex app-server client shut down"));
  }

  private closeWithError(error: CodexAppServerTransportError): void {
    this.closed = true;
    this.rejectAll(error);
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onClose?.(error);
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.safeCloseStdout();
    const waiters = this.exitWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private safeCloseStdout(): void {
    try {
      this.stdout.close();
    } catch {
      // readline close is idempotent in normal paths; keep shutdown best effort.
    }
  }

  private safeKill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // best effort shutdown
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const waiter = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) this.exitWaiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.exitWaiters.push(waiter);
    });
  }
}

export async function smokeCodexAppServer(binary: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = await CodexAppServerClient.start({
    binary,
    env,
    requestTimeoutMs: 5_000,
  });
  await client.shutdown();
}

export function isCodexAppServerTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (err instanceof CodexAppServerRpcError && err.code === -32001) return true;
  return (
    message.includes("overloaded") ||
    message.includes("retry later") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("epipe") ||
    message.includes("transport is closed")
  );
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function parseRpcError(value: unknown): JsonRpcErrorPayload {
  const record = asRecord(value);
  if (!record) return { message: String(value) };
  return {
    ...(typeof record.code === "number" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...("data" in record ? { data: record.data } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // Narrowing unknown JSON payloads to records is the only practical boundary
  // assertion for the app-server protocol; every field is checked before use.
  return value as Record<string, unknown>;
}
