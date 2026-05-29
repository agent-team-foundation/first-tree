import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetChildProcessRegistryForTests, getChildProcessRegistry } from "../runtime/child-process-registry.js";

const SLEEP_BIN = "/bin/sleep";

type FakeChild = ChildProcess & {
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
  emit(eventName: "exit" | "error", ...args: unknown[]): boolean;
};

function makeFakeChild(options: { pid?: number; killImpl?: (signal?: NodeJS.Signals) => boolean } = {}): FakeChild {
  const emitter = new EventEmitter();
  const kill = vi.fn((signal?: NodeJS.Signals) => options.killImpl?.(signal) ?? true);
  return Object.assign(emitter, { pid: options.pid, kill }) as unknown as FakeChild;
}

describe("ChildProcessRegistry", () => {
  beforeEach(() => {
    _resetChildProcessRegistryForTests();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await getChildProcessRegistry().killAll("test-cleanup");
    vi.restoreAllMocks();
  });

  it("registers spawned children and drops them on exit", async () => {
    const registry = getChildProcessRegistry();
    const { record } = registry.spawn(SLEEP_BIN, ["0.05"], { category: "other", label: "sleep 50ms" });
    expect(registry.list()).toHaveLength(1);
    expect(record.category).toBe("other");
    await record.exited;
    expect(registry.list()).toHaveLength(0);
  });

  it("killAll terminates long-running children", async () => {
    const registry = getChildProcessRegistry();
    const a = registry.spawn(SLEEP_BIN, ["60"], { category: "other", label: "sleep a" });
    const b = registry.spawn(SLEEP_BIN, ["60"], { category: "other", label: "sleep b" });
    expect(registry.list()).toHaveLength(2);

    const start = Date.now();
    await registry.killAll("shutdown");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000);

    // Children should be reaped from the registry by their own exit handlers.
    await Promise.race([
      Promise.all([a.record.exited, b.record.exited]),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    expect(registry.list()).toHaveLength(0);
  });

  it("timeoutMs escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const registry = getChildProcessRegistry();
    // `node` subprocess that traps SIGTERM and stays alive — we use a small
    // inline script so the test does not need extra fixtures.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setTimeout(() => {}, 60000);"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const stdout = child.stdout;
    if (!stdout) throw new Error("child stdout unavailable");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not become ready")), 5_000);
      const onError = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      stdout.once("data", () => {
        clearTimeout(timer);
        child.off("error", onError);
        resolve();
      });
      child.once("error", onError);
    });
    const record = registry.adopt(child, {
      category: "other",
      label: "ignore-sigterm",
      timeoutMs: 200,
      cleanup: { firstSignal: "SIGTERM", gracePeriodMs: 300, finalSignal: "SIGKILL" },
    });
    const start = Date.now();
    await record.exited;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(5_000);
    expect(registry.list()).toHaveLength(0);
  });

  it("adopt registers an externally spawned child", async () => {
    const registry = getChildProcessRegistry();
    const child = spawn(SLEEP_BIN, ["0.05"]);
    registry.adopt(child, { category: "other", label: "adopted sleep" });
    expect(registry.list().map((r) => r.label)).toContain("adopted sleep");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // exit handler in registry is once, so it runs even when adopt() set up
    // its own listener.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(registry.list()).toHaveLength(0);
  });

  it("list can be filtered by category", () => {
    const registry = getChildProcessRegistry();
    registry.spawn(SLEEP_BIN, ["0.1"], { category: "git", label: "git op" });
    registry.spawn(SLEEP_BIN, ["0.1"], { category: "npm-install", label: "npm op" });
    expect(registry.list({ category: "git" })).toHaveLength(1);
    expect(registry.list({ category: "npm-install" })).toHaveLength(1);
  });

  it("kill on a registered child triggers exit", async () => {
    const registry = getChildProcessRegistry();
    const { record } = registry.spawn(SLEEP_BIN, ["60"], { category: "other", label: "kill me" });
    record.kill("SIGTERM");
    await record.exited;
    expect(registry.list()).toHaveLength(0);
  });

  it("unregister drops a child and clears its timeout", () => {
    vi.useFakeTimers();
    const registry = getChildProcessRegistry();
    const child = makeFakeChild({ pid: 4242 });
    registry.adopt(child, { category: "other", label: "fake", timeoutMs: 100 });

    registry.unregister(4242);
    registry.unregister(4242);
    vi.advanceTimersByTime(1000);

    expect(registry.list()).toHaveLength(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("uses synthetic negative pids for children without a numeric pid", () => {
    const registry = getChildProcessRegistry();
    const child = makeFakeChild();

    const record = registry.adopt(child, { category: "other", label: "synthetic" });
    child.emit("exit", 0, null);

    expect(record.pid).toBeLessThan(0);
  });

  it("tolerates an exit before the exited promise resolver is installed", () => {
    const registry = getChildProcessRegistry();
    const child = makeFakeChild({ pid: 4243 });
    const originalPromise = globalThis.Promise;
    function SilentPromise<T>(
      _executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void,
    ): void {
      void _executor;
    }

    try {
      Object.defineProperty(globalThis, "Promise", { configurable: true, value: SilentPromise });
      registry.adopt(child, { category: "other", label: "silent promise" });
    } finally {
      Object.defineProperty(globalThis, "Promise", { configurable: true, value: originalPromise });
    }

    expect(() => child.emit("exit", 0, null)).not.toThrow();
    expect(registry.list()).toHaveLength(0);
  });

  it("record.kill defaults to SIGTERM and swallows already-dead errors", async () => {
    const registry = getChildProcessRegistry();
    const child = makeFakeChild({ pid: 5001 });
    const record = registry.adopt(child, { category: "other", label: "default kill" });

    record.kill();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    const throwingChild = makeFakeChild({
      pid: 5002,
      killImpl: () => {
        throw new Error("already dead");
      },
    });
    const throwingRecord = registry.adopt(throwingChild, { category: "other", label: "throwing kill" });
    expect(() => throwingRecord.kill()).not.toThrow();
    child.emit("exit", 0, null);
    throwingChild.emit("exit", 0, null);

    await Promise.all([record.exited, throwingRecord.exited]);
  });

  it("timeout cleanup uses the default policy and ignores kill errors", async () => {
    vi.useFakeTimers();
    const registry = getChildProcessRegistry();
    let calls = 0;
    const child = makeFakeChild({
      pid: 6001,
      killImpl: () => {
        calls += 1;
        throw new Error(`kill ${calls}`);
      },
    });
    const record = registry.adopt(child, { category: "other", label: "timeout", timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", 0, null);
    await record.exited;
  });

  it("killAll ignores first-signal failures when the child exits", async () => {
    const registry = getChildProcessRegistry();
    const child = makeFakeChild({
      pid: 7001,
      killImpl: () => {
        throw new Error("no such process");
      },
    });
    const record = registry.adopt(child, { category: "other", label: "killAll throw" });

    const done = registry.killAll("shutdown");
    child.emit("exit", 0, null);

    await expect(done).resolves.toBeUndefined();
    await record.exited;
  });

  it("killAll escalates to SIGKILL when a child survives the grace window", async () => {
    vi.useFakeTimers();
    const registry = getChildProcessRegistry();
    const child = makeFakeChild({ pid: 8001 });
    const record = registry.adopt(child, { category: "other", label: "stubborn" });

    const done = registry.killAll("shutdown");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", 0, null);

    await expect(done).resolves.toBeUndefined();
    await record.exited;
  });

  it("killAll ignores final-signal failures while waiting for exit", async () => {
    vi.useFakeTimers();
    const registry = getChildProcessRegistry();
    const child = makeFakeChild({
      pid: 8002,
      killImpl: (signal) => {
        if (signal === "SIGKILL") {
          throw new Error("final signal denied");
        }
        return true;
      },
    });
    const record = registry.adopt(child, { category: "other", label: "stubborn final" });

    const done = registry.killAll("shutdown");
    await vi.advanceTimersByTimeAsync(5_000);
    child.emit("exit", 0, null);

    await expect(done).resolves.toBeUndefined();
    await record.exited;
  });
});
