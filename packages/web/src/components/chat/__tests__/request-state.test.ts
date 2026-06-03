import type { Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  defaultExpanded,
  deriveRequestState,
  findAnswerableRequestId,
  isRelatedViewer,
  isReplacedByNewRequest,
  parseAnswerSelections,
  readRequestPayload,
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

describe("deriveRequestState", () => {
  it("is open with no follow-ups", () => {
    expect(deriveRequestState(request, [request])).toBe("open");
  });

  it("is resolved when the target replies with inReplyTo", () => {
    const reply = msg({ id: "r1", senderId: TARGET, inReplyTo: "req", content: "yes" });
    expect(deriveRequestState(request, [request, reply])).toBe("resolved");
  });

  it("is closed when the asker sends a plain text reply (active close / withdraw)", () => {
    const close = msg({ id: "c1", senderId: ASKER, inReplyTo: "req", content: "Closing this — resolved offline." });
    expect(deriveRequestState(request, [request, close])).toBe("closed");
  });

  it("is closed when the asker supersedes with a new request reply", () => {
    const newQ = msg({
      id: "r2",
      senderId: ASKER,
      format: "request",
      inReplyTo: "req",
      metadata: { mentions: [TARGET] },
    });
    expect(deriveRequestState(request, [request, newQ])).toBe("closed");
  });

  it("resolved outranks closed", () => {
    const newQ = msg({
      id: "r2",
      senderId: ASKER,
      format: "request",
      inReplyTo: "req",
      metadata: { mentions: [TARGET] },
    });
    const reply = msg({ id: "r1", senderId: TARGET, inReplyTo: "req" });
    expect(deriveRequestState(request, [request, newQ, reply])).toBe("resolved");
  });

  it("an unrelated reply (wrong inReplyTo) leaves it open", () => {
    const unrelated = msg({ id: "x", senderId: TARGET, inReplyTo: "other-msg" });
    expect(deriveRequestState(request, [request, unrelated])).toBe("open");
  });
});

describe("isReplacedByNewRequest", () => {
  it("true when the asker superseded with a new request reply", () => {
    const newQ = msg({
      id: "r2",
      senderId: ASKER,
      format: "request",
      inReplyTo: "req",
      metadata: { mentions: [TARGET] },
    });
    expect(isReplacedByNewRequest(request, [request, newQ])).toBe(true);
  });
  it("false for a plain-text active close (withdraw)", () => {
    const close = msg({ id: "c1", senderId: ASKER, inReplyTo: "req", content: "closing" });
    expect(isReplacedByNewRequest(request, [request, close])).toBe(false);
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
  it("related: open/resolved expanded, closed collapsed", () => {
    expect(defaultExpanded("open", true)).toBe(true);
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

describe("findAnswerableRequestId", () => {
  it("returns the open request id when the reply mentions the asking agent", () => {
    expect(findAnswerableRequestId([request], TARGET, [ASKER])).toBe("req");
  });
  it("returns null when the asking agent is not mentioned", () => {
    expect(findAnswerableRequestId([request], TARGET, [OTHER])).toBeNull();
  });
  it("returns null when the viewer is not the target", () => {
    expect(findAnswerableRequestId([request], OTHER, [ASKER])).toBeNull();
  });
  it("returns null once the request is already resolved", () => {
    const reply = msg({ id: "r1", senderId: TARGET, inReplyTo: "req" });
    expect(findAnswerableRequestId([request, reply], TARGET, [ASKER])).toBeNull();
  });
  it("returns null once the asker has actively closed the request", () => {
    const close = msg({ id: "c1", senderId: ASKER, inReplyTo: "req", content: "closing" });
    expect(findAnswerableRequestId([request, close], TARGET, [ASKER])).toBeNull();
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
