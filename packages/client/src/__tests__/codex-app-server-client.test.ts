import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../runtime/codex-app-server-client.js";

function makeChild(exitOnSignals: readonly NodeJS.Signals[] = []) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    killed: boolean;
    kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
  };
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const stdout = new PassThrough();
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
  child.killed = false;
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    signals.push(signal);
    child.killed = true;
    if (typeof signal === "string" && exitOnSignals.includes(signal)) {
      setImmediate(() => child.emit("exit", null, signal));
    }
    return true;
  });
  return { child, signals, stdout };
}

describe("CodexAppServerClient lifecycle", () => {
  it("cleans up the child process when initialize times out", async () => {
    const { child, signals } = makeChild(["SIGTERM"]);

    await expect(
      CodexAppServerClient.start({
        binary: "/tmp/fake-codex",
        requestTimeoutMs: 5,
        spawnProcess: () => child,
      }),
    ).rejects.toThrow("codex app-server request timed out: initialize");

    expect(signals).toEqual(["SIGTERM"]);
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
});
