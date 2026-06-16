import type { AskRequest, Message, RequestResolution } from "@first-tree/shared";
import { askRequestSchema, MENTION_REGEX, requestResolutionSchema } from "@first-tree/shared";

/**
 * Lifecycle of a `format="request"` message ("ask"). Derived from the message
 * thread — NOT stored on the message. Resolution is driven by an EXPLICIT
 * `metadata.resolves` signal (see `requestResolutionSchema`), never by
 * `inReplyTo` (pure threading).
 *   - `open`       — no reply yet. Counts toward the needs_you dot.
 *   - `discussing` — threaded (non-resolving) replies exist; still counts.
 *   - `resolved`   — a `metadata.resolves` with `kind="answered"` from the
 *                    target or the asking agent.
 *   - `closed`     — same, `kind="closed"` (the asker withdrew it).
 * Only the target or the asking agent can resolve (mirrors the server's authz).
 *
 * The ask itself is the message BODY (`content`); `metadata.request` carries
 * only the answer affordance (`options` + `multiSelect`). The answer is free
 * text (selected option labels and/or a typed note), recorded in the resolving
 * reply's `content` — never structured.
 */
export type RequestState = "open" | "discussing" | "resolved" | "closed";

export type RequestLifecycleProjection = {
  state: RequestState;
  /** Option labels the answer selected (for the resolved card's echo). */
  selectedLabels: string[];
  closeReason: string | null;
};

/** Read the resolved `@`-mention uuids from a message's metadata. */
export function readMentions(metadata: Record<string, unknown> | null | undefined): string[] {
  const raw = metadata?.mentions;
  return Array.isArray(raw) ? raw.filter((m): m is string => typeof m === "string") : [];
}

/**
 * Whether `content` *starts* with a mention token for any of `names` — the
 * shape the server's `normalizeMentionsInContent` produces. Leading-only and
 * render-faithful (see `rehypeMentions`), so it never reports a mention the body
 * does not actually chip.
 */
export function contentStartsWithMention(content: unknown, names: readonly string[]): boolean {
  if (typeof content !== "string" || names.length === 0) return false;
  const anchored = new RegExp(MENTION_REGEX.source, "y"); // sticky → match only at index 0
  anchored.lastIndex = 0;
  const m = anchored.exec(content);
  if (!m || m[1] === undefined) return false;
  return new Set(names.map((n) => n.toLowerCase())).has(m[1].toLowerCase());
}

/**
 * Read `metadata.request` into the ask's answer affordance. A well-formed
 * payload yields its `options` + `multiSelect`. Anything else — absent metadata,
 * or a legacy/retired shape (e.g. the old `{ subject?, questions: [...] }`) —
 * falls back to a **free-text ask** (`{ multiSelect: false }`), so an
 * already-open question is always answerable and never stranded with no web
 * answer surface (its open-request red dot would otherwise never clear).
 */
export function readRequestPayload(metadata: Record<string, unknown> | null | undefined): AskRequest {
  const parsed = askRequestSchema.safeParse(metadata?.request);
  return parsed.success ? parsed.data : { multiSelect: false };
}

/** Parse `metadata.resolves` into the explicit resolution signal; `null` when absent/malformed. */
export function readResolution(metadata: Record<string, unknown> | null | undefined): RequestResolution | null {
  const parsed = requestResolutionSchema.safeParse(metadata?.resolves);
  return parsed.success ? parsed.data : null;
}

/**
 * Recover which option labels an answer selected, from the resolving reply's
 * `content`. A label counts as selected when it appears as a token in the
 * content (the answer composer joins selected labels into the reply). Used only
 * for the resolved card's selection echo, so a loose substring match is fine.
 */
export function recoverSelectedLabels(replyContent: unknown, options: readonly { label: string }[]): string[] {
  if (typeof replyContent !== "string" || options.length === 0) return [];
  const text = replyContent;
  return options.map((o) => o.label).filter((label) => text.includes(label));
}

/**
 * Derive the request's lifecycle from the surrounding messages. An explicit
 * `metadata.resolves` wins; absent that, threaded replies mean `discussing`,
 * and a bare request means `open`. Resolution counts only from the target or
 * the asking agent — mirrors the server's authz.
 */
export function deriveRequestState(request: Message, thread: readonly Message[]): RequestState {
  return deriveRequestLifecycleProjection(request, thread).state;
}

export function deriveRequestLifecycleProjection(
  request: Message,
  thread: readonly Message[],
): RequestLifecycleProjection {
  const targets = readMentions(request.metadata);
  const canResolve = (senderId: string): boolean => senderId === request.senderId || targets.includes(senderId);
  let discussing = false;
  for (const m of thread) {
    const res = readResolution(m.metadata);
    if (res && res.request === request.id && canResolve(m.senderId)) {
      if (res.kind === "answered") {
        const payload = readRequestPayload(request.metadata);
        return {
          state: "resolved",
          selectedLabels: payload.options ? recoverSelectedLabels(m.content, payload.options) : [],
          closeReason: null,
        };
      }
      return { state: "closed", selectedLabels: [], closeReason: res.reason ?? null };
    }
    if (m.id !== request.id && m.inReplyTo === request.id) discussing = true;
  }
  return { state: discussing ? "discussing" : "open", selectedLabels: [], closeReason: null };
}

/** The optional human-readable reason from the message that CLOSED this request. */
export function readCloseReason(request: Message, thread: readonly Message[]): string | null {
  return deriveRequestLifecycleProjection(request, thread).closeReason;
}

/** Viewer is "related" to a request iff they are the asker or the single target. */
export function isRelatedViewer(request: Message, viewerAgentId: string | null | undefined): boolean {
  if (!viewerAgentId) return false;
  if (request.senderId === viewerAgentId) return true;
  return readMentions(request.metadata).includes(viewerAgentId);
}

/**
 * Default expand state: unrelated viewers always collapse; related viewers see
 * `open`/`resolved` expanded and `closed` collapsed.
 */
export function defaultExpanded(state: RequestState, related: boolean): boolean {
  if (!related) return false;
  return state !== "closed";
}

/**
 * Core scan: the most recent OPEN or DISCUSSING `format="request"` directed at
 * the viewer, optionally restricted to `fromSenders`.
 */
function findLiveRequest(
  thread: readonly Message[],
  viewerAgentId: string | null,
  fromSenders?: ReadonlySet<string>,
): Message | null {
  if (!viewerAgentId) return null;
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
 * most recent OPEN/DISCUSSING request directed at them and raised by one of the
 * mentioned agents — so a plain composer reply that @-mentions the asking agent
 * threads onto the question (sets `inReplyTo`) without resolving it.
 */
export function findThreadableRequestId(
  thread: readonly Message[],
  viewerAgentId: string | null,
  mentionedIds: readonly string[],
): string | null {
  if (mentionedIds.length === 0) return null;
  return findLiveRequest(thread, viewerAgentId, new Set(mentionedIds))?.id ?? null;
}

/** The most recent OPEN/DISCUSSING `format="request"` directed at the viewer. */
export function findDockableRequest(thread: readonly Message[], viewerAgentId: string | null): Message | null {
  return findLiveRequest(thread, viewerAgentId);
}

/**
 * The request the viewer is BLOCKED on: the OLDEST (FIFO) `open`/`discussing`
 * `format="request"` directed at the viewer. The blocking UI takes over the
 * pane, hides every later timeline item, and only lifts once it resolves.
 * Watchers / non-targets never block.
 */
export function findBlockingRequest(thread: readonly Message[], viewerAgentId: string | null): Message | null {
  if (!viewerAgentId) return null;
  for (const m of thread) {
    if (m.format !== "request") continue;
    if (!readMentions(m.metadata).includes(viewerAgentId)) continue;
    // Every `format="request"` row is answerable — a well-formed payload via its
    // options, a legacy/malformed one via the free-text fallback in
    // `readRequestPayload`. We never skip a live request, so an already-open
    // question (including ones written under the retired schema) keeps a takeover
    // and its red dot can always be cleared.
    const st = deriveRequestState(m, thread);
    if (st === "open" || st === "discussing") return m;
  }
  return null;
}

/**
 * Whether the viewer has answered enough to send. One ask, two channels: at
 * least one selected option label OR any free text. Drives the Reply button.
 */
export function allRequiredAnswered(
  _payload: AskRequest,
  selectedLabels: readonly string[],
  freeText: string,
): boolean {
  return selectedLabels.length > 0 || freeText.trim().length > 0;
}

/**
 * Build the resolving reply's `content` from the two answer channels — the
 * selected option `selectedLabels` and the typed `freeText` ("Other"). Selected
 * labels join on one line; any free text follows on its own line. The answer is
 * plain text — option picks and the note are not separately structured.
 */
export function buildResolveAnswer(_payload: AskRequest, selectedLabels: readonly string[], freeText: string): string {
  const picked = selectedLabels.join(", ");
  const note = freeText.trim();
  return [picked, note].filter((s) => s.length > 0).join("\n");
}
