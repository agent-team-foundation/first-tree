import type { ChildProcess } from "node:child_process";
import type { ProviderProcessSupervisor } from "../../runtime/provider-support/index.js";
import { redactErrorPreview } from "../../runtime/provider-support/index.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 20 * 60_000;
const STDERR_LIMIT = 8_000;
const CLOSE_TERM_GRACE_MS = 5_000;
const CLOSE_KILL_WAIT_MS = 5_000;
const LINE_SEPARATOR = "\n";
const LINE_SEPARATOR_CODE = LINE_SEPARATOR.charCodeAt(0);
const CARRIAGE_RETURN_CODE = "\r".charCodeAt(0);
/** Host-issued RPC command names — safe to echo; anything else is `unknown`. */
const PI_RPC_KNOWN_COMMANDS = new Set(["get_state", "prompt", "steer", "abort", "subscribe", "unsubscribe"]);

function describePiRpcCommand(command: string): string {
  return PI_RPC_KNOWN_COMMANDS.has(command) ? command : "unknown";
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export type PiRpcWritePhase = "before_write" | "after_write";

export type PiRpcResponse = {
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
};

export type PiRpcEventCallback = (event: Record<string, unknown>) => void;

export type PiRpcClientOptions = {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  supervisor: ProviderProcessSupervisor;
  label?: string;
  requestTimeoutMs?: number;
  settlementTimeoutMs?: number;
  closeGraceMs?: number;
  onEvent?: PiRpcEventCallback;
  /** Fired after a command line is successfully written to Pi stdin. */
  onCommandWritten?: (command: string) => void;
  onLog?: (message: string) => void;
};

export class PiRpcTransportError extends Error {
  readonly writePhase: PiRpcWritePhase;
  constructor(message: string, writePhase: PiRpcWritePhase = "after_write") {
    super(message);
    this.name = "PiRpcTransportError";
    this.writePhase = writePhase;
  }
}

export class PiRpcProtocolError extends Error {
  readonly writePhase: PiRpcWritePhase;
  constructor(message: string, writePhase: PiRpcWritePhase = "after_write") {
    super(message);
    this.name = "PiRpcProtocolError";
    this.writePhase = writePhase;
  }
}

type PendingRequest = {
  command: string;
  writePhase: PiRpcWritePhase;
  resolve: (value: PiRpcResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SettlementWaiter = {
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Split buffered stdout on LF only. U+2028/U+2029 inside JSON strings are
 * preserved — we never treat them as line boundaries.
 */
export function splitPiJsonlBuffer(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer.charCodeAt(index) !== LINE_SEPARATOR_CODE) continue;
    let end = index;
    if (end > start && buffer.charCodeAt(end - 1) === CARRIAGE_RETURN_CODE) end -= 1;
    if (end > start) frames.push(buffer.slice(start, end));
    start = index + 1;
  }
  return { frames, rest: buffer.slice(start) };
}

/**
 * First Tree V1 Pi native tool surface. Pi 0.83 defaults to only
 * `read,bash,edit,write`; `grep`/`find`/`ls` exist as built-ins but stay off
 * unless `--tools` explicitly enables them. Keep this list as the single
 * source of truth for spawn argv and contract tests.
 *
 * Native `find` acquires the `fd` helper through Pi's own `ensureTool` path.
 * Do not pass `--offline` here: that sets `PI_OFFLINE=1` and blocks helper
 * download on a clean supported install. Version checks and install telemetry
 * are suppressed via {@link applyPiChildEnvControls} instead.
 */
export const PI_V1_NATIVE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/** Forced child-env controls applied after host/payload merge. */
export const PI_FORCED_CHILD_ENV = {
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
} as const;

/**
 * Apply First Tree's Pi child-env contract after host + agent payload merge.
 *
 * - Force `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0` so First Tree launches
 *   do not trigger Pi version checks or install/update telemetry.
 * - Do **not** inject `PI_OFFLINE`. An operator-provided truthy `PI_OFFLINE`
 *   is preserved (advanced offline override); that path requires helpers such
 *   as `fd` to already be available, otherwise Pi's native `find` errors.
 */
export function applyPiChildEnvControls(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    PI_SKIP_VERSION_CHECK: PI_FORCED_CHILD_ENV.PI_SKIP_VERSION_CHECK,
    PI_TELEMETRY: PI_FORCED_CHILD_ENV.PI_TELEMETRY,
  };
}

export function piV1NativeToolsArg(): string {
  return PI_V1_NATIVE_TOOLS.join(",");
}

export function buildPiRpcArgs(input: {
  sessionId: string;
  sessionDir: string;
  skillsDir: string;
  model?: string;
}): string[] {
  const args = [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--skill",
    input.skillsDir,
    "--no-prompt-templates",
    "--no-approve",
    "--tools",
    piV1NativeToolsArg(),
    "--session-id",
    input.sessionId,
    "--session-dir",
    input.sessionDir,
  ];
  if (input.model) args.push("--model", input.model);
  return args;
}

export function isPiRpcBeforeWriteError(error: unknown): boolean {
  return (
    (error instanceof PiRpcTransportError || error instanceof PiRpcProtocolError) && error.writePhase === "before_write"
  );
}

/**
 * Pi RPC commands are the command object itself (`{id, type:"prompt", ...}`),
 * not a wrapped `{type:"request", command, params}` envelope.
 */
export class PiRpcClient {
  private readonly requestTimeoutMs: number;
  private readonly settlementTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly onEvent?: PiRpcEventCallback;
  private readonly onCommandWritten?: (command: string) => void;
  private readonly onLog?: (message: string) => void;
  private child: ChildProcess | null = null;
  private exited: Promise<void> | null = null;
  private processExited = false;
  private stdoutBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private readonly settlementWaiters = new Set<SettlementWaiter>();
  private nextId = 1;
  private closed = false;
  private settledSeen = false;
  private stderrTail = "";
  private fatalError: Error | null = null;
  private promptWriteCount = 0;
  private steerWriteCount = 0;
  private closeTimers = new Set<ReturnType<typeof setTimeout>>();

  private constructor(
    child: ChildProcess,
    exited: Promise<void>,
    options: Pick<
      PiRpcClientOptions,
      "requestTimeoutMs" | "settlementTimeoutMs" | "closeGraceMs" | "onEvent" | "onCommandWritten" | "onLog"
    >,
  ) {
    this.child = child;
    this.exited = exited;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.settlementTimeoutMs = options.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? CLOSE_TERM_GRACE_MS;
    this.onEvent = options.onEvent;
    this.onCommandWritten = options.onCommandWritten;
    this.onLog = options.onLog;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", () => {
      this.failTransport(new PiRpcTransportError("pi rpc child spawn/error", "after_write"));
    });
    child.on("close", (code, signal) => {
      this.processExited = true;
      if (!this.closed) {
        // Never attach stderr tails — they may contain prompts/assistant text.
        const stderrBytes = this.stderrTail.length;
        this.failTransport(
          new PiRpcTransportError(
            `pi rpc exited${code === null ? "" : ` with code ${code}`}${signal ? ` signal ${signal}` : ""}${
              stderrBytes > 0 ? ` stderr_bytes=${stderrBytes}` : ""
            }`,
            "after_write",
          ),
        );
      }
      this.closed = true;
      this.child = null;
    });
  }

  static async start(options: PiRpcClientOptions): Promise<PiRpcClient> {
    const supervised = options.supervisor.spawn({
      command: options.binary,
      args: [...options.args],
      label: options.label ?? "pi rpc",
      options: {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(process.platform === "win32" ? {} : { detached: true }),
      },
    });
    return new PiRpcClient(supervised.child, supervised.exited, options);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get hasSettled(): boolean {
    return this.settledSeen;
  }

  getPromptWriteCount(): number {
    return this.promptWriteCount;
  }

  getSteerWriteCount(): number {
    return this.steerWriteCount;
  }

  clearSettled(): void {
    this.settledSeen = false;
  }

  async request(
    command: string,
    params?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<PiRpcResponse> {
    if (this.fatalError) {
      const error =
        this.fatalError instanceof PiRpcTransportError || this.fatalError instanceof PiRpcProtocolError
          ? this.fatalError
          : new PiRpcTransportError(this.fatalError.message, "before_write");
      if (!(error instanceof PiRpcTransportError) || error.writePhase !== "before_write") {
        throw new PiRpcTransportError(error.message, "before_write");
      }
      throw error;
    }
    if (this.closed || !this.child?.stdin || this.child.stdin.destroyed) {
      throw new PiRpcTransportError("pi rpc transport is closed", "before_write");
    }
    const id = String(this.nextId++);
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The command line was already written; treat timeout as after-write and fence.
        this.failTransport(
          new PiRpcTransportError(`pi rpc request timed out: ${describePiRpcCommand(command)}`, "after_write"),
        );
        reject(new PiRpcTransportError(`pi rpc request timed out: ${describePiRpcCommand(command)}`, "after_write"));
      }, timeoutMs);
      this.pending.set(id, { command, writePhase: "before_write", resolve, reject, timer });
      let writeCommitted = false;
      try {
        const payload: Record<string, unknown> = { id, type: command, ...(params ?? {}) };
        this.writeLine(payload);
        writeCommitted = true;
        if (command === "prompt") this.promptWriteCount += 1;
        if (command === "steer") this.steerWriteCount += 1;
        const pending = this.pending.get(id);
        if (pending) pending.writePhase = "after_write";
        // Bookkeeping after a successful stdin write must never downgrade to
        // before_write — that would unlock FT prompt retry across an entered turn.
        this.onCommandWritten?.(command);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (writeCommitted) {
          const afterWrite =
            (error instanceof PiRpcTransportError || error instanceof PiRpcProtocolError) &&
            error.writePhase === "after_write"
              ? error
              : new PiRpcTransportError(error instanceof Error ? error.message : String(error), "after_write");
          this.failTransport(afterWrite);
          reject(afterWrite);
          return;
        }
        reject(
          error instanceof PiRpcTransportError || error instanceof PiRpcProtocolError
            ? error
            : new PiRpcTransportError(String(error), "before_write"),
        );
      }
    });
  }

  async prompt(message: string): Promise<PiRpcResponse> {
    this.clearSettled();
    return this.request("prompt", { message });
  }

  async steer(message: string): Promise<PiRpcResponse> {
    return this.request("steer", { message });
  }

  async abort(): Promise<PiRpcResponse> {
    return this.request("abort");
  }

  async getState(): Promise<PiRpcResponse> {
    return this.request("get_state");
  }

  waitForSettled(timeoutMs = this.settlementTimeoutMs): Promise<void> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.settledSeen) return Promise.resolve();
    if (this.closed) {
      return Promise.reject(
        this.fatalError ?? new PiRpcTransportError("pi rpc transport closed before settlement", "after_write"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settlementWaiters.delete(waiter);
        const error = new PiRpcTransportError("pi rpc settlement timed out waiting for agent_settled", "after_write");
        this.failTransport(error);
        reject(error);
      }, timeoutMs);
      const waiter: SettlementWaiter = {
        resolve: () => {
          clearTimeout(timer);
          this.settlementWaiters.delete(waiter);
          resolve();
        },
        reject: (reason) => {
          clearTimeout(timer);
          this.settlementWaiters.delete(waiter);
          reject(reason);
        },
        timer,
      };
      this.settlementWaiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.closed && !this.child) return;
    this.closed = true;
    const child = this.child;
    try {
      if (child?.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    } catch {
      // stdin may already be closed.
    }

    if (child && this.exited && !this.processExited) {
      const exited = this.exited;
      const first = await this.raceExit(exited, this.closeGraceMs);
      if (first === "timeout" && !this.processExited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        const second = await this.raceExit(exited, this.closeGraceMs);
        if (second === "timeout" && !this.processExited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          await this.raceExit(exited, CLOSE_KILL_WAIT_MS);
        }
      }
    }

    this.clearCloseTimers();
    this.failAllPending(this.fatalError ?? new PiRpcTransportError("pi rpc transport closed", "after_write"));
    this.failSettlementWaiters(this.fatalError ?? new PiRpcTransportError("pi rpc transport closed", "after_write"));
    this.child = null;
  }

  private raceExit(exited: Promise<void>, ms: number): Promise<"exited" | "timeout"> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: "exited" | "timeout") => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish("timeout"), ms);
      this.closeTimers.add(timer);
      void exited.then(() => {
        clearTimeout(timer);
        this.closeTimers.delete(timer);
        finish("exited");
      });
    });
  }

  private clearCloseTimers(): void {
    for (const timer of this.closeTimers) clearTimeout(timer);
    this.closeTimers.clear();
  }

  private writeLine(payload: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new PiRpcTransportError("pi rpc stdin is not writable", "before_write");
    stdin.write(`${JSON.stringify(payload)}${LINE_SEPARATOR}`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const { frames, rest } = splitPiJsonlBuffer(this.stdoutBuffer);
    this.stdoutBuffer = rest;
    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: string): void {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(frame);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.failTransport(
          new PiRpcProtocolError(`pi rpc non-object JSONL frame (${frame.length} bytes)`, "after_write"),
        );
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      this.failTransport(new PiRpcProtocolError(`pi rpc invalid JSONL frame (${frame.length} bytes)`, "after_write"));
      return;
    }

    if (parsed.type === "response") {
      const id = parsed.id;
      const key = typeof id === "string" || typeof id === "number" ? String(id) : null;
      if (!key) {
        this.failTransport(new PiRpcProtocolError("pi rpc response missing id", "after_write"));
        return;
      }
      const pending = this.pending.get(key);
      if (!pending) {
        // Never log provider-controlled response ids — they may carry private prose.
        this.onLog?.(`pi rpc unmatched response (id_type=${typeof id} id_bytes=${utf8ByteLength(key)})`);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(key);
      const echoed = typeof parsed.command === "string" ? parsed.command : "";
      if (!echoed || echoed !== pending.command) {
        // Command mismatch desynchronizes the stream — fence the whole transport.
        // Emit allow-listed command tokens + byte counts only; never raw echo.
        const detail =
          `pi rpc response command mismatch ` +
          `(expected=${describePiRpcCommand(pending.command)} ` +
          `expected_bytes=${utf8ByteLength(pending.command)} ` +
          `got=${describePiRpcCommand(echoed)} ` +
          `got_bytes=${utf8ByteLength(echoed)})`;
        this.failTransport(new PiRpcProtocolError(detail, "after_write"));
        pending.reject(new PiRpcProtocolError(detail, "after_write"));
        return;
      }
      const success = parsed.success === true;
      const error =
        typeof parsed.error === "string"
          ? parsed.error
          : typeof parsed.message === "string"
            ? parsed.message
            : undefined;
      pending.resolve({
        command: pending.command,
        success,
        ...(error ? { error } : {}),
        ...(parsed.data !== undefined ? { data: parsed.data } : {}),
      });
      return;
    }

    if (typeof parsed.type !== "string") {
      this.failTransport(new PiRpcProtocolError("pi rpc frame missing type", "after_write"));
      return;
    }

    if (parsed.type === "agent_settled") {
      this.settledSeen = true;
      for (const waiter of [...this.settlementWaiters]) waiter.resolve();
    }

    this.onEvent?.(parsed);
  }

  private failTransport(error: Error): void {
    if (!this.fatalError) this.fatalError = error;
    this.closed = true;
    this.failAllPending(error);
    this.failSettlementWaiters(error);
    // Structural diagnostics only — never echo raw provider/frame/stderr prose.
    this.onLog?.(redactErrorPreview(error.message.replace(/[^\x20-\x7E]/g, "?").slice(0, 120), 120));
    const child = this.child;
    if (child && !this.processExited) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private failSettlementWaiters(error: Error): void {
    for (const waiter of [...this.settlementWaiters]) waiter.reject(error);
    this.settlementWaiters.clear();
  }
}
