import { describe, expect, it, vi } from "vitest";
import { withWorktreePathLock } from "../runtime/worktree-mutex.js";

describe("withWorktreePathLock", () => {
  it("serializes concurrent work for the same path", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = withWorktreePathLock("/tmp/worktree-a", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
      return "first";
    });
    const second = withWorktreePathLock("/tmp/worktree-a", async () => {
      order.push("second");
      return "second";
    });

    await vi.waitFor(() => {
      expect(order).toEqual(["first:start"]);
    });
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after a previous holder fails", async () => {
    const order: string[] = [];

    const first = withWorktreePathLock("/tmp/worktree-b", async () => {
      order.push("first");
      throw new Error("work failed");
    });
    const second = withWorktreePathLock("/tmp/worktree-b", async () => {
      order.push("second");
      return "ok";
    });

    await expect(first).rejects.toThrow("work failed");
    await expect(second).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });

  it("allows different paths to run concurrently", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = withWorktreePathLock("/tmp/worktree-c", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    const second = withWorktreePathLock("/tmp/worktree-d", async () => {
      order.push("second");
    });

    await second;
    expect(order).toEqual(["first:start", "second"]);
    releaseFirst();
    await first;
    expect(order).toEqual(["first:start", "second", "first:end"]);
  });
});
