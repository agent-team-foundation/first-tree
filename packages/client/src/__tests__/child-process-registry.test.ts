import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetChildProcessRegistryForTests,
  getChildProcessRegistry,
} from "../runtime/child-process-registry.js";

const SLEEP_BIN = "/bin/sleep";

describe("ChildProcessRegistry", () => {
  beforeEach(() => {
    _resetChildProcessRegistryForTests();
  });

  afterEach(async () => {
    await getChildProcessRegistry().killAll("test-cleanup");
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
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000);",
    ]);
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
});
