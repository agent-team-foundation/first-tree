import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { pino } from "../observability/logger.js";
import { isUnderManagedRoot } from "../runtime/worktree-cleanup.js";

type FakeLsofProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
};

function makeFakeLsofProcess(): FakeLsofProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

function makeLog(): pino.Logger {
  return { debug: vi.fn(), warn: vi.fn() } as unknown as pino.Logger;
}

async function importWithLsofMock(
  proc: FakeLsofProcess,
  exists = true,
): Promise<typeof import("../runtime/worktree-cleanup.js")> {
  vi.resetModules();
  vi.doMock("node:fs", () => ({
    existsSync: () => exists,
    statSync: () => ({ isFile: () => true }),
  }));
  vi.doMock("node:child_process", () => ({
    spawn: vi.fn(() => proc),
  }));
  return await import("../runtime/worktree-cleanup.js");
}

describe("worktree cleanup helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("recognizes paths strictly under managed roots", () => {
    expect(isUnderManagedRoot("/tmp/root/agent/chat/repo", ["/tmp/root"])).toBe(true);
    expect(isUnderManagedRoot("/tmp/root", ["/tmp/root"])).toBe(false);
    expect(isUnderManagedRoot("/tmp/rootish/agent", ["/tmp/root"])).toBe(false);
  });

  it("returns no holders when the path does not exist", async () => {
    const proc = makeFakeLsofProcess();
    const mod = await importWithLsofMock(proc, false);

    await expect(mod.findPidsHoldingPath("/missing")).resolves.toEqual([]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("parses lsof pid output and filters invalid, duplicate, and self pids", async () => {
    const proc = makeFakeLsofProcess();
    const mod = await importWithLsofMock(proc);
    const pending = mod.findPidsHoldingPath("/tmp/worktree");

    proc.stdout.emit("data", `p${process.pid}\np1\npnot-a-number\np123\np123\np124\nnoise\n`);
    proc.stderr.emit("data", "ignored warning");
    proc.emit("close", 0);

    await expect(pending).resolves.toEqual([123, 124]);
  });

  it("returns no holders on lsof spawn errors and non-zero exits", async () => {
    const errorProc = makeFakeLsofProcess();
    const errorMod = await importWithLsofMock(errorProc);
    const log = makeLog();
    const errorPending = errorMod.findPidsHoldingPath("/tmp/worktree", log);
    errorProc.emit("error", new Error("spawn failed"));

    await expect(errorPending).resolves.toEqual([]);
    expect(log.debug).toHaveBeenCalledWith(
      { path: "/tmp/worktree", err: "Error: spawn failed" },
      "lsof spawn failed — assuming no holders",
    );

    const closeProc = makeFakeLsofProcess();
    const closeMod = await importWithLsofMock(closeProc);
    const closePending = closeMod.findPidsHoldingPath("/tmp/worktree", log);
    closeProc.stderr.emit("data", "bad exit");
    closeProc.emit("close", 2);

    await expect(closePending).resolves.toEqual([]);
    expect(log.debug).toHaveBeenCalledWith(
      { path: "/tmp/worktree", exitCode: 2, stderr: "bad exit" },
      "lsof exited non-zero — assuming no holders",
    );
  });

  it("kills lsof and resolves empty on scan timeout", async () => {
    vi.useFakeTimers();
    const proc = makeFakeLsofProcess();
    proc.kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    const mod = await importWithLsofMock(proc);
    const log = makeLog();

    const pending = mod.findPidsHoldingPath("/tmp/worktree", log);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual([]);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(log.warn).toHaveBeenCalledWith(
      { path: "/tmp/worktree", timeoutMs: 5_000 },
      "lsof timed out while scanning worktree holders",
    );
  });

  it("signals holders and reports SIGTERM/SIGKILL failures", async () => {
    vi.useFakeTimers();
    const proc = makeFakeLsofProcess();
    const mod = await importWithLsofMock(proc);
    const log = makeLog();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM" && pid === 333) {
        const err = new Error("term denied");
        Object.assign(err, { code: "EPERM" });
        throw err;
      }
      if (signal === "SIGTERM" && pid === 222) {
        const err = new Error("already gone");
        Object.assign(err, { code: "ESRCH" });
        throw err;
      }
      if (signal === 0 && (pid === 111 || pid === 222)) {
        const err = new Error("not alive");
        Object.assign(err, { code: "ESRCH" });
        throw err;
      }
      if (signal === "SIGKILL" && pid === 555) {
        const err = new Error("gone before kill");
        Object.assign(err, { code: "ESRCH" });
        throw err;
      }
      if (signal === "SIGKILL" && pid === 666) {
        const err = new Error("kill denied");
        Object.assign(err, { code: "EPERM" });
        throw err;
      }
      return true;
    }) as never);

    const pending = mod.killProcessesHoldingPath("/tmp/worktree", log);
    proc.stdout.emit("data", "p111\np222\np333\np444\np555\np666\n");
    proc.emit("close", 0);
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toEqual({
      killed: [111, 222, 444, 555],
      failedToKill: [333, 666],
    });
    expect(killSpy).toHaveBeenCalledWith(444, "SIGKILL");
    expect(log.warn).toHaveBeenCalledWith(
      { path: "/tmp/worktree", pids: [111, 222, 333, 444, 555, 666] },
      "killing processes holding worktree path",
    );
    expect(log.warn).toHaveBeenCalledWith(
      { path: "/tmp/worktree", pid: 333, err: "Error: term denied" },
      "SIGTERM failed",
    );
    expect(log.warn).toHaveBeenCalledWith(
      { path: "/tmp/worktree", pid: 666, err: "Error: kill denied" },
      "SIGKILL failed",
    );
  });

  it("returns early when every SIGTERM attempt fails", async () => {
    const proc = makeFakeLsofProcess();
    const mod = await importWithLsofMock(proc);
    vi.spyOn(process, "kill").mockImplementation((() => {
      const err = new Error("term denied");
      Object.assign(err, { code: "EPERM" });
      throw err;
    }) as never);

    const pending = mod.killProcessesHoldingPath("/tmp/worktree");
    proc.stdout.emit("data", "p777\n");
    proc.emit("close", 0);

    await expect(pending).resolves.toEqual({ killed: [], failedToKill: [777] });
  });
});
