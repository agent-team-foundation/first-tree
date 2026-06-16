import type { AskRequest, Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  allRequiredAnswered,
  buildResolveAnswer,
  contentStartsWithMention,
  defaultExpanded,
  deriveRequestState,
  findBlockingRequest,
  findDockableRequest,
  findThreadableRequestId,
  isRelatedViewer,
  readCloseReason,
  readRequestPayload,
  readResolution,
  recoverSelectedLabels,
} from "../request-state.js";

const ASKER = "agent-asker";
const TARGET = "human-target";
const OTHER = "agent-other";

const OPTIONS = [
  { label: "Ship", description: "ship to 20% now" },
  { label: "Hold", description: "wait another 24h" },
];

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
  content: "Ship the rollout to 20% now?",
  metadata: { mentions: [TARGET], request: { options: OPTIONS } },
});

/** A reply carrying the explicit `metadata.resolves` lifecycle signal. */
function resolveMsg(id: string, senderId: string, kind: "answered" | "closed", reason?: string): Message {
  return msg({
    id,
    senderId,
    inReplyTo: "req",
    content: kind === "answered" ? "Ship" : "withdrawing",
    metadata: { resolves: { request: "req", kind, ...(reason ? { reason } : {}) } },
  });
}

describe("deriveRequestState", () => {
  it("is open with no follow-ups", () => {
    expect(deriveRequestState(request, [request])).toBe("open");
  });
  it("is discussing when a plain threaded reply exists but nothing resolves it", () => {
    const discuss = msg({ id: "d1", senderId: TARGET, inReplyTo: "req", content: "why are you asking?" });
    expect(deriveRequestState(request, [request, discuss])).toBe("discussing");
  });
  it("is resolved on an explicit answered resolution (from the target)", () => {
    expect(deriveRequestState(request, [request, resolveMsg("r1", TARGET, "answered")])).toBe("resolved");
  });
  it("ignores a `resolves` from the asking agent — only the target human resolves", () => {
    // The asker cannot resolve its own question (mirrors the server authz); the
    // signal is ignored and the threaded reply just reads as discussion.
    expect(deriveRequestState(request, [request, resolveMsg("r1", ASKER, "answered")])).toBe("discussing");
  });
  it("ignores a closed `resolves` from the asking agent too", () => {
    expect(deriveRequestState(request, [request, resolveMsg("c1", ASKER, "closed", "no longer needed")])).toBe(
      "discussing",
    );
  });
  it("ignores a `resolves` written by any non-target sender", () => {
    expect(deriveRequestState(request, [request, resolveMsg("s1", OTHER, "answered")])).toBe("discussing");
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
  it("readCloseReason returns the close reason from a closing message (target-authored)", () => {
    // `closed` is a legacy/server-only kind; only the target may write a
    // resolution, so a close that carries a reason reads it back.
    expect(readCloseReason(request, [request, resolveMsg("c1", TARGET, "closed", "decided offline")])).toBe(
      "decided offline",
    );
  });
  it("readCloseReason is null when the close carried no reason / not closed", () => {
    expect(readCloseReason(request, [request, resolveMsg("c1", TARGET, "closed")])).toBeNull();
    expect(readCloseReason(request, [request, resolveMsg("r1", TARGET, "answered")])).toBeNull();
  });
});

describe("isRelatedViewer / defaultExpanded", () => {
  it("asker and target are related; others are not", () => {
    expect(isRelatedViewer(request, ASKER)).toBe(true);
    expect(isRelatedViewer(request, TARGET)).toBe(true);
    expect(isRelatedViewer(request, OTHER)).toBe(false);
    expect(isRelatedViewer(request, null)).toBe(false);
  });
  it("related: open/resolved expanded, closed collapsed; unrelated always collapsed", () => {
    expect(defaultExpanded("open", true)).toBe(true);
    expect(defaultExpanded("resolved", true)).toBe(true);
    expect(defaultExpanded("closed", true)).toBe(false);
    expect(defaultExpanded("open", false)).toBe(false);
  });
});

describe("readRequestPayload", () => {
  it("parses an options ask + multiSelect default", () => {
    const p = readRequestPayload(request.metadata);
    expect(p.options?.length).toBe(2);
    expect(p.multiSelect).toBe(false);
  });
  it("parses a free-text ask (no options) as an empty payload", () => {
    expect(readRequestPayload({ request: {} })).toEqual({ multiSelect: false });
  });
  // A request row is always answerable: anything that does not parse under the
  // current schema — absent metadata, a legacy `{subject?, questions[]}` shape,
  // or an otherwise-invalid payload — falls back to a free-text ask so an open
  // question is never stranded with no answer surface.
  it("falls back to a free-text ask for non-request metadata", () => {
    expect(readRequestPayload({ mentions: [TARGET] })).toEqual({ multiSelect: false });
  });
  it("falls back to a free-text ask for a legacy `{subject, questions}` payload", () => {
    expect(readRequestPayload({ request: { subject: "Ship?", questions: [{ prompt: "5% or 20%?" }] } })).toEqual({
      multiSelect: false,
    });
  });
  it("falls back to a free-text ask for an invalid payload — fewer than 2 options", () => {
    expect(readRequestPayload({ request: { options: [{ label: "only", description: "d" }] } })).toEqual({
      multiSelect: false,
    });
  });
  it("falls back to a free-text ask when multiSelect is set without options", () => {
    expect(readRequestPayload({ request: { multiSelect: true } })).toEqual({ multiSelect: false });
  });
});

describe("findThreadableRequestId", () => {
  it("returns the open request id when the reply mentions the asking agent", () => {
    expect(findThreadableRequestId([request], TARGET, [ASKER])).toBe("req");
  });
  it("returns null when the asking agent is not mentioned / viewer is not the target", () => {
    expect(findThreadableRequestId([request], TARGET, [OTHER])).toBeNull();
    expect(findThreadableRequestId([request], OTHER, [ASKER])).toBeNull();
  });
  it("returns null once the request is explicitly resolved", () => {
    expect(findThreadableRequestId([request, resolveMsg("r1", TARGET, "answered")], TARGET, [ASKER])).toBeNull();
  });
});

describe("contentStartsWithMention", () => {
  it("detects a leading server-normalised @target (case-insensitive)", () => {
    expect(contentStartsWithMention("@gandy please decide", ["gandy"])).toBe(true);
    expect(contentStartsWithMention("@Gandy please decide", ["gandy"])).toBe(true);
  });
  it("is false for a MID-body mention and non-chippable leading tokens", () => {
    expect(contentStartsWithMention("ping @gandy about this", ["gandy"])).toBe(false);
    expect(contentStartsWithMention("`@gandy` is in inline code", ["gandy"])).toBe(false);
    expect(contentStartsWithMention("[@gandy](https://x) link text", ["gandy"])).toBe(false);
  });
  it("is false for a different participant, a slash boundary, non-string, or empty names", () => {
    expect(contentStartsWithMention("@someone-else heads up", ["gandy"])).toBe(false);
    expect(contentStartsWithMention("@gandy/notes is the file", ["gandy"])).toBe(false);
    expect(contentStartsWithMention(42, ["gandy"])).toBe(false);
    expect(contentStartsWithMention("@gandy hi", [])).toBe(false);
  });
});

describe("findDockableRequest", () => {
  it("returns the newest live request directed at the viewer", () => {
    const older = msg({ id: "req-old", format: "request", metadata: { mentions: [TARGET], request: {} } });
    expect(findDockableRequest([older, request], TARGET)?.id).toBe("req");
  });
  it("skips resolved/closed requests and falls back to an older live one", () => {
    const resolvedNewer = msg({
      id: "req-new",
      format: "request",
      createdAt: "2026-06-02T01:00:00.000Z",
      metadata: { mentions: [TARGET], request: {} },
    });
    const answer = msg({
      id: "ans",
      senderId: TARGET,
      inReplyTo: "req-new",
      metadata: { resolves: { request: "req-new", kind: "answered" } },
    });
    expect(findDockableRequest([request, resolvedNewer, answer], TARGET)?.id).toBe("req");
  });
  it("returns null for non-target / signed-out viewers", () => {
    expect(findDockableRequest([request], OTHER)).toBeNull();
    expect(findDockableRequest([request], null)).toBeNull();
  });
});

describe("findBlockingRequest", () => {
  const older = msg({
    id: "req-old",
    format: "request",
    createdAt: "2026-06-01T00:00:00.000Z",
    metadata: { mentions: [TARGET], request: {} },
  });

  it("returns the OLDEST live request directed at the viewer (FIFO)", () => {
    expect(findBlockingRequest([older, request], TARGET)?.id).toBe("req-old");
  });
  it("advances to the next-oldest once the oldest resolves", () => {
    const answerOld = msg({
      id: "ans-old",
      senderId: TARGET,
      inReplyTo: "req-old",
      metadata: { resolves: { request: "req-old", kind: "answered" } },
    });
    expect(findBlockingRequest([older, request, answerOld], TARGET)?.id).toBe("req");
  });
  it("returns null for non-target / signed-out viewers", () => {
    expect(findBlockingRequest([older, request], OTHER)).toBeNull();
    expect(findBlockingRequest([older, request], null)).toBeNull();
  });
  it("blocks on a legacy/unparseable request too (answerable as free text, never stranded)", () => {
    // A request whose `metadata.request` does not parse under the current schema
    // (here a legacy `{subject, questions}` shape) is still answerable as free
    // text via the fallback in `readRequestPayload`, so it must still block —
    // otherwise its open-request red dot could never be cleared on the Web.
    const legacy = msg({
      id: "req-legacy",
      format: "request",
      createdAt: "2026-06-01T00:00:00.000Z",
      metadata: { mentions: [TARGET], request: { subject: "Ship?", questions: [{ prompt: "5% or 20%?" }] } },
    });
    // FIFO: the legacy one is older, so it blocks first.
    expect(findBlockingRequest([legacy, request], TARGET)?.id).toBe("req-legacy");
    expect(findBlockingRequest([legacy], TARGET)?.id).toBe("req-legacy");
  });
});

describe("allRequiredAnswered / buildResolveAnswer", () => {
  const optionsAsk: AskRequest = { multiSelect: false, options: OPTIONS };
  const freeAsk: AskRequest = { multiSelect: false };

  it("needs at least one selected label OR free text", () => {
    expect(allRequiredAnswered(optionsAsk, [], "")).toBe(false);
    expect(allRequiredAnswered(optionsAsk, ["Ship"], "")).toBe(true);
    expect(allRequiredAnswered(optionsAsk, [], "let's hold off")).toBe(true);
    expect(allRequiredAnswered(freeAsk, [], "   ")).toBe(false);
    expect(allRequiredAnswered(freeAsk, [], "looks risky")).toBe(true);
  });

  it("builds the answer text: selected labels then any free text", () => {
    expect(buildResolveAnswer(optionsAsk, ["Ship"], "")).toBe("Ship");
    expect(buildResolveAnswer(optionsAsk, ["Ship", "Hold"], "")).toBe("Ship, Hold");
    expect(buildResolveAnswer(optionsAsk, ["Ship"], "but watch the canary")).toBe("Ship\nbut watch the canary");
    expect(buildResolveAnswer(freeAsk, [], "let's hold")).toBe("let's hold");
    expect(buildResolveAnswer(optionsAsk, [], "")).toBe("");
  });
});

describe("recoverSelectedLabels", () => {
  it("recovers option labels present in the reply content", () => {
    expect(recoverSelectedLabels("Ship", OPTIONS)).toEqual(["Ship"]);
    expect(recoverSelectedLabels("Ship, Hold", OPTIONS)).toEqual(["Ship", "Hold"]);
  });
  it("returns [] for non-string content, no match, or no options", () => {
    expect(recoverSelectedLabels("let me think", OPTIONS)).toEqual([]);
    expect(recoverSelectedLabels(42, OPTIONS)).toEqual([]);
    expect(recoverSelectedLabels("Ship", [])).toEqual([]);
  });
});
