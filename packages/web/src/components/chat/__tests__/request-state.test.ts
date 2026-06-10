import type { Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  contentStartsWithMention,
  defaultExpanded,
  deriveRequestState,
  findThreadableRequestId,
  isRelatedViewer,
  parseAnswerSelections,
  readCloseReason,
  readRequestPayload,
  readResolution,
} from "../request-state.js";

const ASKER = "agent-asker";
const TARGET = "human-target";
const OTHER = "agent-other";

function msg(over: Partial<Message> & Pick<Message, "id">): Message {
  return {
    chatId: "c1",
    senderId: ASKER,
    format: "text",
    content: "",
    metadata: {},
    inReplyTo: null,
    source: "api",
    createdAt: "2026-06-02T00:00:00.000Z",
    ...over,
  };
}

const request = msg({
  id: "req",
  format: "request",
  metadata: {
    mentions: [TARGET],
    request: { questions: [{ id: "q1", prompt: "Ship?", kind: "single", options: ["yes", "no"] }] },
  },
});

/** A reply carrying the explicit `metadata.resolves` lifecycle signal. */
function resolveMsg(id: string, senderId: string, kind: "answered" | "closed", reason?: string): Message {
  return msg({
    id,
    senderId,
    inReplyTo: "req",
    content: kind === "answered" ? "Ship? → yes" : "withdrawing",
    metadata: { resolves: { request: "req", kind, ...(reason ? { reason } : {}) } },
  });
}

describe("deriveRequestState", () => {
  it("is open with no follow-ups", () => {
    expect(deriveRequestState(request, [request])).toBe("open");
  });

  it("is discussing when a plain threaded reply exists but nothing resolves it", () => {
    // The core "chat about this" guarantee: a discussion turn threaded under the
    // question does NOT prematurely resolve it (inReplyTo is pure threading now).
    const discuss = msg({ id: "d1", senderId: TARGET, inReplyTo: "req", content: "why are you asking?" });
    expect(deriveRequestState(request, [request, discuss])).toBe("discussing");
    const reply = msg({ id: "d2", senderId: ASKER, inReplyTo: "req", content: "because X" });
    expect(deriveRequestState(request, [request, discuss, reply])).toBe("discussing");
  });

  it("is resolved on an explicit answered resolution (from the target)", () => {
    expect(deriveRequestState(request, [request, resolveMsg("r1", TARGET, "answered")])).toBe("resolved");
  });

  it("is resolved when the asking agent answers (chat send --answer)", () => {
    expect(deriveRequestState(request, [request, resolveMsg("r1", ASKER, "answered")])).toBe("resolved");
  });

  it("is closed on an explicit closed resolution (from the asking agent)", () => {
    expect(deriveRequestState(request, [request, resolveMsg("c1", ASKER, "closed", "no longer needed")])).toBe(
      "closed",
    );
  });

  it("resolution survives a prior discussion turn", () => {
    const discuss = msg({ id: "d1", senderId: TARGET, inReplyTo: "req", content: "let me think" });
    expect(deriveRequestState(request, [request, discuss, resolveMsg("r1", TARGET, "answered")])).toBe("resolved");
  });

  it("ignores a `resolves` written by an unauthorized sender (not target/asker)", () => {
    const stray = resolveMsg("s1", OTHER, "answered");
    // The stray still threads under the request → discussing, never resolved.
    expect(deriveRequestState(request, [request, stray])).toBe("discussing");
  });

  it("an unrelated reply (wrong inReplyTo) leaves it open", () => {
    const unrelated = msg({ id: "x", senderId: TARGET, inReplyTo: "other-msg" });
    expect(deriveRequestState(request, [request, unrelated])).toBe("open");
  });
});

describe("readResolution / readCloseReason", () => {
  it("readResolution parses a valid resolves signal", () => {
    expect(readResolution({ resolves: { request: "req", kind: "answered" } })).toEqual({
      request: "req",
      kind: "answered",
    });
    expect(readResolution({ mentions: [TARGET] })).toBeNull();
  });
  it("readCloseReason returns the asker's reason from the closing message", () => {
    const close = resolveMsg("c1", ASKER, "closed", "decided offline");
    expect(readCloseReason(request, [request, close])).toBe("decided offline");
  });
  it("readCloseReason is null when the close carried no reason", () => {
    expect(readCloseReason(request, [request, resolveMsg("c1", ASKER, "closed")])).toBeNull();
  });
  it("readCloseReason is null when the request is not closed", () => {
    expect(readCloseReason(request, [request, resolveMsg("r1", TARGET, "answered")])).toBeNull();
  });
});

describe("isRelatedViewer", () => {
  it("asker and target are related; others are not", () => {
    expect(isRelatedViewer(request, ASKER)).toBe(true);
    expect(isRelatedViewer(request, TARGET)).toBe(true);
    expect(isRelatedViewer(request, OTHER)).toBe(false);
    expect(isRelatedViewer(request, null)).toBe(false);
  });
});

describe("defaultExpanded", () => {
  it("related: open/discussing/resolved expanded, closed collapsed", () => {
    expect(defaultExpanded("open", true)).toBe(true);
    expect(defaultExpanded("discussing", true)).toBe(true);
    expect(defaultExpanded("resolved", true)).toBe(true);
    expect(defaultExpanded("closed", true)).toBe(false);
  });
  it("unrelated: always collapsed", () => {
    expect(defaultExpanded("open", false)).toBe(false);
    expect(defaultExpanded("resolved", false)).toBe(false);
  });
});

describe("readRequestPayload", () => {
  it("parses a valid request payload and applies defaults", () => {
    const p = readRequestPayload(request.metadata);
    expect(p?.questions[0]?.kind).toBe("single");
    expect(p?.questions[0]?.required).toBe(true);
    expect(p?.allowExtra).toBe(false);
  });
  it("returns null for a non-request metadata", () => {
    expect(readRequestPayload({ mentions: [TARGET] })).toBeNull();
  });
});

describe("findThreadableRequestId", () => {
  it("returns the open request id when the reply mentions the asking agent", () => {
    expect(findThreadableRequestId([request], TARGET, [ASKER])).toBe("req");
  });
  it("still threads onto a DISCUSSING request (the chat-about-this back-and-forth)", () => {
    const discuss = msg({ id: "d1", senderId: TARGET, inReplyTo: "req", content: "why?" });
    expect(findThreadableRequestId([request, discuss], TARGET, [ASKER])).toBe("req");
  });
  it("returns null when the asking agent is not mentioned", () => {
    expect(findThreadableRequestId([request], TARGET, [OTHER])).toBeNull();
  });
  it("returns null when the viewer is not the target", () => {
    expect(findThreadableRequestId([request], OTHER, [ASKER])).toBeNull();
  });
  it("returns null once the request is explicitly resolved", () => {
    expect(findThreadableRequestId([request, resolveMsg("r1", TARGET, "answered")], TARGET, [ASKER])).toBeNull();
  });
  it("returns null once the asker has closed the request", () => {
    expect(findThreadableRequestId([request, resolveMsg("c1", ASKER, "closed")], TARGET, [ASKER])).toBeNull();
  });
});

describe("parseAnswerSelections", () => {
  it("maps prompts to answers from a structured reply", () => {
    const sel = parseAnswerSelections("Ship?  →  yes\nWhen? → now", ["Ship?", "When?"]);
    expect(sel).toEqual({ "Ship?": "yes", "When?": "now" });
  });
  it("ignores lines whose prompt is unknown", () => {
    expect(parseAnswerSelections("Other? → x", ["Ship?"])).toEqual({});
  });
  it("returns {} for free-form (non-matching) content", () => {
    expect(parseAnswerSelections("let's just do 5%", ["Ship?"])).toEqual({});
    expect(parseAnswerSelections(42, ["Ship?"])).toEqual({});
  });
});

describe("contentStartsWithMention", () => {
  it("detects a leading server-normalised @target (case-insensitive)", () => {
    expect(contentStartsWithMention("@gandy please decide", ["gandy"])).toBe(true);
    expect(contentStartsWithMention("@Gandy please decide", ["gandy"])).toBe(true);
  });
  it("is false for a MID-body mention — it isn't the leading normalised prefix", () => {
    // The body renders this as a chip, but the chip-dedup only fires for the
    // leading server prefix; a mid-body mention keeps the metadata target.
    expect(contentStartsWithMention("ping @gandy about this", ["gandy"])).toBe(false);
  });
  it("is false for non-chippable leading tokens the renderer skips (codex R1/R5)", () => {
    // rehypeMentions skips <code>/<pre>/<a>; a raw anywhere-scan would wrongly
    // report these. Leading-only detection never trips on them.
    expect(contentStartsWithMention("`@gandy` is in inline code", ["gandy"])).toBe(false);
    expect(contentStartsWithMention("```\n@gandy\n```", ["gandy"])).toBe(false);
    expect(contentStartsWithMention("[@gandy](https://x) link text", ["gandy"])).toBe(false);
  });
  it("is false when the leading mention is a different participant", () => {
    expect(contentStartsWithMention("@someone-else heads up", ["gandy"])).toBe(false);
  });
  it("respects MENTION_REGEX boundaries — @gandy/notes is not a mention", () => {
    expect(contentStartsWithMention("@gandy/notes is the file", ["gandy"])).toBe(false);
  });
  it("is false for non-string content or empty names", () => {
    expect(contentStartsWithMention(42, ["gandy"])).toBe(false);
    expect(contentStartsWithMention("@gandy hi", [])).toBe(false);
  });
});
