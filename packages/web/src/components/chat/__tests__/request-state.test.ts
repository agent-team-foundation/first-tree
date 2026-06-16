import type { Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  allRequiredAnswered,
  allRequiredSelected,
  buildAnswerDraft,
  buildResolveAnswer,
  contentStartsWithMention,
  defaultExpanded,
  deriveRequestState,
  findBlockingRequest,
  findDockableRequest,
  findThreadableRequestId,
  isRelatedViewer,
  parseAnswerSelections,
  readCloseReason,
  readRequestPayload,
  readResolution,
  recoverAnswerSelections,
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
  it("handles a prompt that itself contains ' → ' — prefix matching, not first-separator split", () => {
    const prompt = "Migrate v1 → v2 now?";
    expect(parseAnswerSelections(`${prompt} → yes`, [prompt])).toEqual({ [prompt]: "yes" });
  });

  it("prefers the longest matching prompt when one prompt prefixes another", () => {
    const short = "Deploy?";
    const long = "Deploy? → to prod too?";
    expect(parseAnswerSelections(`${long} → yes`, [short, long])).toEqual({ [long]: "yes" });
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

describe("findDockableRequest", () => {
  it("returns the newest live request directed at the viewer", () => {
    const older = msg({
      id: "req-old",
      format: "request",
      metadata: { mentions: [TARGET], request: { questions: [{ id: "q1", prompt: "Old?", options: ["a"] }] } },
    });
    const thread = [older, request];
    expect(findDockableRequest(thread, TARGET)?.id).toBe("req");
  });

  it("skips resolved/closed requests and falls back to an older live one", () => {
    const resolvedNewer = msg({
      id: "req-new",
      format: "request",
      createdAt: "2026-06-02T01:00:00.000Z",
      metadata: { mentions: [TARGET], request: { questions: [{ id: "q1", prompt: "New?", options: ["a"] }] } },
    });
    const answer = msg({
      id: "ans",
      senderId: TARGET,
      inReplyTo: "req-new",
      content: "a",
      metadata: { resolves: { request: "req-new", kind: "answered" } },
    });
    expect(findDockableRequest([request, resolvedNewer, answer], TARGET)?.id).toBe("req");
  });

  it("still docks a DISCUSSING request — threading does not unpin it", () => {
    const discuss = msg({ id: "d1", senderId: TARGET, inReplyTo: "req", content: "why?" });
    expect(findDockableRequest([request, discuss], TARGET)?.id).toBe("req");
  });

  it("returns null for non-target viewers and signed-out viewers", () => {
    expect(findDockableRequest([request], OTHER)).toBeNull();
    expect(findDockableRequest([request], null)).toBeNull();
  });
});

describe("findBlockingRequest", () => {
  const older = msg({
    id: "req-old",
    format: "request",
    createdAt: "2026-06-01T00:00:00.000Z",
    metadata: { mentions: [TARGET], request: { questions: [{ id: "q1", prompt: "Old?", options: ["a"] }] } },
  });

  it("returns the OLDEST live request directed at the viewer (FIFO — the contrast with the dock's newest-first)", () => {
    // `request` (id "req") is newer; the block must surface the older one first.
    expect(findBlockingRequest([older, request], TARGET)?.id).toBe("req-old");
  });

  it("advances to the next-oldest once the oldest resolves", () => {
    const answerOld = msg({
      id: "ans-old",
      senderId: TARGET,
      inReplyTo: "req-old",
      content: "a",
      metadata: { resolves: { request: "req-old", kind: "answered" } },
    });
    expect(findBlockingRequest([older, request, answerOld], TARGET)?.id).toBe("req");
  });

  it("blocks on a DISCUSSING request — threading does not unblock it", () => {
    const discuss = msg({ id: "d1", senderId: TARGET, inReplyTo: "req-old", content: "why?" });
    expect(findBlockingRequest([older, discuss], TARGET)?.id).toBe("req-old");
  });

  it("returns null for non-target viewers and signed-out viewers", () => {
    expect(findBlockingRequest([older, request], OTHER)).toBeNull();
    expect(findBlockingRequest([older, request], null)).toBeNull();
  });

  it("skips an unparseable request and blocks on the next parseable one (no stuck block)", () => {
    // Oldest is a request with an invalid payload (empty questions fails the
    // schema): it has no answer surface, so it must NOT become the block —
    // otherwise the timeline would truncate with no way to answer.
    const malformed = msg({
      id: "req-bad",
      format: "request",
      createdAt: "2026-06-01T00:00:00.000Z",
      metadata: { mentions: [TARGET], request: { questions: [] } },
    });
    expect(findBlockingRequest([malformed, request], TARGET)?.id).toBe("req");
    // With no parseable live request, nothing blocks.
    expect(findBlockingRequest([malformed], TARGET)).toBeNull();
  });
});

describe("buildAnswerDraft / allRequiredSelected", () => {
  const single = {
    subject: "Deploy",
    questions: [{ id: "q1", prompt: "Ship?", kind: "single" as const, options: ["yes", "no"], required: true }],
    allowExtra: false,
  };
  const multi = {
    subject: "Release",
    questions: [
      { id: "q1", prompt: "Strategy?", kind: "single" as const, options: ["blue-green", "rolling"], required: true },
      { id: "q2", prompt: "Window?", kind: "single" as const, options: ["friday", "monday"], required: true },
    ],
    allowExtra: false,
  };
  const withFree = {
    subject: "Risk",
    questions: [{ id: "q1", prompt: "Concerns?", kind: "free" as const, options: [], required: true }],
    allowExtra: false,
  };

  it("single question fills just the option text — what you click is what you send", () => {
    expect(buildAnswerDraft(single, { "Ship?": "yes" })).toBe("yes");
    expect(buildAnswerDraft(single, {})).toBe("");
  });

  it("multi question fills canonical prompt → answer lines that parseAnswerSelections reads back", () => {
    const draft = buildAnswerDraft(multi, { "Strategy?": "blue-green", "Window?": "friday" });
    expect(draft).toBe("Strategy? → blue-green\nWindow? → friday");
    expect(parseAnswerSelections(draft, ["Strategy?", "Window?"])).toEqual({
      "Strategy?": "blue-green",
      "Window?": "friday",
    });
  });

  it("round-trips through recoverAnswerSelections — the derived-selection model's invariant", () => {
    // chat-view derives selections FROM the draft; a clean draft must
    // recover the same selections it was built from.
    const sel = { "Strategy?": "blue-green", "Window?": "friday" };
    const draft = buildAnswerDraft(multi, sel);
    expect(recoverAnswerSelections(draft, multi.questions)).toEqual(sel);
    expect(buildAnswerDraft(multi, recoverAnswerSelections(draft, multi.questions))).toBe(draft);
  });

  it("allRequiredSelected requires every required single answered; free-text never satisfies it", () => {
    expect(allRequiredSelected(multi, { "Strategy?": "blue-green" })).toBe(false);
    expect(allRequiredSelected(multi, { "Strategy?": "blue-green", "Window?": "friday" })).toBe(true);
    // A required free-text question always routes through agent judgment.
    expect(allRequiredSelected(withFree, {})).toBe(false);
  });
});

describe("allRequiredAnswered / buildResolveAnswer (blocking surface — both channels resolve)", () => {
  const single = {
    subject: "Deploy",
    questions: [{ id: "q1", prompt: "Ship?", kind: "single" as const, options: ["yes", "no"], required: true }],
    allowExtra: false,
  };
  const multi = {
    subject: "Release",
    questions: [
      { id: "q1", prompt: "Strategy?", kind: "single" as const, options: ["blue-green", "rolling"], required: true },
      { id: "q2", prompt: "Window?", kind: "single" as const, options: ["friday", "monday"], required: true },
    ],
    allowExtra: false,
  };
  const withFree = {
    subject: "Risk",
    questions: [{ id: "q1", prompt: "Concerns?", kind: "free" as const, options: [], required: true }],
    allowExtra: false,
  };
  const mixed = {
    subject: "Plan",
    questions: [
      { id: "q1", prompt: "Strategy?", kind: "single" as const, options: ["blue-green"], required: true },
      { id: "q2", prompt: "Notes?", kind: "free" as const, options: [], required: true },
    ],
    allowExtra: false,
  };

  it("free text satisfies a required option question — no option pick needed (the reported bug)", () => {
    expect(allRequiredAnswered(single, {}, "")).toBe(false);
    // Free text alone enables send for an option question (was incorrectly false).
    expect(allRequiredAnswered(single, {}, "let's hold off")).toBe(true);
    expect(buildResolveAnswer(single, {}, "let's hold off")).toBe("Ship? → let's hold off");
    // An option pick alone still works.
    expect(allRequiredAnswered(single, { "Ship?": "yes" }, "")).toBe(true);
  });

  it("a required free-text question IS satisfied by composer free text (no longer judge-only)", () => {
    expect(allRequiredAnswered(withFree, {}, "  ")).toBe(false);
    expect(allRequiredAnswered(withFree, {}, "looks risky")).toBe(true);
  });

  it("mixed request: free text alone enables send; option-only without free text does not (free question unanswered)", () => {
    expect(allRequiredAnswered(mixed, { "Strategy?": "blue-green" }, "")).toBe(false);
    expect(allRequiredAnswered(mixed, {}, "some notes")).toBe(true);
    expect(allRequiredAnswered(mixed, { "Strategy?": "blue-green" }, "some notes")).toBe(true);
  });

  it("builds canonical prompt → answer lines recoverAnswerSelections reads back", () => {
    const content = buildResolveAnswer(multi, { "Strategy?": "blue-green", "Window?": "friday" }, "");
    expect(content).toBe("Strategy? → blue-green\nWindow? → friday");
    expect(recoverAnswerSelections(content, multi.questions)).toEqual({
      "Strategy?": "blue-green",
      "Window?": "friday",
    });
  });

  it("uses the composer free text as the answer to free-text questions", () => {
    expect(buildResolveAnswer(withFree, {}, "looks risky")).toBe("Concerns? → looks risky");
    expect(buildResolveAnswer(mixed, { "Strategy?": "blue-green" }, "ship monday")).toBe(
      "Strategy? → blue-green\nNotes? → ship monday",
    );
  });

  it("appends an extra note as a trailing line when there is no free-text question", () => {
    expect(buildResolveAnswer(single, { "Ship?": "yes" }, "but watch the canary")).toBe(
      "Ship? → yes\nbut watch the canary",
    );
  });

  it("drops optional questions the viewer left unanswered (no '→ —' placeholder lines)", () => {
    const withOptional = {
      subject: "Deploy",
      questions: [
        { id: "q1", prompt: "Ship?", kind: "single" as const, options: ["yes", "no"], required: true },
        { id: "q2", prompt: "Canary?", kind: "single" as const, options: ["5%", "20%"], required: false },
      ],
      allowExtra: false,
    };
    // Optional Canary left unanswered → only the answered required line survives.
    expect(buildResolveAnswer(withOptional, { "Ship?": "yes" }, "")).toBe("Ship? → yes");
    // Optional answered → it is included.
    expect(buildResolveAnswer(withOptional, { "Ship?": "yes", "Canary?": "5%" }, "")).toBe("Ship? → yes\nCanary? → 5%");
  });
});

describe("recoverAnswerSelections", () => {
  const questions = [{ id: "q1", prompt: "Ship?", kind: "single" as const, options: ["yes", "no"], required: true }];

  it("parses canonical prompt → answer lines first", () => {
    expect(recoverAnswerSelections("Ship? → yes", questions)).toEqual({ "Ship?": "yes" });
  });

  it("accepts the bare option text the dock sends for a one-question request", () => {
    expect(recoverAnswerSelections("yes", questions)).toEqual({ "Ship?": "yes" });
  });

  it("returns {} for free-form replies that match nothing", () => {
    expect(recoverAnswerSelections("let me think about it", questions)).toEqual({});
    expect(recoverAnswerSelections(42, questions)).toEqual({});
  });

  it("does not bare-option-match multi-question requests — ambiguous", () => {
    const multiQ = [
      { id: "q1", prompt: "A?", kind: "single" as const, options: ["x"], required: true },
      { id: "q2", prompt: "B?", kind: "single" as const, options: ["x"], required: true },
    ];
    expect(recoverAnswerSelections("x", multiQ)).toEqual({});
  });
});
