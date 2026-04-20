import type { PulseBucket } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it } from "vitest";
import { aggregate, EMPTY_BUCKETS } from "../pulse-aggregate.js";

function makeBuckets(pattern: Array<[number, boolean]>): PulseBucket[] {
  const out: PulseBucket[] = [];
  for (let i = 0; i < 32; i++) {
    const p = pattern[i] ?? [0, false];
    out.push({ workingCount: p[0], errorMask: p[1] });
  }
  return out;
}

describe("pulse aggregate", () => {
  it("EMPTY_BUCKETS is a 32-length zeroed baseline", () => {
    expect(EMPTY_BUCKETS).toHaveLength(32);
    expect(EMPTY_BUCKETS.every((b) => b.workingCount === 0 && !b.errorMask)).toBe(true);
  });

  it("returns 32 zeroed buckets when the agents map is empty", () => {
    const out = aggregate({});
    expect(out).toHaveLength(32);
    expect(out.every((b) => b.workingCount === 0 && !b.errorMask)).toBe(true);
  });

  it("sums workingCount across agents at each index", () => {
    const a = makeBuckets([
      [1, false],
      [2, false],
    ]);
    const b = makeBuckets([
      [3, false],
      [4, false],
    ]);
    const out = aggregate({ a, b });
    expect(out[0]).toEqual({ workingCount: 4, errorMask: false });
    expect(out[1]).toEqual({ workingCount: 6, errorMask: false });
  });

  it("OR's errorMask across agents (any error raises the aggregate mask)", () => {
    const a = makeBuckets([[0, false]]);
    const b = makeBuckets([[0, true]]);
    const out = aggregate({ a, b });
    expect(out[0]?.errorMask).toBe(true);
  });

  it("does not mutate input bucket objects", () => {
    const src = makeBuckets([[5, true]]);
    const snapshot = JSON.parse(JSON.stringify(src));
    aggregate({ a: src });
    expect(src).toEqual(snapshot);
  });

  it("tolerates agents whose bucket array is shorter than 32", () => {
    const out = aggregate({ a: [{ workingCount: 7, errorMask: true }] });
    expect(out[0]).toEqual({ workingCount: 7, errorMask: true });
    expect(out[1]).toEqual({ workingCount: 0, errorMask: false });
    expect(out).toHaveLength(32);
  });

  it("returns a fresh object on every call (no shared reference to EMPTY_BUCKETS)", () => {
    const a = aggregate({});
    const b = aggregate({});
    expect(a).not.toBe(b);
    expect(a).not.toBe(EMPTY_BUCKETS);
  });
});
