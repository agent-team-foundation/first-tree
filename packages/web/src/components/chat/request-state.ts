import type { Message, OpenQuestionItem, OpenQuestionRequest, RequestResolution } from "@first-tree/shared";
import { MENTION_REGEX, openQuestionRequestSchema, requestResolutionSchema } from "@first-tree/shared";

/**
 * Lifecycle of a `format="request"` message. Derived from the message thread —
 * NOT stored on the message (the server keeps no lifecycle state). Resolution
 * is driven by an EXPLICIT `metadata.resolves` signal (see
 * `requestResolutionSchema`), never by `inReplyTo` — which is now pure
 * threading, so a "chat about this" back-and-forth can thread under the
 * question without resolving it. See proposals/group-chat-unified-send §D1.
 *   - `open`       — no reply yet. Counts toward the needs_you dot.
 *   - `discussing` — threaded replies exist (a "chat about this" exchange) but
 *                    no explicit resolution yet. Still counts toward the dot —
 *                    the question is being clarified, not answered.
 *   - `resolved`   — a message carries `metadata.resolves` with
 *                    `kind="answered"` pointing at this request (the target's
 *                    clean answer, or the asking agent's `chat send --answer`).
 *   - `closed`     — same, with `kind="closed"` (the asking agent withdrew it
 *                    via `chat send --close`). Closing is explicit; re-asking opens a
 *                    new independent question and never auto-supersedes.
 * Only the target or the asking agent can resolve (mirrors the server's authz).
 */
export type RequestState = "open" | "discussing" | "resolved" | "closed";

/** Read the resolved `@`-mention uuids from a message's metadata. */
export function readMentions(metadata: Record<string, unknown> | null | undefined): string[] {
  const raw = metadata?.mentions;
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
}

/**
 * Whether `content` *starts* with a mention token for any of `names` — the
 * shape the server's `normalizeMentionsInContent` produces (`@target ` prepended
 * at index 0).
 *
 * Deliberately leading-only, not an anywhere-scan: `rehypeMentions` skips
 * `<code>`/`<pre>`/`<a>`, so a raw anywhere-scan would report a mention that the
 * body never actually chips (e.g. `` `@target` ``, a fenced block, or
 * `[@target](…)`). A token at index 0, by contrast, can never sit inside code
 * or a link (those need a leading `` ` `` / `[`), so it is always chippable —
 * making this a render-faithful, false-positive-free signal. Every other shape
 * (mid-body, code, link) conservatively returns false, so the caller keeps its
 * metadata-derived target. Uses the same shared `MENTION_REGEX` (sticky-anchored
 * to index 0) and case-insensitive resolution as the renderer.
 */
export function contentStartsWithMention(content: unknown, names: readonly string[]): boolean {
  if (typeof content !== "string" || names.length === 0) return false;
  const anchored = new RegExp(MENTION_REGEX.source, "y"); // sticky → match only at index 0
  anchored.lastIndex = 0;
  const m = anchored.exec(content);
  if (!m || m[1] === undefined) return false;
  return new Set(names.map((n) => n.toLowerCase())).has(m[1].toLowerCase());
}

/** Parse `metadata.request` into the structured ask; `null` when absent/malformed. */
export function readRequestPayload(metadata: Record<string, unknown> | null | undefined): OpenQuestionRequest | null {
  const raw = metadata?.request;
  const parsed = openQuestionRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Parse `metadata.resolves` into the explicit resolution signal; `null` when absent/malformed. */
export function readResolution(metadata: Record<string, unknown> | null | undefined): RequestResolution | null {
  const parsed = requestResolutionSchema.safeParse(metadata?.resolves);
  return parsed.success ? parsed.data : null;
}

/**
 * Derive the request's lifecycle from the surrounding messages. An explicit
 * `metadata.resolves` wins; absent that, threaded replies mean `discussing`,
 * and a bare request means `open`. Resolution counts only from the target (a
 * direct answer) or the asking agent (answer/close after the discussion) —
 * mirrors the server's authz, so a stray `resolves` from anyone else can't flip
 * the card.
 */
export function deriveRequestState(request: Message, thread: readonly Message[]): RequestState {
  const targets = readMentions(request.metadata);
  const canResolve = (senderId: string): boolean => senderId === request.senderId || targets.includes(senderId);
  let discussing = false;
  for (const m of thread) {
    const res = readResolution(m.metadata);
    if (res && res.request === request.id && canResolve(m.senderId)) {
      return res.kind === "answered" ? "resolved" : "closed";
    }
    // A threaded reply that is NOT a resolution is a "chat about this"
    // discussion turn — the question is being clarified, not answered.
    if (m.id !== request.id && m.inReplyTo === request.id) discussing = true;
  }
  return discussing ? "discussing" : "open";
}

/**
 * The optional human-readable reason from the message that CLOSED this request
 * (`metadata.resolves.kind="closed"`). `null` when the request isn't closed or
 * the close carried no reason. Used for the closed card's copy.
 */
export function readCloseReason(request: Message, thread: readonly Message[]): string | null {
  const targets = readMentions(request.metadata);
  for (const m of thread) {
    const res = readResolution(m.metadata);
    if (
      res &&
      res.request === request.id &&
      res.kind === "closed" &&
      (m.senderId === request.senderId || targets.includes(m.senderId))
    ) {
      return res.reason ?? null;
    }
  }
  return null;
}

/** Viewer is "related" to a request iff they are the asker or the single target. */
export function isRelatedViewer(request: Message, viewerAgentId: string | null | undefined): boolean {
  if (!viewerAgentId) return false;
  if (request.senderId === viewerAgentId) return true;
  return readMentions(request.metadata).includes(viewerAgentId);
}

/**
 * Default expand state: unrelated viewers always collapse; related viewers see
 * `open`/`resolved` expanded and `closed` collapsed. (User can toggle either way.)
 */
export function defaultExpanded(state: RequestState, related: boolean): boolean {
  if (!related) return false;
  return state !== "closed";
}

/**
 * Core scan shared by `findThreadableRequestId` and `findDockableRequest`:
 * the most recent OPEN or DISCUSSING `format="request"` directed at the
 * viewer, optionally restricted to requests raised by `fromSenders`. One
 * definition of "the live question" keeps the composer's thread-on-reply
 * behavior and the dock's pin choice agreeing by construction.
 */
function findLiveRequest(
  thread: readonly Message[],
  viewerAgentId: string | null,
  fromSenders?: ReadonlySet<string>,
): Message | null {
  if (!viewerAgentId) return null;
  // `thread` is oldest-first; walk from the newest so the latest live question wins.
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (!m || m.format !== "request") continue;
    if (fromSenders && !fromSenders.has(m.senderId)) continue;
    if (!readMentions(m.metadata).includes(viewerAgentId)) continue;
    const st = deriveRequestState(m, thread);
    if (st === "open" || st === "discussing") return m;
  }
  return null;
}

/**
 * When `viewer` is about to send a message mentioning `mentionedIds`, find the
 * most recent OPEN or DISCUSSING request directed at them and raised by one of
 * the mentioned agents — so a plain composer reply that @-mentions the asking
 * agent threads onto the question (sets `inReplyTo`). This is the "chat about
 * this" path: the reply threads under the question for context but does NOT
 * resolve it — resolution needs an explicit `metadata.resolves` (written by the
 * card's answer block, or the agent's `chat send --answer`/`--close`). Returns
 * the request's message id, or `null` when there's no such live question.
 */
export function findThreadableRequestId(
  thread: readonly Message[],
  viewerAgentId: string | null,
  mentionedIds: readonly string[],
): string | null {
  if (mentionedIds.length === 0) return null;
  return findLiveRequest(thread, viewerAgentId, new Set(mentionedIds))?.id ?? null;
}

/**
 * The request the composer dock pins: the most recent OPEN or DISCUSSING
 * `format="request"` directed at the viewer. The dock owns answering for
 * exactly this one (the timeline card suppresses its inline answer block via
 * `suppressAnswerBlock`); any older live request keeps its inline block as
 * the fallback. Returns `null` when nothing needs the viewer's answer.
 */
export function findDockableRequest(thread: readonly Message[], viewerAgentId: string | null): Message | null {
  return findLiveRequest(thread, viewerAgentId);
}

/**
 * The composer text a clean option selection produces. `selections` is keyed
 * by PROMPT (the same shape `recoverAnswerSelections` returns, so draft ⇄
 * selection round-trips losslessly). A single single-select question fills
 * just the option text (what you click is exactly what you send); several
 * questions fill one canonical `"<prompt> → <answer>"` line per answered
 * single-select question so the sent content parses back via
 * `parseAnswerSelections` for the resolved card's echo. Free-text questions
 * never contribute — they are answered by typing, which goes through the
 * agent-judgment path.
 */
export function buildAnswerDraft(payload: OpenQuestionRequest, selections: Record<string, string>): string {
  const qs = payload.questions;
  const only = qs.length === 1 ? qs[0] : undefined;
  if (only && only.kind === "single") return selections[only.prompt] ?? "";
  return qs
    .filter((q) => q.kind === "single" && selections[q.prompt])
    .map((q) => `${q.prompt} → ${selections[q.prompt]}`)
    .join("\n");
}

/**
 * Every required question is answered by an option selection (`selections`
 * keyed by prompt). A required free-text question can never satisfy this — a
 * typed answer is judged by the asking agent, not direct-resolved by the
 * composer.
 */
export function allRequiredSelected(payload: OpenQuestionRequest, selections: Record<string, string>): boolean {
  return payload.questions.every((q) => !q.required || (q.kind === "single" && Boolean(selections[q.prompt])));
}

/**
 * The request the viewer is BLOCKED on: the OLDEST (FIFO) `open` or
 * `discussing` `format="request"` directed at the viewer. The blocking UI pins
 * this one, hides every timeline item after it, and only lifts once it
 * resolves — then the next-oldest unresolved question becomes the block.
 * Returns `null` when nothing needs the viewer's answer. Watchers /
 * non-targets never block (they aren't in `metadata.mentions`).
 *
 * Oldest-first is the deliberate contrast with `findDockableRequest`'s
 * newest-first scan: a block is a queue the human works front-to-back, so the
 * earliest unanswered question must come up first.
 */
export function findBlockingRequest(thread: readonly Message[], viewerAgentId: string | null): Message | null {
  if (!viewerAgentId) return null;
  // `thread` is oldest-first; walk forward so the earliest live question wins.
  for (const m of thread) {
    if (m.format !== "request") continue;
    if (!readMentions(m.metadata).includes(viewerAgentId)) continue;
    // Skip a request whose structured payload doesn't parse: it has no usable
    // answer surface (the dock renders nothing), so blocking on it would hide
    // the timeline with no way to answer. Skipping lets the next parseable live
    // question become the block instead of stranding the viewer.
    if (!readRequestPayload(m.metadata)) continue;
    const st = deriveRequestState(m, thread);
    if (st === "open" || st === "discussing") return m;
  }
  return null;
}

/**
 * Whether the viewer has answered enough to send, treating the blocking
 * surface's two answer channels as equals. Free text alone is a complete answer
 * to the whole request — typing an answer resolves the question even for an
 * option (single-select) question, so the human is never forced to pick a
 * listed option. Absent free text, every required question must be answered by
 * its own option selection. Drives the send button's enabled state.
 */
export function allRequiredAnswered(
  payload: OpenQuestionRequest,
  selections: Record<string, string>,
  freeText: string,
): boolean {
  // Any free text is itself the answer — enable send (it stands in as the
  // answer for every question via `buildResolveAnswer`).
  if (freeText.trim().length > 0) return true;
  // No free text: each required question needs an option pick. A required
  // free-text question is unsatisfied here, since it has no free text.
  return payload.questions.every((q) => !q.required || (q.kind === "single" && Boolean(selections[q.prompt])));
}

/**
 * Build the resolving reply's content from the two answer channels — option
 * `selections` (keyed by prompt) and the composer's `freeText`. Emits one
 * canonical `"<prompt> → <answer>"` line per question — the same shape
 * `recoverAnswerSelections` parses back for the resolved card's echo — using
 * the selection for single-select questions and the free text for free-text
 * questions. When the request carries no free-text question but the viewer
 * typed an extra note (`allowExtra`), the note is appended as a trailing line.
 *
 * This makes the blocking dock send byte-identical to the inline
 * `RequestCard` answer block, so both surfaces resolve and echo the same way.
 */
export function buildResolveAnswer(
  payload: OpenQuestionRequest,
  selections: Record<string, string>,
  freeText: string,
): string {
  const note = freeText.trim();
  const lines = payload.questions
    .map((q) => ({
      q,
      // An option question is answered by its selection; if none was picked the
      // free text stands in as the answer (so free-text-only answers an option
      // question too). A free-text question is answered by the free text.
      answer: q.kind === "single" ? (selections[q.prompt] ?? note) : note,
    }))
    // Drop optional questions the viewer left unanswered through both channels —
    // otherwise the resolving content carries `"<prompt> → —"` placeholder lines
    // the resolved card would echo as the "answer". Required questions are
    // always answered by the send gate, so they survive.
    .filter(({ q, answer }) => q.required || answer.length > 0)
    .map(({ q, answer }) => `${q.prompt} → ${answer || "—"}`);
  // The note is used as an answer for any question lacking an option selection
  // (a free-text question, or an option question answered by free text), so only
  // append it as a standalone trailing note when every question was answered by
  // its own selection.
  const noteConsumed = payload.questions.some((q) => !selections[q.prompt]);
  if (note && !noteConsumed) lines.push(note);
  return lines.join("\n");
}

/**
 * Recover the chosen answers from a resolving message's content, keyed by
 * prompt. Canonical `"<prompt> → <answer>"` lines parse first; the fallback
 * accepts the bare option text the composer dock sends for a one-question
 * request (the box shows exactly the clicked option, so that is what lands in
 * history). Returns `{}` when nothing matches — callers render "answered".
 */
export function recoverAnswerSelections(
  replyContent: unknown,
  questions: readonly OpenQuestionItem[],
): Record<string, string> {
  const parsed = parseAnswerSelections(
    replyContent,
    questions.map((q) => q.prompt),
  );
  if (Object.keys(parsed).length > 0) return parsed;
  const only = questions.length === 1 ? questions[0] : undefined;
  if (only && only.kind === "single" && typeof replyContent === "string") {
    const text = replyContent.trim();
    if (only.options.includes(text)) return { [only.prompt]: text };
  }
  return {};
}

/**
 * Parse the chosen answers out of a resolving reply's content. The answer
 * composer writes one `"<prompt> → <answer>"` line per question; we map each
 * back to its question by exact prompt match. Returns `{}` when the content
 * isn't a string or no line matches (e.g. a free-form reply typed in the
 * composer) — callers then render without a selection highlight.
 */
export function parseAnswerSelections(replyContent: unknown, prompts: readonly string[]): Record<string, string> {
  if (typeof replyContent !== "string") return {};
  // Match each line against the known prompts as PREFIXES (longest first),
  // not by splitting on the first " → " — a prompt that itself contains
  // " → " (e.g. "Migrate v1 → v2 now?") would otherwise break the
  // buildAnswerDraft round-trip. The separator tolerates extra whitespace
  // around the arrow, matching historical hand-formatted replies.
  const byLength = [...prompts].sort((a, b) => b.length - a.length);
  const out: Record<string, string> = {};
  for (const rawLine of replyContent.split("\n")) {
    const line = rawLine.trim();
    for (const prompt of byLength) {
      if (!line.startsWith(prompt)) continue;
      const sep = /^\s+→\s+(.*)$/.exec(line.slice(prompt.length));
      if (sep?.[1] !== undefined) {
        out[prompt] = sep[1].trim();
        break;
      }
    }
  }
  return out;
}
