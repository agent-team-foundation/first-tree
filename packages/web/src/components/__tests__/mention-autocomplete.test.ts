import { describe, expect, it } from "vitest";
import {
  buildMentionInsert,
  buildPickerSections,
  type CandidateDivider,
  composerPickerVisible,
  detectMentionTrigger,
  fieldOutOfScrollport,
  groupAndSortCandidates,
  type MentionCandidate,
  portalPanelPlacement,
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
  it("empty query: my-managed first, then alpha within each group", () => {
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

  it("empty query: returns every candidate, uncapped (popover scrolls instead of truncating)", () => {
    // Regression lock for the user-reported "list looks incomplete": a
    // prior `.slice(0, 8)` hid the 9th+ addressable agent from the
    // empty-`@` view. The popover is height-capped + scrollable, so the
    // full roster is reachable by scrolling — matching the `[+]` picker,
    // which never capped.
    const input = Array.from({ length: 12 }, (_, i) =>
      cand({ agentId: `agent-${i.toString().padStart(2, "0")}`, managedByMe: i < 3 }),
    );
    const result = rankCandidates(input, "");
    // All 12 surface, mine-first (00/01/02) then alpha — none dropped.
    expect(result.map((c) => c.agentId)).toEqual([
      "agent-00",
      "agent-01",
      "agent-02",
      "agent-03",
      "agent-04",
      "agent-05",
      "agent-06",
      "agent-07",
      "agent-08",
      "agent-09",
      "agent-10",
      "agent-11",
    ]);
  });

  it("non-empty query: returns every match, uncapped", () => {
    // Same no-cap guarantee on the typed path: a substring shared by more
    // than eight agents must surface them all, not silently truncate at 8.
    const input = Array.from({ length: 12 }, (_, i) =>
      cand({ agentId: `team-${i.toString().padStart(2, "0")}`, name: `team-${i.toString().padStart(2, "0")}` }),
    );
    const result = rankCandidates(input, "team");
    expect(result).toHaveLength(12);
  });
});

describe("buildPickerSections", () => {
  it("selectable mirrors the addable rows in `items` walk-order — same source, divider stripped (issue 494 regression lock)", () => {
    // The bug this asserts against: pre-fix, the picker derived
    // `selectable` straight from the caller's `addable` array, while
    // `items` re-grouped/re-sorted via `groupAndSortCandidates`. Render
    // walked `items` to paint highlights; Enter indexed into
    // `selectable`. With mine-first + alphabetical-within-group sorting
    // applied to `addable` (which arrives in arbitrary server order),
    // the highlighted row could differ from the row actually committed
    // on Enter — a wrong-recipient hazard.
    const addable = [
      cand({ agentId: "z-mine", displayName: "Zed", managedByMe: true }), // mine, last alpha
      cand({ agentId: "b-other", displayName: "Bob", managedByMe: false }), // others, alpha-1
      cand({ agentId: "a-mine", displayName: "Alice", managedByMe: true }), // mine, first alpha
      cand({ agentId: "c-other", displayName: "Carol", managedByMe: false }), // others, alpha-2
    ];
    const { items, selectable } = buildPickerSections(addable, []);

    // Render walk-order: every non-divider item in `items`.
    const itemsOrder = items.filter((it): it is MentionCandidate => !isDivider(it));

    // The invariant: same uuids in the same order, regardless of how
    // groupAndSortCandidates chose to sort. If anyone ever derives
    // selectable from a different source, this test fires.
    expect(selectable.map((c) => c.agentId)).toEqual(itemsOrder.map((c) => c.agentId));
    // Belt-and-braces — also lock the actual expected order so a
    // regression in groupAndSortCandidates is caught here too.
    expect(selectable.map((c) => c.agentId)).toEqual(["a-mine", "z-mine", "b-other", "c-other"]);
  });

  it("appends already-in rows under a single divider; only addable rows enter `selectable`", () => {
    const addable = [cand({ agentId: "add-1", displayName: "Add 1" })];
    const alreadyIn = [cand({ agentId: "in-2", displayName: "In 2" }), cand({ agentId: "in-1", displayName: "In 1" })];
    const { items, selectable } = buildPickerSections(addable, alreadyIn);

    // selectable is addable-only — already-in rows are display-only ✓
    // markers that arrow / Enter must skip past.
    expect(selectable.map((c) => c.agentId)).toEqual(["add-1"]);

    // Items: addable rows, then one divider, then already-in rows in
    // the caller-supplied order (caller has already sorted them).
    const dividerCount = items.filter(isDivider).length;
    expect(dividerCount).toBe(1);
    const ids = items.filter((it): it is MentionCandidate => !isDivider(it)).map((c) => c.agentId);
    expect(ids).toEqual(["add-1", "in-2", "in-1"]);
  });

  it("omits the head-vs-tail divider entirely when alreadyIn is empty", () => {
    const addable = [cand({ agentId: "x", displayName: "X" }), cand({ agentId: "y", displayName: "Y" })];
    const { items } = buildPickerSections(addable, []);
    // groupAndSortCandidates puts no internal divider when only one
    // group is non-empty, and buildPickerSections adds no tail divider
    // when alreadyIn is empty — net: zero dividers.
    expect(items.filter(isDivider).length).toBe(0);
  });

  it("returns empty items + empty selectable when both inputs are empty", () => {
    const { items, selectable } = buildPickerSections([], []);
    expect(items).toEqual([]);
    expect(selectable).toEqual([]);
  });
});

describe("composerPickerVisible", () => {
  it("welds when a mention or slash panel is open on a non-trial composer", () => {
    expect(composerPickerVisible({ isTrial: false, mentionOpen: true, slashOpen: false })).toBe(true);
    expect(composerPickerVisible({ isTrial: false, mentionOpen: false, slashOpen: true })).toBe(true);
  });

  it("does not weld when no picker is open", () => {
    expect(composerPickerVisible({ isTrial: false, mentionOpen: false, slashOpen: false })).toBe(false);
  });

  it("never welds on the trial composer, even with a live trigger — trial renders no panel", () => {
    expect(composerPickerVisible({ isTrial: true, mentionOpen: false, slashOpen: true })).toBe(false);
    expect(composerPickerVisible({ isTrial: true, mentionOpen: true, slashOpen: true })).toBe(false);
  });
});

describe("fieldOutOfScrollport", () => {
  const port = { top: 100, bottom: 500 };

  it("is in view while the field overlaps the scrollport", () => {
    expect(fieldOutOfScrollport({ top: 400, bottom: 440 }, port)).toBe(false);
    // partially above the top still counts as in view (some rows visible)
    expect(fieldOutOfScrollport({ top: 80, bottom: 130 }, port)).toBe(false);
    // partially below the bottom still counts as in view
    expect(fieldOutOfScrollport({ top: 470, bottom: 520 }, port)).toBe(false);
  });

  it("is out of view when fully above the scrollport top (dismiss)", () => {
    expect(fieldOutOfScrollport({ top: 40, bottom: 90 }, port)).toBe(true);
    // touching edge (bottom === port.top) counts as out
    expect(fieldOutOfScrollport({ top: 60, bottom: 100 }, port)).toBe(true);
  });

  it("is out of view when fully below the scrollport bottom (dismiss)", () => {
    expect(fieldOutOfScrollport({ top: 540, bottom: 580 }, port)).toBe(true);
    // touching edge (top === port.bottom) counts as out
    expect(fieldOutOfScrollport({ top: 500, bottom: 560 }, port)).toBe(true);
  });
});

describe("portalPanelPlacement", () => {
  const port = { top: 0, bottom: 800 };

  it("clamps max height to the space above the field, capped at 16rem (256)", () => {
    expect(portalPanelPlacement({ field: { top: 60, bottom: 100 }, port, viewportTop: 0 })).toEqual({ maxHeight: 60 });
    // plenty of room above → capped at the 16rem panel max
    expect(portalPanelPlacement({ field: { top: 400, bottom: 440 }, port, viewportTop: 0 })).toEqual({
      maxHeight: 256,
    });
  });

  it("subtracts the visual-viewport top offset from the available space", () => {
    expect(portalPanelPlacement({ field: { top: 120, bottom: 160 }, port, viewportTop: 40 })).toEqual({
      maxHeight: 80,
    });
  });

  it("dismisses (null) when the field is out of its scrollport", () => {
    expect(portalPanelPlacement({ field: { top: 850, bottom: 890 }, port, viewportTop: 0 })).toBeNull();
  });

  it("dismisses (null) when there isn't room above the field for even one row", () => {
    expect(portalPanelPlacement({ field: { top: 30, bottom: 70 }, port, viewportTop: 0 })).toBeNull();
  });
});
