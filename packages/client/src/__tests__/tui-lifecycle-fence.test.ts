import { describe, expect, it } from "vitest";
import { TuiLifecycleFence } from "../handlers/claude-code-tui/index.js";

describe("TuiLifecycleFence", () => {
  it("makes a stop request visible to an in-flight lifecycle", async () => {
    const fence = new TuiLifecycleFence();
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => {
      release = resolve;
    });

    const lifecycle = fence.run(async () => {
      await prepared;
      return fence.stopRequested ? "stopped-before-turn" : "run-turn";
    });

    expect(fence.active).toBe(lifecycle);
    fence.requestStop();
    expect(fence.stopRequested).toBe(true);

    release();
    await expect(lifecycle).resolves.toBe("stopped-before-turn");
    expect(fence.active).toBeNull();
  });

  it("clears a previous stop request when the next lifecycle begins", async () => {
    const fence = new TuiLifecycleFence();

    fence.requestStop();
    expect(fence.stopRequested).toBe(true);

    await expect(fence.run(async () => fence.stopRequested)).resolves.toBe(false);
    expect(fence.stopRequested).toBe(false);
    expect(fence.active).toBeNull();
  });
});
