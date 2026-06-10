import type { Message, OpenQuestionRequest, RequestResolution } from "@first-tree/shared";
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
  if (!viewerAgentId || mentionedIds.length === 0) return null;
  const mentioned = new Set(mentionedIds);
  // `thread` is oldest-first; walk from the newest so the latest live question wins.
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (!m || m.format !== "request" || !mentioned.has(m.senderId)) continue;
    if (!readMentions(m.metadata).includes(viewerAgentId)) continue;
    const st = deriveRequestState(m, thread);
    if (st === "open" || st === "discussing") return m.id;
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
