import { describe, expect, it } from "vitest";
import { computeRequiresMention } from "../requires-mention.js";

const ME = "me-agent";
const A = "agent-a";
const B = "agent-b";

describe("computeRequiresMention", () => {
  // ── 1-on-1 (the regression first-tree-hub PR 465 introduced) ──────────────
  it("does NOT require a mention in a 1-on-1 where the user is a speaker", () => {
    // human + their assistant: 2 speakers, user is in. After PR 465 every chat
    // is type='group', but a 1-on-1 must still send without an explicit @mention.
    expect(computeRequiresMention([ME, A], ME)).toBe(false);
  });

  it("does NOT require a mention in a 1-on-1 where the user is one of two agents", () => {
    // The current user's own agent id is one of the two speakers (here `A`,
    // not the `ME` constant) — confirms the predicate keys on actual
    // membership, not a hardcoded notion of self.
    expect(computeRequiresMention([A, B], A)).toBe(false);
  });

  // ── real groups (3+ speakers) ─────────────────────────────────────────────
  it("requires a mention in a 3-speaker group the user is in", () => {
    expect(computeRequiresMention([ME, A, B], ME)).toBe(true);
  });

  it("requires a mention in a larger group", () => {
    expect(computeRequiresMention([ME, A, B, "agent-c"], ME)).toBe(true);
  });

  // ── prospective seat: user not yet a speaker ──────────────────────────────
  it("requires a mention when watching a 2-speaker chat (first send makes it 3)", () => {
    // User isn't a member yet; sending promotes them to a 3rd speaker → group.
    expect(computeRequiresMention([A, B], ME)).toBe(true);
  });

  it("does NOT require a mention when joining a single-speaker chat (becomes 1-on-1)", () => {
    expect(computeRequiresMention([A], ME)).toBe(false);
  });

  // ── degenerate / guard cases ──────────────────────────────────────────────
  it("does NOT require a mention in a solo chat the user is in", () => {
    expect(computeRequiresMention([ME], ME)).toBe(false);
  });

  it("treats a null/undefined self as not-yet-a-member (counts the send seat)", () => {
    expect(computeRequiresMention([A, B], null)).toBe(true);
    expect(computeRequiresMention([A], undefined)).toBe(false);
  });

  it("handles an empty participant list", () => {
    expect(computeRequiresMention([], ME)).toBe(false);
  });
});
