import { describe, expect, it } from "vitest";
import { extractMentions, scanMentionTokens, segmentMentions } from "../mentions.js";
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
    type: extras.type ?? "agent",
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

  it("does not match npm scoped package names (`@scope/pkg`)", () => {
    // The composer's pre-flight check uses the same regex; without the
    // trailing `/`-rejecting lookahead, `npm i first-tree`
    // would surface `agent-team-foundation` as an unresolved mention token
    // and block the send. Defend the npm-scope shape for the participant
    // names too — `@alice/foo` is not a mention of alice.
    expect(extractMentions("npm i first-tree", participants)).toEqual([]);
    expect(extractMentions("see @alice/foo for details", participants)).toEqual([]);
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

  it("ignores npm scoped package names entirely (no partial-prefix backtrack)", () => {
    // Without the strict trailing lookahead the engine backtracked the greedy
    // `[A-Za-z0-9_-]{0,63}` and surfaced `agent-team-` as a partial-match
    // mention token of `@agent-team-foundation/...`. Pin both forms.
    expect(scanMentionTokens("npm i first-tree-shared")).toEqual([]);
    expect(scanMentionTokens("@alice/foo and @bob/bar")).toEqual([]);
  });
});

describe("segmentMentions", () => {
  const participants = [
    mkParticipant("alice", "agent-alice"),
    mkParticipant("bob", "agent-bob"),
    mkParticipant("charlie-07", "agent-charlie"),
  ];

  it("returns a single text segment when there are no mentions", () => {
    expect(segmentMentions("hello world", participants)).toEqual([{ kind: "text", value: "hello world" }]);
  });

  it("returns an empty array for empty content", () => {
    expect(segmentMentions("", participants)).toEqual([]);
  });

  it("splits a body with one mention into text-mention-text", () => {
    expect(segmentMentions("hey @alice please look", participants)).toEqual([
      { kind: "text", value: "hey " },
      { kind: "mention", value: "@alice", name: "alice", agentId: "agent-alice" },
      { kind: "text", value: " please look" },
    ]);
  });

  it("preserves original case in the mention value (no lowercase rewriting)", () => {
    expect(segmentMentions("@ALICE", participants)).toEqual([
      { kind: "mention", value: "@ALICE", name: "alice", agentId: "agent-alice" },
    ]);
  });

  it("keeps unresolved @tokens inside the surrounding text segment", () => {
    expect(segmentMentions("@ghost and @alice", participants)).toEqual([
      { kind: "text", value: "@ghost and " },
      { kind: "mention", value: "@alice", name: "alice", agentId: "agent-alice" },
    ]);
  });

  it("does not split inside an email address", () => {
    expect(segmentMentions("ping alice@example.com", participants)).toEqual([
      { kind: "text", value: "ping alice@example.com" },
    ]);
  });

  it("does not split on npm scoped package names", () => {
    expect(segmentMentions("install @alice/foo today", participants)).toEqual([
      { kind: "text", value: "install @alice/foo today" },
    ]);
  });

  it("handles back-to-back mentions with no text between", () => {
    expect(segmentMentions("@alice @bob hi", participants)).toEqual([
      { kind: "mention", value: "@alice", name: "alice", agentId: "agent-alice" },
      { kind: "text", value: " " },
      { kind: "mention", value: "@bob", name: "bob", agentId: "agent-bob" },
      { kind: "text", value: " hi" },
    ]);
  });

  it("preserves character offsets — concatenated values rebuild the source", () => {
    // This is the contract the composer mirror overlay relies on: the
    // overlay text must equal the textarea text byte-for-byte so caret /
    // selection alignment stays correct.
    const source = "  hey @alice — and @charlie-07!  ";
    const rebuilt = segmentMentions(source, participants)
      .map((s) => s.value)
      .join("");
    expect(rebuilt).toBe(source);
  });

  // The next batch pins the agreement with `extractMentions` on code
  // regions — without this, the composer paints chips for tokens the
  // server's resolver would drop, and the user sees "chip + send
  // disabled" with no explanation (PR 597 review #1).
  it("does not chip @tokens inside inline backtick spans", () => {
    expect(segmentMentions("use `@alice` literally", participants)).toEqual([
      { kind: "text", value: "use `@alice` literally" },
    ]);
  });

  it("does not chip @tokens inside fenced ``` blocks", () => {
    const source = "```\n@alice in code\n```\nhey @bob";
    expect(segmentMentions(source, participants)).toEqual([
      { kind: "text", value: "```\n@alice in code\n```\nhey " },
      { kind: "mention", value: "@bob", name: "bob", agentId: "agent-bob" },
    ]);
  });

  it("does not chip @tokens inside tilde ~~~ blocks", () => {
    const source = "~~~\n@alice example\n~~~";
    expect(segmentMentions(source, participants)).toEqual([{ kind: "text", value: source }]);
  });

  it("byte-for-byte invariant holds even when code regions suppress mentions", () => {
    const source = "before `@alice` middle @bob ```\n@charlie-07\n``` after @alice";
    const rebuilt = segmentMentions(source, participants)
      .map((s) => s.value)
      .join("");
    expect(rebuilt).toBe(source);
  });
});
