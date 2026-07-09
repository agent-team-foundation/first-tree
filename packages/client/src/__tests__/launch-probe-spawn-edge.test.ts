import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("runCommand — spawn edge failures", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("returns a spawnError when spawn throws synchronously", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        throw new Error("spawn sync failed");
      },
    }));
    const { runCommand } = await import("../runtime/capabilities/launch-probe.js");

    const result = await runCommand("/bin/tool", ["--version"], { timeoutMs: 1000 });

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      spawnError: "spawn sync failed",
      stdout: "",
      stderr: "",
      timedOut: false,
    });
  });

  it("settles once when the child emits an asynchronous error", async () => {
    const kill = vi.fn();
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        const child = Object.assign(new EventEmitter(), {
          kill,
          stderr: new EventEmitter(),
          stdout: new EventEmitter(),
        });
        queueMicrotask(() => {
          child.emit("error", new Error("spawn async failed"));
          child.emit("close", 0);
        });
        return child;
      },
    }));
    const { runCommand } = await import("../runtime/capabilities/launch-probe.js");

    const result = await runCommand("/bin/tool", ["--version"], { timeoutMs: 1000 });

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      spawnError: "spawn async failed",
      timedOut: false,
    });
    expect(kill).not.toHaveBeenCalled();
  });
});
