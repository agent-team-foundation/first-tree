import { z } from "zod";
import { chatEngagementStatusSchema } from "./chat.js";
import { chatSourceSchema, githubEntityTypeSchema } from "./chat-metadata.js";

/**
 * Member-facing chat APIs (`/me/chats*`) for the chat-first workspace.
 * See first-tree-context:agent-hub/web-console.md "API Contract".
 */

/**
 * Conversation-list inbox filter. Phase B narrows the enum from the
 * pre-existing `["all", "unread", "watching"]` to `["all", "unread"]` —
 * the old "watching" value conflated two orthogonal dimensions (unread
 * state + the user's membership kind) onto a single enum slot. Phase B
 * lifts `watching` out as an independent boolean (see
 * `listMeChatsQuerySchema.watching`) so the wire can express
 * "unread AND watching" or "watching only" without overloading filter.
 */
export const ME_CHAT_FILTERS = ["all", "unread"] as const;
export const meChatFilterSchema = z.enum(ME_CHAT_FILTERS);
export type MeChatFilter = z.infer<typeof meChatFilterSchema>;

export const ME_CHAT_DEFAULT_LIMIT = 50;
export const ME_CHAT_MAX_LIMIT = 200;

export const meChatMembershipKindSchema = z.enum(["participant", "watching"]);
export type MeChatMembershipKind = z.infer<typeof meChatMembershipKindSchema>;

/**
 * Conversation-list engagement view. `active` (default) and `archived`
 * map to the eponymous tabs; `all` shows their union. `deleted` is never
 * a valid view value — deleted rows are reachable only through the chat
 * detail page (`GET /chats/:chatId` + Restore button).
 */
export const CHAT_ENGAGEMENT_VIEWS = ["active", "archived", "all"] as const;
export const chatEngagementViewSchema = z.enum(CHAT_ENGAGEMENT_VIEWS);
export type ChatEngagementView = z.infer<typeof chatEngagementViewSchema>;

/**
 * Coerce a CSV string like `"manual,pr,issue"` to an array of trimmed
 * non-empty tokens. Lets the wire accept both repeated query params
 * (`?origin=manual&origin=pr`) and the comma-joined form the workspace
 * URL uses (`?origin=manual,pr`). Returns `undefined` when the input is
 * missing or empty so the caller can treat "no filter" and "filter to
 * empty array" identically.
 */
function csvArrayPreprocess(input: unknown): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const listMeChatsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(ME_CHAT_MAX_LIMIT).default(ME_CHAT_DEFAULT_LIMIT),
  filter: meChatFilterSchema.default("all"),
  engagement: chatEngagementViewSchema.default("active"),
  /**
   * Restrict the conversation list to one or more origin tags (Manual,
   * GitHub PR, GitHub Issue, …). Omitted — i.e. unfiltered — returns
   * every origin the caller is in. The wire accepts both repeated
   * query params (`?origin=manual&origin=pr`) and the comma-joined
   * form (`?origin=manual,pr`) the workspace URL uses.
   *
   * Replaces the Phase A `source` single-enum field. Web parsers
   * upgrade `?source=foo` → `?origin=foo` for backward compatibility
   * with shared links and bookmarks; this schema deliberately does NOT
   * accept the legacy single-value name so the wire stays canonical.
   */
  origin: z.preprocess(csvArrayPreprocess, z.array(chatSourceSchema).optional()),
  /**
   * Restrict the conversation list to chats the named agents
   * participate in (speakers only — watcher membership is excluded
   * because the list itself surfaces watcher rows via
   * `MeChatRow.membershipKind`). Same CSV-or-repeated wire shape as
   * `origin`. Resolved server-side via a `chat_membership` subquery.
   */
  with: z.preprocess(csvArrayPreprocess, z.array(z.string().min(1)).optional()),
  /**
   * When `true`, restrict to chats where the caller's own membership is
   * `'watcher'`. Independent of `filter` — the two can compose
   * ("unread AND watching"). Accepts the strings `"1"` / `"true"` from
   * URL query, plus the JSON boolean for direct API calls.
   */
  watching: z.preprocess((v) => {
    if (typeof v === "string") {
      if (v === "1" || v.toLowerCase() === "true") return true;
      if (v === "0" || v.toLowerCase() === "false" || v === "") return false;
    }
    return v;
  }, z.boolean().optional()),
});
export type ListMeChatsQuery = z.infer<typeof listMeChatsQuerySchema>;

export const meChatParticipantSchema = z.object({
  agentId: z.string(),
  displayName: z.string(),
  type: z.string(),
  /**
   * Manager-selected avatar color token (one of `AVATAR_COLOR_TOKENS`).
   * NULL = auto — renderer falls back to the deterministic djb2 hash of
   * `agentId`. Kept as a loose string here (matching `type`) so DB rows
   * with legacy / unrecognised values flow through harmlessly; the web
   * renderer guards on the known set.
   */
  avatarColorToken: z.string().nullable(),
  /**
   * Synthesized URL for the manager-uploaded avatar image, or NULL when
   * the agent has no image and the renderer should fall back to
   * color + initial.
   */
  avatarImageUrl: z.string().nullable(),
});
export type MeChatParticipant = z.infer<typeof meChatParticipantSchema>;

/**
 * Live activity hint surfaced in the conversation row's time slot. Derived
 * server-side from the latest `session_events` row for the chat. See
 * `MeChatRow.liveActivity` for the lifecycle rules.
 *
 * `kind` is intentionally narrower than the full `sessionEventKind` enum:
 * `turn_end` / `error` produce `liveActivity: null` rather than a live
 * indicator.
 */
export const liveActivityKindSchema = z.enum(["tool_call", "thinking", "assistant_text"]);
export type LiveActivityKind = z.infer<typeof liveActivityKindSchema>;

export const liveActivitySchema = z.object({
  agentId: z.string(),
  kind: liveActivityKindSchema,
  /** Short user-facing label, e.g. "Read", "Thinking", "Writing". */
  label: z.string(),
  /** ISO timestamp of the originating event; web uses this as the ticker base. */
  startedAt: z.string(),
  /**
   * Optional truncated context for the activity, already trimmed server-side:
   *   - tool_call → a preview of the tool's args (e.g. "npm test" for Bash, a
   *     path for Read). Absent when there are no useful args.
   *   - assistant_text → a one-line preview of the reply body the model is
   *     writing (collapsed + capped to {@link ASSISTANT_TEXT_PREVIEW_MAX}), so
   *     the compose status bar can read out *what* the agent is saying instead
   *     of a static "Writing". Absent when the text block is empty.
   * Only the compose status bar (the focal "what's happening now" strip)
   * renders it; the chat-row WorkingChip and the AgentRow second line
   * intentionally stay at `Using <tool> · <timer>` without it. Absent for
   * thinking.
   */
  detail: z.string().optional(),
  /**
   * The current turn's latest `assistant_text`, one-line preview (collapsed +
   * capped to {@link ASSISTANT_TEXT_PREVIEW_MAX}). Distinct from `detail`,
   * which describes the *latest event*: `turnText` is the agent's running
   * narration for the whole turn, so a `tool_call` fired immediately after a
   * sentence does not bury what the agent is saying. Populated only by the
   * per-agent status path (`/agent-status`, `withTurnText`) and rendered only
   * by the compose status bar's sticky lead; absent on the chat-list
   * `liveActivity`, and absent when the turn has produced no prose yet.
   */
  turnText: z.string().optional(),
  /**
   * @deprecated Full current-turn output is fetched on demand from the
   * current-turn narrations endpoint. Kept optional for source compatibility
   * across rolling web/server releases; the status service no longer fills it.
   */
  turnTextFull: z.string().optional(),
  /**
   * ISO timestamp at which this activity goes stale (= `startedAt` +
   * `LIVE_ACTIVITY_STALE_MS`). The server already drops stale activities at
   * read time; this lets a live surface's 1s ticker clear a lingering
   * "working" chip precisely at expiry — re-deriving `main` once `now > staleAt`
   * — instead of waiting for the next refetch. Optional for version skew:
   * clients fall back to `startedAt + LIVE_ACTIVITY_STALE_MS` when absent.
   */
  staleAt: z.string().optional(),
});
export type LiveActivity = z.infer<typeof liveActivitySchema>;

/** Stale threshold (ms) past which a `session_events` row stops driving liveActivity. */
export const LIVE_ACTIVITY_STALE_MS = 60_000;

/**
 * Max length of the assistant-text reply preview surfaced in
 * `LiveActivity.detail` for the compose status bar. Purely a wire bound (the
 * stored block can be up to 8000 chars) — the visible length is capped far
 * lower by the rail's CSS `max-width`, so this sits beyond what ever renders
 * and the on-screen ellipsis stays CSS-driven. No trailing "…" is appended.
 */
export const ASSISTANT_TEXT_PREVIEW_MAX = 120;

/**
 * @deprecated Full current-turn output is no longer carried by the compact
 * agent-status response. Kept for source compatibility with older consumers.
 */
export const ASSISTANT_TEXT_FULL_MAX = 2000;

export const meChatRowSchema = z.object({
  chatId: z.string(),
  type: z.string(),
  membershipKind: meChatMembershipKindSchema,
  /**
   * True when the caller's membership row is the chat owner. The web rail
   * combines this with `source === "manual"` for the MINE bucket, without
   * exposing the full membership role enum on the public row contract.
   * Defaulted for web-ahead deploys so older servers keep grouping those rows
   * under their normal source bucket.
   */
  createdByMe: z.boolean().default(false),
  /**
   * Coarse-grained origin — `manual` / `github`. Mirrors the
   * projection driven by `chatSourceSqlExpression` in
   * `services/me-chat.ts`. Drives the rail's filter popover and
   * the Group-by-Source bucket assignment.
   *
   * Defaulted to `"manual"` for parse-side defence-in-depth: this
   * schema is consumed by web clients that may briefly be ahead of an
   * old server build (web rolls before server). Without the default, a
   * server response missing `source` would fail validation and blank
   * the rail. Live server responses always populate `source` via
   * `chatSourceSqlExpression`, so the default is only ever observed
   * across version skew.
   */
  source: chatSourceSchema.default("manual"),
  /**
   * Within-origin sub-type. Only meaningful when `source === "github"`,
   * in which case it's one of `pull_request | issue | discussion | commit`
   * — drives the per-row leading icon so users still get a PR vs Issue
   * vs Commit glyph even though the filter popover collapses every
   * GitHub entity into a single "GitHub" origin. Null for `manual` rows.
   *
   * Server projects this straight from `chats.metadata->>'entityType'`
   * (no DB migration). Adding new GitHub entity types means extending
   * `GITHUB_ENTITY_TYPES` in `chat-metadata.ts` — the row schema picks
   * the new value up automatically through the shared
   * `githubEntityTypeSchema`.
   *
   * Defaulted to `null` for the same defence-in-depth reason `source`
   * carries a default: an older server build that doesn't yet include
   * this column would otherwise produce `undefined`, which fails a
   * runtime Zod parse (if web ever adopts one) and could surprise
   * `SourceIcon`'s null-check. The default keeps the contract closed.
   */
  entityType: githubEntityTypeSchema.nullable().default(null),
  title: z.string(),
  topic: z.string().nullable(),
  /**
   * Chat-level work summary + status report (the chat's `description`
   * column). It serves two readers at once: the agent / a teammate
   * reconstructing what the task is and where it stands, and the human
   * reading the current task status. Holds task background + plan +
   * progress and may use Markdown. Rendered as the conversation row's
   * second line so a glance tells you what each thread is and where it
   * stands; `null` when the owner hasn't set one (the row shows a skeleton
   * placeholder to keep cards equal height). `.default(null)` for version
   * skew — a server build predating this field would otherwise blank the
   * row on a web-ahead deploy.
   */
  description: z.string().nullable().default(null),
  participants: z.array(meChatParticipantSchema),
  participantCount: z.number().int(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  unreadMentionCount: z.number().int(),
  /**
   * Count of open questions (`format=request` messages) directed at the
   * caller in this chat and not yet answered by them. Drives the re-introduced
   * `needs_you` red-dot. Answer-cleared, NOT read-cleared — independent of
   * `unreadMentionCount`. `.default(0)` for version skew (a server build that
   * predates this field leaves the dot off rather than blanking the row).
   * See proposals/group-chat-unified-send §D1.
   */
  openRequestCount: z.number().int().default(0),
  canReply: z.boolean(),
  engagementStatus: chatEngagementStatusSchema,
  /**
   * Live "working right now" signal derived from the latest `session_events`
   * row for this chat. Null when:
   *   - no events recorded for this chat, OR
   *   - the latest event is `turn_end` / `error`, OR
   *   - the latest event is older than the stale threshold (60 s).
   *
   * Web renders this in the lastMessageAt slot with a pulsing dot + label
   * + auto-incrementing seconds counter.
   */
  liveActivity: liveActivitySchema.nullable(),
  /**
   * Speakers in this chat whose composite status is `failed` — i.e. reachable
   * and either their per-(agent,chat) session is `errored` OR their global
   * runtime is in `error` (the same `errored` input `getChatAgentStatuses`
   * folds into `failed`; an unreachable agent is `offline`, not `failed`, so
   * those are excluded). Drives the chat-list "failed" attention signal
   * (red `!` badge) without opening the chat. Per-chat, derived at query
   * time (no schema migration). `.default([])` for version skew: an older
   * server build that predates this field would otherwise blank the row on a
   * web-ahead deploy.
   */
  failedAgentIds: z.array(z.string()).default([]),
  /**
   * Speakers in this chat whose composite status is `working` — the D-axis
   * "is a turn in flight right now in THIS chat" signal. Drives the chat-list
   * activity indicator directly so it lights up even when a runtime emits no
   * intermediate `session_events` (e.g. codex tools that only emit on turn
   * completion) — the case `liveActivity` alone cannot cover. `liveActivity`
   * stays as the *description* ("Using Bash · 12s") when available; this set
   * is the authority for "is anyone working". Derived at query time from
   * `agent_chat_sessions.runtime_state` (per-chat). `.default([])` for
   * version skew (web bundle older than server), same rationale as
   * `failedAgentIds`.
   *
   * NAMING: deliberately NOT `workingAgentIds` — that name was a retired
   * agent-global misnomer behind the #366 cross-chat false-positive. The
   * per-chat replacement uses a fresh name to avoid resurrecting the
   * poisoned identifier.
   */
  busyAgentIds: z.array(z.string()).default([]),
  /**
   * True iff there exists at least one unread message in this chat whose
   * `messages.metadata.mentions` array explicitly contains the caller's
   * human-agent UUID. Drives the chat-list "Needs attention" mention rule on
   * the front-end after the explicit-mention narrowing (Phase 1 of the
   * three-rule simplification).
   *
   * Distinguishes explicit `@<me>` from the v1 1-on-1 implicit DM
   * auto-mention (`services/message.ts:282 dmAutoProjection`): the latter
   * still bumps `unreadMentionCount` for the red dot but never writes the
   * recipient into `metadata.mentions`, so a 1-on-1 agent → human plain
   * final message correctly leaves `chatHasExplicitMentionToMe = false` and
   * stops pinning the chat into Needs attention.
   *
   * Unread window = `(cus.last_read_at, NOW()]`; NULL `last_read_at` means
   * "never read", treated as "every message counts".
   *
   * Derived at query time via a correlated `EXISTS` on `messages`. No schema
   * migration. `.default(false)` for version skew: an older server build
   * that predates this field would otherwise produce `undefined`, which —
   * combined with the strict `=== true` check in the front-end predicate
   * (`group-rows.ts`) — silently disables the explicit-mention rule on the
   * new web during a web-ahead-of-server rollout. R1 (failed) keeps firing.
   */
  chatHasExplicitMentionToMe: z.boolean().default(false),
  /**
   * Per-user pin timestamp (ISO), or null when not pinned. Private per-user
   * state from `chat_user_state.pinned_at` — one user pinning a chat never
   * affects another. `.default(null)` for version skew: a server build that
   * predates this column returns no value, which must read as "not pinned"
   * rather than `undefined`.
   */
  pinnedAt: z.string().nullable().default(null),
  /**
   * Work-activity timestamp (ISO) — the conversation list's recency sort key.
   * `max(last_message_at, description_updated_at, created_at)`, advanced only by
   * real work (a new message or a genuine description change), never by topic
   * rename / read / pin / archive / participant / runtime busy. `.default(null)`
   * for version skew; the server always populates it once the column ships.
   */
  activityAt: z.string().nullable().default(null),
});
export type MeChatRow = z.infer<typeof meChatRowSchema>;

/**
 * Priority groups extracted server-side across the *full matching set* (the same
 * engagement / origin / participant / unread / watch filters as the ordinary
 * list, just without the loaded-page boundary), rendered above the ordinary
 * list. Populated on the FIRST page only (a request with no `cursor`); empty on
 * load-more pages, which the client reads from page 0.
 *   - `attention`: chats needing the viewer now — a *caller-managed* non-human
 *     speaker in `failed`, or an open request addressed to the viewer — ordered
 *     failed-first, then by `activityAt` DESC. (A peer's failed agent / another
 *     human's request stays in the ordinary stream.)
 *   - `pinned`: the viewer's pinned chats (private per-user state), ordered by
 *     `pinnedAt` DESC, excluding any already surfaced in `attention`.
 *
 * `attention` and `pinned` are server-DISJOINT (a chat is in at most one of the
 * two). The ordinary `rows`, however, are ADDITIVE: a priority chat is NOT
 * removed from `rows` (that keeps the response backward-compatible with a client
 * that ignores these groups). A client that renders the groups must therefore
 * de-duplicate `rows` against the priority chat ids so each chat shows once
 * (attention > pinned > recency).
 *
 * `.default({...})` for version skew: a web bundle ahead of a server that
 * predates these groups reads them as empty rather than `undefined`.
 */
export const meChatPriorityRowsSchema = z
  .object({
    attention: z.array(meChatRowSchema),
    pinned: z.array(meChatRowSchema),
  })
  .default({ attention: [], pinned: [] });
export type MeChatPriorityRows = z.infer<typeof meChatPriorityRowsSchema>;

export const listMeChatsResponseSchema = z.object({
  priorityRows: meChatPriorityRowsSchema,
  rows: z.array(meChatRowSchema),
  nextCursor: z.string().nullable(),
  // NOTE: a global unread `counts` aggregate is intentionally NOT part of this
  // response yet — its scope (global vs the active engagement view) is a product
  // decision that belongs with the unread badge that consumes it, landing in the
  // desktop-rail PR. Adding it here first would publish an unsettled contract.
});
export type ListMeChatsResponse = z.infer<typeof listMeChatsResponseSchema>;

export const createMeChatSchema = z.object({
  participantIds: z.array(z.string().min(1)).min(1),
  topic: z.string().trim().max(500).optional().nullable(),
});
export type CreateMeChat = z.infer<typeof createMeChatSchema>;

export const addMeChatParticipantsSchema = z.object({
  participantIds: z.array(z.string().min(1)).min(1),
});
export type AddMeChatParticipants = z.infer<typeof addMeChatParticipantsSchema>;

export const meChatReadResponseSchema = z.object({
  chatId: z.string(),
  lastReadAt: z.string(),
  unreadMentionCount: z.number().int(),
});
export type MeChatReadResponse = z.infer<typeof meChatReadResponseSchema>;

export const meChatUnreadResponseSchema = z.object({
  chatId: z.string(),
  unreadMentionCount: z.number().int(),
});
export type MeChatUnreadResponse = z.infer<typeof meChatUnreadResponseSchema>;

/** Body for `POST /chats/:chatId/pin` — pin (`true`) or unpin (`false`). */
export const pinMeChatSchema = z.object({
  pinned: z.boolean(),
});
export type PinMeChat = z.infer<typeof pinMeChatSchema>;

export const meChatPinResponseSchema = z.object({
  chatId: z.string(),
  /** ISO pin timestamp when pinned, null when unpinned. */
  pinnedAt: z.string().nullable(),
});
export type MeChatPinResponse = z.infer<typeof meChatPinResponseSchema>;

export const meChatLeaveResponseSchema = z.object({
  chatId: z.string(),
  membershipKind: meChatMembershipKindSchema.nullable(),
});
export type MeChatLeaveResponse = z.infer<typeof meChatLeaveResponseSchema>;

/** Realtime WS frame: nudge web clients to invalidate `["me","chats"]`. */
export const chatMessageFrameSchema = z.object({
  type: z.literal("chat:message"),
  chatId: z.string(),
});
export type ChatMessageFrame = z.infer<typeof chatMessageFrameSchema>;

/**
 * Per-source aggregate for the conversation-list tag bar.
 *
 *   - `chatCount` — number of chats the caller is in for this source. Used
 *     to hide tags whose count is 0 ("don't render a PR tag if there are no
 *     PRs").
 *   - `unreadChatCount` — number of chats whose `unread_mention_count > 0`.
 *     This is "chats with unread mentions", NOT "total mention count", so
 *     the badge on each tag matches the semantics of the existing `unread`
 *     filter pill (`totalUnread` in `pages/workspace/conversations`) — a
 *     `2` on the PR tag means "2 PR chats have unread mentions", which is
 *     what a user expects to click into.
 *
 * The map ALWAYS contains the `manual` key (the default tab is always
 * available, even at zero counts); other keys are present only when the
 * caller has at least one chat for that source.
 */
export const chatSourceCountSchema = z.object({
  chatCount: z.number().int().nonnegative(),
  unreadChatCount: z.number().int().nonnegative(),
});
export type ChatSourceCount = z.infer<typeof chatSourceCountSchema>;

export const listMeChatSourceCountsQuerySchema = z.object({
  engagement: chatEngagementViewSchema.default("active"),
});
export type ListMeChatSourceCountsQuery = z.infer<typeof listMeChatSourceCountsQuerySchema>;

export const meChatSourceCountsSchema = z.object({
  /**
   * Map keyed by ChatSource. Keys absent from the map mean "no chats for that
   * source"; the client must not render a tag for them. `manual` is always
   * present. `partialRecord` (not `record`) so the union of optional keys is
   * preserved on the TypeScript side — the server only emits keys whose
   * `chatCount > 0` (plus `manual`).
   */
  counts: z.partialRecord(chatSourceSchema, chatSourceCountSchema),
});
export type MeChatSourceCounts = z.infer<typeof meChatSourceCountsSchema>;
