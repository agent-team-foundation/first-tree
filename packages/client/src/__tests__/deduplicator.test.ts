import { describe, expect, it } from "vitest";
import { Deduplicator } from "../runtime/deduplicator.js";

describe("Deduplicator", () => {
  it("returns false for first occurrence", () => {
    const dedup = new Deduplicator();
    expect(dedup.isDuplicate("msg-1")).toBe(false);
  });

  it("returns true for duplicate", () => {
    const dedup = new Deduplicator();
    dedup.isDuplicate("msg-1");
    expect(dedup.isDuplicate("msg-1")).toBe(true);
  });

  it("tracks multiple distinct IDs", () => {
    const dedup = new Deduplicator();
    expect(dedup.isDuplicate("a")).toBe(false);
    expect(dedup.isDuplicate("b")).toBe(false);
    expect(dedup.isDuplicate("a")).toBe(true);
    expect(dedup.isDuplicate("b")).toBe(true);
    expect(dedup.size).toBe(2);
  });

  it("evicts oldest entries when capacity is reached", () => {
    const dedup = new Deduplicator(3);
    dedup.isDuplicate("a");
    dedup.isDuplicate("b");
    dedup.isDuplicate("c");
    expect(dedup.size).toBe(3);

    // Adding a 4th evicts "a" (oldest). State: [b, c, d]
    dedup.isDuplicate("d");
    expect(dedup.size).toBe(3);
    expect(dedup.isDuplicate("c")).toBe(true); // "c" still present
    expect(dedup.isDuplicate("d")).toBe(true); // "d" still present
    // "a" was evicted — re-adding it is not a duplicate (evicts "b"). State: [c, d, a]
    expect(dedup.isDuplicate("a")).toBe(false);
    expect(dedup.size).toBe(3);
  });

  it("dropByPrefix removes only matching keys and frees capacity", () => {
    // Used by SessionManager's LRU eviction path to drop the evicted
    // chat's dedup keys synchronously with `inFlightEntries.delete`.
    // Without this, a bind-reset redelivery for the evicted chat would
    // mis-route to the dispatch dedup short-circuit and break the
    // documented "fresh session" recovery path.
    const dedup = new Deduplicator(5);
    dedup.isDuplicate("chat-a:msg-1");
    dedup.isDuplicate("chat-a:msg-2");
    dedup.isDuplicate("chat-b:msg-1");
    dedup.isDuplicate("chat-a:msg-3");
    dedup.isDuplicate("chat-b:msg-2");
    expect(dedup.size).toBe(5);

    dedup.dropByPrefix("chat-a:");

    // All chat-a keys are gone; chat-b keys are preserved.
    expect(dedup.size).toBe(2);
    expect(dedup.isDuplicate("chat-b:msg-1")).toBe(true);
    expect(dedup.isDuplicate("chat-b:msg-2")).toBe(true);
    // Re-adding chat-a keys is treated as first-occurrence — the fresh
    // session can process them again.
    expect(dedup.isDuplicate("chat-a:msg-1")).toBe(false);
    expect(dedup.isDuplicate("chat-a:msg-2")).toBe(false);
    expect(dedup.isDuplicate("chat-a:msg-3")).toBe(false);
  });

  it("dropByPrefix preserves FIFO order of remaining keys (capacity-evict-oldest still works)", () => {
    // The internal `order` array is what drives capacity eviction. After
    // a dropByPrefix the remaining keys must keep their original relative
    // order so the next over-capacity insert evicts the genuinely-oldest
    // surviving key.
    const dedup = new Deduplicator(3);
    dedup.isDuplicate("chat-a:1"); // oldest
    dedup.isDuplicate("chat-b:1");
    dedup.isDuplicate("chat-a:2"); // newest

    dedup.dropByPrefix("chat-a:");
    expect(dedup.size).toBe(1);

    // Refill to capacity, then overflow — the oldest surviving key
    // ("chat-b:1") must be the one evicted.
    dedup.isDuplicate("chat-c:1");
    dedup.isDuplicate("chat-d:1");
    expect(dedup.size).toBe(3);
    dedup.isDuplicate("chat-e:1"); // evicts the oldest remaining ("chat-b:1")

    // Order matters: assert survivors first (true-returning calls don't
    // mutate state), then assert the evicted "chat-b:1" last (a false
    // return path re-inserts it, but we don't read the dedup after that).
    expect(dedup.isDuplicate("chat-c:1")).toBe(true);
    expect(dedup.isDuplicate("chat-d:1")).toBe(true);
    expect(dedup.isDuplicate("chat-e:1")).toBe(true);
    expect(dedup.isDuplicate("chat-b:1")).toBe(false);
  });

  it("dropByPrefix is a no-op on an empty set", () => {
    const dedup = new Deduplicator();
    dedup.dropByPrefix("chat-a:");
    expect(dedup.size).toBe(0);
  });

  it("handles capacity of 1", () => {
    const dedup = new Deduplicator(1);
    dedup.isDuplicate("a");
    expect(dedup.isDuplicate("a")).toBe(true);

    // Adding "b" evicts "a". State: [b]
    expect(dedup.isDuplicate("b")).toBe(false);
    expect(dedup.size).toBe(1);
    // "a" is no longer tracked
    expect(dedup.isDuplicate("a")).toBe(false); // re-added, evicts "b". State: [a]
  });
});
