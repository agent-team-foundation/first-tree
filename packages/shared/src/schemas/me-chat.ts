import { z } from "zod";
import { chatEngagementStatusSchema } from "./chat.js";
import { chatSourceSchema } from "./chat-metadata.js";

/**
 * Member-facing chat APIs (`/me/chats*`) for the chat-first workspace.
 * See docs/chat-first-workspace-product-design.md "API Contract".
 */

export const ME_CHAT_FILTERS = ["all", "unread", "watching"] as const;
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

export const listMeChatsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(ME_CHAT_MAX_LIMIT).default(ME_CHAT_DEFAULT_LIMIT),
  filter: meChatFilterSchema.default("all"),
  engagement: chatEngagementViewSchema.default("active"),
  /**
   * Restrict the conversation list to a single source tag (Manual, GitHub PR,
   * GitHub Issue, …). Omitted — i.e. unfiltered — returns every source the
   * caller is in; the workspace UI defaults to `manual`.
   */
  source: chatSourceSchema.optional(),
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
});
export type LiveActivity = z.infer<typeof liveActivitySchema>;

/** Stale threshold (ms) past which a `session_events` row stops driving liveActivity. */
export const LIVE_ACTIVITY_STALE_MS = 60_000;

export const meChatRowSchema = z.object({
  chatId: z.string(),
  type: z.string(),
  membershipKind: meChatMembershipKindSchema,
  /**
   * Origin classification — mirrors the projection that drives
   * `listMeChatsQuery.source` (see `chatSourceSqlExpression` in
   * `services/me-chat.ts`). Surfaced on the row so the rail can render
   * a per-source leading icon and group rows by origin without a
   * second lookup.
   *
   * Defaulted to `"manual"` for parse-side defence-in-depth: this
   * schema is consumed by web clients that may briefly be ahead of an
   * old server build (web rolls before server). Without the default, a
   * server response missing `source` would fail validation and blank
   * the rail. With the default, the row decodes and the icon falls
   * back to the Manual placeholder until the server catches up. Live
   * server responses always populate `source` via
   * `chatSourceSqlExpression`, so the default is only ever observed
   * across version skew.
   */
  source: chatSourceSchema.default("manual"),
  title: z.string(),
  topic: z.string().nullable(),
  participants: z.array(meChatParticipantSchema),
  participantCount: z.number().int(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  unreadMentionCount: z.number().int(),
  canReply: z.boolean(),
  engagementStatus: chatEngagementStatusSchema,
  /**
   * Speakers in this chat with an active per-(agent,chat) session
   * (`agent_chat_sessions.state === 'active'`). Drives the breathing ring
   * around the avatar — "session online, can be reached". Per-pair signal,
   * not affected by the agent's activity in other chats. Independent of
   * `liveActivity` (which is the live "working right now" signal).
   *
   * Always returned, possibly empty. No schema migration required: derived
   * at query time from the existing `agent_chat_sessions` table.
   */
  engagedAgentIds: z.array(z.string()),
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
});
export type MeChatRow = z.infer<typeof meChatRowSchema>;

export const listMeChatsResponseSchema = z.object({
  rows: z.array(meChatRowSchema),
  nextCursor: z.string().nullable(),
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
