import { describe, expect, it } from "vitest";
import { buildMentionInsert, detectMentionTrigger, type MentionCandidate } from "../mention-autocomplete.js";

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
  const candidate: MentionCandidate = { agentId: "id-1", name: "alice", displayName: "Alice Wang" };

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
