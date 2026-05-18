import { describe, expect, it } from "vitest";
import { extractMentions, scanMentionTokens } from "../mentions.js";
import type { ChatParticipantDetail } from "../schemas/chat.js";

/**
 * `extractMentions` is the "@<name> → agentId[]" resolver used by both the
 * server's fan-out router and the claude-code handler's auto-forward (see
 * proposals/hub-agent-messaging-reply-and-mentions §4). Every test here pins
 * one of the three defensive gates so a future refactor can't silently drop one.
 */

function mkParticipant(
  name: string | null,
  agentId: string,
  extras: Partial<ChatParticipantDetail> = {},
): ChatParticipantDetail {
  return {
    agentId,
    role: extras.role ?? "member",
    mode: extras.mode ?? "full",
    joinedAt: extras.joinedAt ?? new Date().toISOString(),
    name,
    // ChatParticipantDetail.displayName is non-null post-Phase 2, so fall
    // back to a synthetic label when the extras don't provide one.
    displayName: extras.displayName ?? `agent-${agentId}`,
    type: extras.type ?? "autonomous_agent",
    avatarColorToken: extras.avatarColorToken ?? null,
    avatarImageUrl: extras.avatarImageUrl ?? null,
  };
}

describe("extractMentions", () => {
  const participants = [
    mkParticipant("alice", "agent-alice"),
    mkParticipant("bob", "agent-bob"),
    mkParticipant("charlie-07", "agent-charlie"),
    mkParticipant(null, "agent-nameless"),
  ];

  it("resolves @<name> to agentId when the name exists among participants", () => {
    expect(extractMentions("hey @alice can you help?", participants)).toEqual(["agent-alice"]);
  });

  it("is case-insensitive on the participant name", () => {
    expect(extractMentions("@ALICE and @BoB", participants)).toEqual(
      expect.arrayContaining(["agent-alice", "agent-bob"]),
    );
  });

  it("drops @tokens that don't match a participant (gate 3 — cross-validation)", () => {
    expect(extractMentions("@nobody please handle", participants)).toEqual([]);
  });

  it("never matches participants whose name is null", () => {
    expect(extractMentions("@nameless please", participants)).toEqual([]);
  });

  it("returns empty array when no participant has a name", () => {
    expect(extractMentions("@alice", [mkParticipant(null, "x")])).toEqual([]);
  });

  it("does not match email addresses (gate 2 — word boundary)", () => {
    // `alice@example.com` would falsely activate alice in a naive scanner.
    expect(extractMentions("contact alice@example.com for details", participants)).toEqual([]);
  });

  it("does not match @tokens inside fenced code blocks (gate 1 — strip code)", () => {
    const content = "prelude\n```\n@alice example\n```\nafter";
    expect(extractMentions(content, participants)).toEqual([]);
  });

  it("does not match @tokens inside tilde code blocks", () => {
    const content = "~~~\n@alice\n~~~";
    expect(extractMentions(content, participants)).toEqual([]);
  });

  it("does not match @tokens inside inline code spans", () => {
    expect(extractMentions("use `@alice` literally", participants)).toEqual([]);
  });

  it("still matches @tokens outside code blocks when the same name appears inside", () => {
    // The strip step is non-greedy so we don't accidentally consume the rest of the doc.
    const content = "```\n@alice stays in code\n```\nbut @bob is a real ping";
    expect(extractMentions(content, participants)).toEqual(["agent-bob"]);
  });

  it("does not match @@name (double-@ prefix — not a real mention)", () => {
    expect(extractMentions("@@alice was here", participants)).toEqual([]);
  });

  it("handles hyphen-containing participant names", () => {
    expect(extractMentions("@charlie-07 check stats", participants)).toEqual(["agent-charlie"]);
  });

  it("deduplicates repeated mentions", () => {
    expect(extractMentions("@alice @alice @alice", participants)).toEqual(["agent-alice"]);
  });

  it("merges multiple distinct mentions preserving unique agentIds", () => {
    const out = extractMentions("@alice please loop in @bob", participants);
    expect(out.sort()).toEqual(["agent-alice", "agent-bob"]);
  });
});

describe("scanMentionTokens", () => {
  it("returns every @token that survives the code-strip pass, lowercased", () => {
    const out = scanMentionTokens("@Alice and @bob_07 but `@hidden`");
    // Inline code strips `@hidden`; alice lowercased; bob_07 preserved (underscore allowed).
    expect(out).toEqual(["alice", "bob_07"]);
  });

  it("still scans tokens that don't match any participant — useful for warn logs", () => {
    expect(scanMentionTokens("@ghost")).toEqual(["ghost"]);
  });
});
