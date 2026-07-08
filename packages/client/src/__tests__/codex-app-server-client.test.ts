import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../handlers/codex/app-server/client.js";

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
});
