import { describe, expect, it } from "vitest";
import { KeyedOperationQueue } from "../utils/keyed-operation-queue.js";

describe("KeyedOperationQueue", () => {
  it("serializes operations for the same key and removes the completed tail", async () => {
    const queue = new KeyedOperationQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("agent-1:chat-1", async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = queue.run("agent-1:chat-1", async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    expect(queue.size).toBe(1);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(queue.size).toBe(0);
  });

  it("removes every completed key", async () => {
    const queue = new KeyedOperationQueue();

    await Promise.all(
      Array.from({ length: 100 }, (_, index) => queue.run(`agent-1:fake-chat-${index}`, async () => {})),
    );

    expect(queue.size).toBe(0);
  });
});
