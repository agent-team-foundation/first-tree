import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetChildProcessRegistryForTests, getChildProcessRegistry } from "../runtime/child-process-registry.js";
import { registerShutdownHook, _resetForTests as resetLifecycle, runShutdown } from "../runtime/lifecycle.js";

/**
 * Task 5 — Bug 3 fix: lifecycle.runShutdown sweeps any subprocess tracked by
 * the ChildProcessRegistry after user hooks finish. This is the regression
 * harness for "claude / npm exec @playw / git left in cgroup after stop".
 */
describe("lifecycle.runShutdown — child process cleanup (Bug 3)", () => {
  beforeEach(() => {
    resetLifecycle();
    _resetChildProcessRegistryForTests();
  });

  afterEach(async () => {
    await getChildProcessRegistry().killAll("test-cleanup");
  });

  it("kills tracked subprocesses after user hooks complete", async () => {
    const registry = getChildProcessRegistry();
    // Spawn a long-sleeping subprocess and register it.
    const { record } = registry.spawn("/bin/sleep", ["60"], { category: "git", label: "sleep" });
    expect(registry.list()).toHaveLength(1);

    let hookRan = false;
    registerShutdownHook(() => {
      hookRan = true;
    });

    await runShutdown();
    expect(hookRan).toBe(true);

    // After runShutdown, the registry should be empty.
    expect(registry.list()).toHaveLength(0);
    await record.exited;
  });

  it("survives a user hook that throws and still cleans up children", async () => {
    const registry = getChildProcessRegistry();
    const { record } = registry.spawn("/bin/sleep", ["60"], { category: "other", label: "sleep" });

    registerShutdownHook(() => {
      throw new Error("hook boom");
    });
    let secondHookRan = false;
    registerShutdownHook(() => {
      secondHookRan = true;
    });

    await runShutdown();
    expect(secondHookRan).toBe(true);
    expect(registry.list()).toHaveLength(0);
    await record.exited;
  });

  it("escalates SIGTERM-ignoring children to SIGKILL within the deadline", async () => {
    const registry = getChildProcessRegistry();
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000);"]);
    const record = registry.adopt(child, { category: "claude", label: "ignore-sigterm" });

    const start = Date.now();
    await runShutdown();
    const elapsed = Date.now() - start;

    // Default cleanup policy: 5s grace, then SIGKILL. Allow generous CI
    // headroom but assert we don't blow past 15s.
    expect(elapsed).toBeLessThan(15_000);
    expect(registry.list()).toHaveLength(0);
    await record.exited;
  }, 20_000);
});
