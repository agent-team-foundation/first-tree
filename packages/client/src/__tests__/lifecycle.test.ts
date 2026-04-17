import { describe, expect, it } from "vitest";
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
});
