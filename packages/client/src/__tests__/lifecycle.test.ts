import { describe, expect, it, vi } from "vitest";
import { _resetForTests, registerShutdownHook, runShutdown } from "../runtime/lifecycle.js";

describe("lifecycle.runShutdown (Step 7)", () => {
  it("runs all registered hooks once, in order", async () => {
    _resetForTests();
    const order: string[] = [];
    registerShutdownHook(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("a-end");
    });
    registerShutdownHook(() => {
      order.push("b");
    });
    await runShutdown();
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("is idempotent", async () => {
    _resetForTests();
    let calls = 0;
    registerShutdownHook(() => {
      calls++;
    });
    await Promise.all([runShutdown(), runShutdown(), runShutdown()]);
    expect(calls).toBe(1);
  });

  it("continues past hook failures", async () => {
    _resetForTests();
    const order: string[] = [];
    registerShutdownHook(() => {
      throw new Error("boom");
    });
    registerShutdownHook(() => {
      order.push("after-failure");
    });
    await runShutdown();
    expect(order).toEqual(["after-failure"]);
  });

  it("unregisters hooks and tolerates duplicate unregister calls", async () => {
    _resetForTests();
    const hook = vi.fn();
    const unregister = registerShutdownHook(hook);

    unregister();
    unregister();
    await runShutdown();

    expect(hook).not.toHaveBeenCalled();
  });

  it("continues when the child process registry sweep fails", async () => {
    vi.resetModules();
    const killAll = vi.fn().mockRejectedValue(new Error("registry failed"));
    vi.doMock("../runtime/child-process-registry.js", () => ({
      getChildProcessRegistry: () => ({ killAll }),
    }));
    const mod = await import("../runtime/lifecycle.js");
    const hook = vi.fn();

    mod.registerShutdownHook(hook);
    await mod.runShutdown();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(killAll).toHaveBeenCalledWith("lifecycle-shutdown");
    vi.doUnmock("../runtime/child-process-registry.js");
    vi.resetModules();
  });

  it("runs shutdown and exits from installed signal handlers", async () => {
    vi.resetModules();
    const callbacks: Partial<Record<NodeJS.Signals, NodeJS.SignalsListener>> = {};
    const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGTERM" || event === "SIGINT") {
        callbacks[event] = listener;
      }
      return process;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const mod = await import("../runtime/lifecycle.js");

    mod.registerShutdownHook(() => {});
    callbacks.SIGTERM?.("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));

    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
    onSpy.mockRestore();
    vi.resetModules();
  });
});
