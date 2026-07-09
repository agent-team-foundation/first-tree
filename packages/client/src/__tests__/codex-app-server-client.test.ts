import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
  isCodexAppServerTransientError,
  smokeCodexAppServer,
} from "../handlers/codex/app-server/client.js";

/**
 * Upper-bound request timeout for the success-path tests, where the `initialize`
 * response is written asynchronously (via `setImmediate`) right after start. A
 * tight value (e.g. 50ms) races that async delivery: under a congested CI event
 * loop the timer can fire before the response is parsed, spuriously failing the
 * test with "request timed out: initialize". These tests are not exercising the
 * timeout — the SIGTERM→SIGKILL escalation they assert is driven by
 * `shutdown(ms)` — so the bound is set generously to remove the race. The
 * dedicated timeout test below intentionally keeps its own tiny value.
 */
const RESPONSE_OK_TIMEOUT_MS = 2_000;

function makeChild(exitOnSignals: readonly NodeJS.Signals[] = []) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
  };
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
  child.killed = false;
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    signals.push(signal);
    child.killed = true;
    if (typeof signal === "string" && exitOnSignals.includes(signal)) {
      setImmediate(() => child.emit("exit", null, signal));
    }
    return true;
  });
  return { child, signals, stderr, stdout };
}

async function startClient(
  childState: ReturnType<typeof makeChild>,
  extra: Partial<Parameters<typeof CodexAppServerClient.start>[0]> = {},
) {
  const startPromise = CodexAppServerClient.start({
    binary: "/tmp/fake-codex",
    requestTimeoutMs: RESPONSE_OK_TIMEOUT_MS,
    spawnProcess: () => childState.child,
    ...extra,
  });
  setImmediate(() => {
    childState.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
  });
  return startPromise;
}

describe("CodexAppServerClient lifecycle", () => {
  it("passes app-server config args to the spawned Codex process", async () => {
    const { child, signals, stdout } = makeChild(["SIGTERM"]);
    let capturedArgs: readonly string[] | null = null;
    const startPromise = CodexAppServerClient.start({
      binary: "/tmp/fake-codex",
      requestTimeoutMs: RESPONSE_OK_TIMEOUT_MS,
      appServerArgs: ["-c", 'permissions={"first-tree-landing-trial" = {}}'],
      spawnProcess: (_command, args) => {
        capturedArgs = args;
        return child;
      },
    });
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    });

    const client = await startPromise;
    await client.shutdown();

    expect(capturedArgs).toEqual(["app-server", "--stdio", "-c", 'permissions={"first-tree-landing-trial" = {}}']);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("cleans up the child process when initialize times out", async () => {
    const { child, signals } = makeChild(["SIGTERM"]);
    const onClose = vi.fn();

    await expect(
      CodexAppServerClient.start({
        binary: "/tmp/fake-codex",
        requestTimeoutMs: 5,
        spawnProcess: () => child,
        onClose,
      }),
    ).rejects.toThrow("codex app-server request timed out: initialize");

    expect(signals).toEqual(["SIGTERM"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("escalates to SIGKILL when SIGTERM does not exit the child", async () => {
    const { child, signals, stdout } = makeChild(["SIGKILL"]);
    const startPromise = CodexAppServerClient.start({
      binary: "/tmp/fake-codex",
      requestTimeoutMs: RESPONSE_OK_TIMEOUT_MS,
      spawnProcess: () => child,
    });
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    });

    const client = await startPromise;
    await client.shutdown(5);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not report an expected shutdown as a transport close", async () => {
    const { child, signals, stderr, stdout } = makeChild(["SIGTERM"]);
    const onClose = vi.fn();
    const startPromise = CodexAppServerClient.start({
      binary: "/tmp/fake-codex",
      requestTimeoutMs: RESPONSE_OK_TIMEOUT_MS,
      spawnProcess: () => child,
      onClose,
    });
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    });

    const client = await startPromise;
    stderr.write("ERROR old tool failure");
    await client.shutdown();

    expect(signals).toEqual(["SIGTERM"]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reports stderr when the app-server exits unexpectedly", async () => {
    const { child, stderr, stdout } = makeChild();
    const onClose = vi.fn();
    const startPromise = CodexAppServerClient.start({
      binary: "/tmp/fake-codex",
      requestTimeoutMs: RESPONSE_OK_TIMEOUT_MS,
      spawnProcess: () => child,
      onClose,
    });
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    });

    await startPromise;
    stderr.write("ERROR unexpected tool failure");
    child.emit("exit", 1, null);

    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0]?.[0].message).toContain(
      "codex app-server exited with code 1. stderr: ERROR unexpected tool failure",
    );
  });

  it("exposes stderr and closed state and rejects pending requests on shutdown", async () => {
    const childState = makeChild(["SIGTERM"]);
    const client = await startClient(childState);

    childState.stderr.write("diagnostic tail");
    const pending = client.request("turn/start", { input: [] });
    const rejected = expect(pending).rejects.toThrow("codex app-server client shut down");
    await client.shutdown();

    expect(client.stderr).toBe("diagnostic tail");
    expect(client.isClosed).toBe(true);
    await rejected;
    expect(childState.signals).toEqual(["SIGTERM"]);
  });

  it("reports child process errors once and rejects pending requests", async () => {
    const childState = makeChild();
    const onClose = vi.fn();
    const client = await startClient(childState, { onClose });
    const pending = client.request("turn/start", { input: [] });

    childState.child.emit("error", new Error("spawn failed"));
    childState.child.emit("error", new Error("second failure"));

    await expect(pending).rejects.toThrow("spawn failed");
    expect(client.isClosed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0]?.[0].message).toBe("spawn failed");
  });

  it("surfaces write failures and logs stdin backpressure", async () => {
    const childState = makeChild(["SIGTERM"]);
    const onLog = vi.fn<(message: string) => void>();
    const client = await startClient(childState, { onLog });
    const write = vi.spyOn(childState.child.stdin, "write");

    write.mockImplementationOnce(() => {
      throw new Error("pipe write failed");
    });
    await expect(client.request("turn/start", { input: [] })).rejects.toThrow("pipe write failed");

    write.mockImplementationOnce(() => false);
    client.notify("client/backpressure");

    expect(onLog).toHaveBeenCalledWith("codex app-server stdin backpressure while sending client/backpressure");
    await client.shutdown();
  });

  it("handles requests without params and rpc errors with sparse payloads", async () => {
    const childState = makeChild(["SIGTERM"]);
    const client = await startClient(childState);

    const noParams = client.request("thread/list");
    childState.stdout.write(`${JSON.stringify({ id: 2, result: { ok: true } })}\n`);
    await expect(noParams).resolves.toEqual({ ok: true });

    const sparseError = client.request("bad/rpc");
    childState.stdout.write(`${JSON.stringify({ id: 3, error: { code: "bad", message: 42 } })}\n`);
    const err = await sparseError.catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(CodexAppServerRpcError);
    expect(err).toMatchObject({
      code: null,
      message: "codex app-server request failed: bad/rpc",
      data: undefined,
    });

    await client.shutdown();
  });

  it("keeps shutdown best-effort when stdio close and kill throw", async () => {
    const childState = makeChild();
    const client = await startClient(childState);
    const internals = client as unknown as { stdout: { close(): void } };
    vi.spyOn(internals.stdout, "close").mockImplementationOnce(() => {
      throw new Error("readline already closed");
    });
    childState.child.stdin.end = vi.fn(() => {
      throw new Error("stdin already closed");
    }) as unknown as typeof childState.child.stdin.end;
    childState.child.kill.mockImplementationOnce(() => {
      throw new Error("kill failed");
    });

    await client.shutdown(1);

    expect(client.isClosed).toBe(true);
  });

  it("smokes a real app-server stdio executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-codex-app-server-smoke-"));
    const binary = join(root, "fake-codex");
    writeFileSync(
      binary,
      [
        "#!/bin/sh",
        "while IFS= read -r line; do",
        '  case "$line" in',
        "    *'\"id\":1'*) printf '%s\\n' '{\"id\":1,\"result\":{}}' ;;",
        "  esac",
        "done",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      await expect(smokeCodexAppServer(binary, { PATH: process.env.PATH })).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies transient transport strings", () => {
    expect(isCodexAppServerTransientError(new CodexAppServerRpcError("turn/start", { code: -32001 }))).toBe(true);
    expect(isCodexAppServerTransientError("server overloaded")).toBe(true);
    expect(isCodexAppServerTransientError("retry later after overload")).toBe(true);
    expect(isCodexAppServerTransientError("request timed out")).toBe(true);
    expect(isCodexAppServerTransientError("timeout waiting for response")).toBe(true);
    expect(isCodexAppServerTransientError("ECONNRESET from app-server")).toBe(true);
    expect(isCodexAppServerTransientError("EPIPE writing request")).toBe(true);
    expect(isCodexAppServerTransientError("transport is closed")).toBe(true);
    expect(isCodexAppServerTransientError("fatal deterministic failure")).toBe(false);
  });
});
