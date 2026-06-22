import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../handlers/codex/app-server/client.js";

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
      requestTimeoutMs: 50,
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
      requestTimeoutMs: 50,
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
      requestTimeoutMs: 50,
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
