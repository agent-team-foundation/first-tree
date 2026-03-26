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
