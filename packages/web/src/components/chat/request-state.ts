import type { Message, OpenQuestionRequest } from "@first-tree/shared";
import { openQuestionRequestSchema } from "@first-tree/shared";

/**
 * Lifecycle of a `format="request"` message. Derived from the message thread —
 * NOT stored on the message (the server keeps no lifecycle state). See
 * proposals/group-chat-unified-send §D1.
 *   - `open`     — no qualifying follow-up. Counts toward the needs_you dot.
 *   - `resolved` — the target (a member in `metadata.mentions`) replied with
 *                  `inReplyTo` pointing at this request.
 *   - `closed`   — the asking agent (the request's own sender) replied to its
 *                  own request: a non-request reply actively closes/withdraws
 *                  it; a request-shaped reply replaces it (this card closes,
 *                  the new request stands separately). Either way the count
 *                  for the open question is released (replacement re-opens via
 *                  the new request).
 */
export type RequestState = "open" | "resolved" | "closed";

/** Read the resolved `@`-mention uuids from a message's metadata. */
export function readMentions(metadata: Record<string, unknown> | null | undefined): string[] {
  const raw = metadata?.mentions;
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
}

/** Parse `metadata.request` into the structured ask; `null` when absent/malformed. */
export function readRequestPayload(metadata: Record<string, unknown> | null | undefined): OpenQuestionRequest | null {
  const raw = metadata?.request;
  const parsed = openQuestionRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Derive the request's lifecycle from the surrounding messages. `resolved`
 * outranks `closed` (an answer is more meaningful than a supersede if both
 * somehow exist).
 */
export function deriveRequestState(request: Message, thread: readonly Message[]): RequestState {
  const targets = readMentions(request.metadata);
  let closed = false;
  for (const m of thread) {
    if (m.inReplyTo !== request.id) continue;
    if (targets.includes(m.senderId)) return "resolved";
    // Any reply BY THE ASKER to its own request closes it: a non-request reply
    // is an active close/withdraw; a request-shaped reply is a replacement
    // (this old card closes, the new request stands on its own).
    if (m.senderId === request.senderId) closed = true;
  }
  return closed ? "closed" : "open";
}

/**
 * Distinguishes the two `closed` sub-cases for copy: `true` when the asker
 * closed by posting a NEW request replying to this one (supersede/replacement),
 * `false` when it was an active close/withdraw (a non-request reply). Only
 * meaningful when the request already derives `closed`.
 */
export function isReplacedByNewRequest(request: Message, thread: readonly Message[]): boolean {
  return thread.some((m) => m.inReplyTo === request.id && m.senderId === request.senderId && m.format === "request");
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
 * When `viewer` is about to send a message mentioning `mentionedIds`, find the
 * most recent OPEN request directed at them and raised by one of the mentioned
 * agents — so a plain composer reply that @-mentions the asking agent threads
 * onto the question (sets `inReplyTo`) and counts as the answer. Returns the
 * request's message id, or `null` when there's no such open question.
 */
export function findAnswerableRequestId(
  thread: readonly Message[],
  viewerAgentId: string | null,
  mentionedIds: readonly string[],
): string | null {
  if (!viewerAgentId || mentionedIds.length === 0) return null;
  const mentioned = new Set(mentionedIds);
  // `thread` is oldest-first; walk from the newest so the latest open question wins.
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (!m || m.format !== "request" || !mentioned.has(m.senderId)) continue;
    if (!readMentions(m.metadata).includes(viewerAgentId)) continue;
    if (deriveRequestState(m, thread) === "open") return m.id;
  }
  return null;
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
  const known = new Set(prompts);
  const out: Record<string, string> = {};
  for (const line of replyContent.split("\n")) {
    const sep = line.indexOf(" → ");
    if (sep < 0) continue;
    const prompt = line.slice(0, sep).trim();
    const answer = line.slice(sep + 3).trim();
    if (known.has(prompt)) out[prompt] = answer;
  }
  return out;
}
