import { describe, expect, it } from "vitest";
import {
  buildMentionInsert,
  type CandidateDivider,
  detectMentionTrigger,
  groupAndSortCandidates,
  type MentionCandidate,
  rankCandidates,
} from "../mention-autocomplete.js";

/** Test helper — build a candidate with only the fields the test cares
 *  about and sensible defaults for the rest. */
function cand(partial: Partial<MentionCandidate> & Pick<MentionCandidate, "agentId">): MentionCandidate {
  return {
    name: partial.agentId,
    displayName: partial.agentId,
    managedByMe: false,
    ...partial,
  };
}

function isDivider(item: MentionCandidate | CandidateDivider): item is CandidateDivider {
  return "divider" in item;
}

/**
 * Pure-function unit tests for the `@mention` trigger detection + insertion
 * logic in chat-view. The React popover is tested via visual regression
 * separately; keeping these helpers pure makes regressions cheap to catch.
 */

describe("detectMentionTrigger", () => {
  it("detects `@` at the start of the buffer", () => {
    expect(detectMentionTrigger("@ali", 4)).toEqual({ triggerIndex: 0, query: "ali" });
  });

  it("detects `@` after whitespace", () => {
    expect(detectMentionTrigger("hi @bo", 6)).toEqual({ triggerIndex: 3, query: "bo" });
  });

  it("lowercases the query so matching is case-insensitive", () => {
    expect(detectMentionTrigger("@ALICE", 6)).toEqual({ triggerIndex: 0, query: "alice" });
  });

  it("returns null when `@` is preceded by an identifier char (email)", () => {
    expect(detectMentionTrigger("alice@example.com", 11)).toBeNull();
  });

  it("returns null when the cursor is not inside an @-word", () => {
    expect(detectMentionTrigger("hello world", 5)).toBeNull();
  });

  it("returns null when the query contains a punctuation break", () => {
    // A space after @alice closes the trigger — cursor after the space is
    // outside the mention.
    expect(detectMentionTrigger("@alice hi", 9)).toBeNull();
  });

  it("returns empty query right after typing `@`", () => {
    expect(detectMentionTrigger("hi @", 4)).toEqual({ triggerIndex: 3, query: "" });
  });
});

describe("buildMentionInsert", () => {
  const candidate: MentionCandidate = {
    agentId: "id-1",
    name: "alice",
    displayName: "Alice Wang",
    managedByMe: false,
  };

  it("replaces `@<query>` with `@<name>` + trailing space", () => {
    const source = "hi @al";
    const trigger = { triggerIndex: 3, query: "al" };
    const result = buildMentionInsert(source, trigger, source.length, candidate);
    expect(result).toEqual({ text: "hi @alice ", cursor: "hi @alice ".length });
  });

  it("keeps existing trailing whitespace instead of doubling it", () => {
    const source = "hi @al world";
    // cursor is just after `@al` (index 6), a space already follows
    const trigger = { triggerIndex: 3, query: "al" };
    const result = buildMentionInsert(source, trigger, 6, candidate);
    expect(result?.text).toBe("hi @alice world");
    expect(result?.cursor).toBe("hi @alice".length);
  });

  it("returns null when candidate has no name (no slug to insert)", () => {
    const source = "hi @al";
    const trigger = { triggerIndex: 3, query: "al" };
    const result = buildMentionInsert(source, trigger, source.length, {
      agentId: "id-x",
      name: null,
      displayName: "No Name",
      managedByMe: false,
    });
    expect(result).toBeNull();
  });

  it("handles empty query (cursor right after `@`)", () => {
    const source = "hi @";
    const trigger = { triggerIndex: 3, query: "" };
    const result = buildMentionInsert(source, trigger, source.length, candidate);
    expect(result).toEqual({ text: "hi @alice ", cursor: "hi @alice ".length });
  });
});

/**
 * Locks in the participant-picker grouping contract: my-managed agents
 * come first, teammates' second, alphabetical within each group, with a
 * divider marker injected only when both groups are non-empty. The
 * [+] dropdown in both the new-chat draft and the existing-chat
 * ParticipantsHeader render dividers from the same helper so they
 * share visual semantics — this test guards that promise.
 */
describe("groupAndSortCandidates", () => {
  it("returns my-managed first, then others, alphabetical within each, with a divider between", () => {
    const input = [
      cand({ agentId: "zoe", managedByMe: true }),
      cand({ agentId: "Bob's Helper", managedByMe: false, name: "bob", displayName: "Bob's Helper" }),
      cand({ agentId: "alice", managedByMe: true }),
      cand({ agentId: "Diana", managedByMe: false, name: "diana", displayName: "Diana" }),
    ];
    const result = groupAndSortCandidates(input);
    expect(result.map((item) => (isDivider(item) ? "---" : item.agentId))).toEqual([
      "alice",
      "zoe",
      "---",
      "Bob's Helper",
      "Diana",
    ]);
  });

  it("omits the divider when only my-managed agents exist", () => {
    const result = groupAndSortCandidates([
      cand({ agentId: "alice", managedByMe: true }),
      cand({ agentId: "bob", managedByMe: true }),
    ]);
    expect(result.some(isDivider)).toBe(false);
    expect(result.map((item) => (isDivider(item) ? "---" : item.agentId))).toEqual(["alice", "bob"]);
  });

  it("omits the divider when only teammates' agents exist", () => {
    const result = groupAndSortCandidates([
      cand({ agentId: "alice", managedByMe: false }),
      cand({ agentId: "bob", managedByMe: false }),
    ]);
    expect(result.some(isDivider)).toBe(false);
    expect(result.map((item) => (isDivider(item) ? "---" : item.agentId))).toEqual(["alice", "bob"]);
  });

  it("returns empty for an empty input", () => {
    expect(groupAndSortCandidates([])).toEqual([]);
  });

  it("inserts exactly one divider at the boundary regardless of group sizes", () => {
    const result = groupAndSortCandidates([
      cand({ agentId: "alice", managedByMe: true }),
      cand({ agentId: "bob", managedByMe: false }),
      cand({ agentId: "carol", managedByMe: false }),
      cand({ agentId: "dan", managedByMe: false }),
    ]);
    const dividerIndices = result.flatMap((item, i) => (isDivider(item) ? [i] : []));
    expect(dividerIndices).toEqual([1]);
  });

  it("treats null displayName / null name without throwing — sorts by what's left", () => {
    const result = groupAndSortCandidates([
      cand({ agentId: "agent-x", managedByMe: false, name: null, displayName: null }),
      cand({ agentId: "agent-y", managedByMe: false, name: "bob", displayName: "Bob" }),
    ]);
    // Both treated as non-empty strings via the `?? ""` fallback; the
    // null-everything row sorts first because "" < "Bob".
    expect(result).toHaveLength(2);
    const first = result[0];
    expect(first).toBeDefined();
    if (first) expect(isDivider(first)).toBe(false);
  });
});

/**
 * Locks in the @-autocomplete ranking contract: with an empty query
 * (just typed `@`), surface caller's own agents at the top. With a
 * non-empty query the user is targeting a specific name — reordering
 * by managedByMe would shuffle matches under their cursor, so the
 * managedByMe signal is intentionally ignored once they've typed.
 */
describe("rankCandidates", () => {
  it("empty query: my-managed first, then alpha within each group, capped at 8", () => {
    const input = [
      cand({ agentId: "zoe", managedByMe: false, displayName: "Zoe" }),
      cand({ agentId: "alice", managedByMe: true, displayName: "Alice" }),
      cand({ agentId: "bob", managedByMe: false, displayName: "Bob" }),
      cand({ agentId: "carl", managedByMe: true, displayName: "Carl" }),
    ];
    const result = rankCandidates(input, "");
    expect(result.map((c) => c.agentId)).toEqual(["alice", "carl", "bob", "zoe"]);
  });

  it("empty query: divider is stripped (popover doesn't render it)", () => {
    const input = [cand({ agentId: "alice", managedByMe: true }), cand({ agentId: "bob", managedByMe: false })];
    const result = rankCandidates(input, "");
    // The result type is MentionCandidate[]; no `"divider" in item` shape.
    for (const item of result) {
      expect("divider" in item).toBe(false);
    }
  });

  it("non-empty query: managedByMe does NOT reorder matches — match score wins", () => {
    const input = [
      // Teammate's "alice" — exact name prefix match (score 0).
      cand({ agentId: "alice", managedByMe: false, name: "alice", displayName: "Alice (theirs)" }),
      // My "altimeter" — name prefix match but a longer name (still score 0, alpha-broken).
      cand({ agentId: "alt", managedByMe: true, name: "altimeter", displayName: "Altimeter (mine)" }),
      // My "carl" — no match at all.
      cand({ agentId: "carl", managedByMe: true, name: "carl", displayName: "Carl (mine)" }),
    ];
    const result = rankCandidates(input, "al");
    // Both match-score-0 rows are returned; the un-related my-managed
    // "carl" is filtered out. Ordering within a tie is alphabetical by
    // displayName — NOT by managedByMe.
    expect(result.map((c) => c.agentId)).toEqual(["alice", "alt"]);
  });

  it("non-empty query: scoring tiers are respected (name-prefix < displayName-prefix < displayName-contains)", () => {
    const input = [
      cand({ agentId: "x", managedByMe: false, name: "x", displayName: "I have a banana" }), // contains
      cand({ agentId: "y", managedByMe: false, name: "y", displayName: "Banana Republic" }), // displayName prefix
      cand({ agentId: "z", managedByMe: false, name: "banana-z", displayName: "Zed" }), // name prefix
    ];
    const result = rankCandidates(input, "banana");
    expect(result.map((c) => c.agentId)).toEqual(["z", "y", "x"]);
  });

  it("non-empty query: name-contains is the lowest-tier fallback (issue 494)", () => {
    // Mirrors the user-perceived gap: typing `@agent-110` against a slug
    // `picker-agent-110` returned nothing pre-fix, because none of the
    // three prior tiers matched (name doesn't start with "agent-110";
    // displayName "Picker Agent 110" has a space, not a hyphen, so the
    // contains check on displayName also fails). Name-substring now
    // catches it.
    const input = [
      cand({ agentId: "noise", name: "unrelated", displayName: "Nothing" }),
      cand({ agentId: "picker-110", name: "picker-agent-110", displayName: "Picker Agent 110" }),
      cand({ agentId: "picker-220", name: "picker-agent-220", displayName: "Picker Agent 220" }),
    ];
    const result = rankCandidates(input, "agent-110");
    expect(result.map((c) => c.agentId)).toEqual(["picker-110"]);
  });

  it("non-empty query: prefix-on-name still outranks the new name-contains tier", () => {
    // Don't regress the prefix-first ordering — `agent` as a query
    // should still float a slug starting with "agent" above an unrelated
    // slug that merely contains "agent" mid-token.
    const input = [
      cand({ agentId: "mid", name: "test-agent-99", displayName: "X" }), // name contains
      cand({ agentId: "pfx", name: "agent-1", displayName: "Y" }), // name prefix — winner
    ];
    const result = rankCandidates(input, "agent");
    expect(result.map((c) => c.agentId)[0]).toBe("pfx");
  });

  it("empty query: caps the popover at 8 entries even when more match", () => {
    const input = Array.from({ length: 12 }, (_, i) =>
      cand({ agentId: `agent-${i.toString().padStart(2, "0")}`, managedByMe: i < 3 }),
    );
    expect(rankCandidates(input, "").length).toBe(8);
  });
});
