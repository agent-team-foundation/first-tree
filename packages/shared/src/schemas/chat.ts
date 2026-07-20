import { z } from "zod";
import { optionalChatMetadataSchema } from "./chat-metadata.js";
import { contextReviewTaskCreateMetadataSchema } from "./context-review.js";
import { landingCampaignActionContextSchema, landingCampaignRepoSlugSchema } from "./landing-campaign.js";
import { sendMessageSchema } from "./message.js";

export const CHAT_TYPES = {
  DIRECT: "direct",
  GROUP: "group",
} as const;

export const chatTypeSchema = z.enum(["direct", "group"]);
export type ChatType = z.infer<typeof chatTypeSchema>;

/**
 * Per-(chat, user) engagement state. Stored on `chat_user_state` so each
 * user manages their own view independently of structural membership.
 *
 *   active   — default; chat is in the user's active conversation list.
 *   archived — user-snoozed; auto-revives to `active` when a new message
 *              lands in the chat (see `services/chat-projection.ts`).
 *   deleted  — user-removed; never auto-revives. Restorable only by the
 *              user from the chat detail page.
 */
export const CHAT_ENGAGEMENT_STATUSES = {
  ACTIVE: "active",
  ARCHIVED: "archived",
  DELETED: "deleted",
} as const;

export const chatEngagementStatusSchema = z.enum(["active", "archived", "deleted"]);
export type ChatEngagementStatus = z.infer<typeof chatEngagementStatusSchema>;

export const patchChatEngagementSchema = z.object({
  status: chatEngagementStatusSchema,
});
export type PatchChatEngagement = z.infer<typeof patchChatEngagementSchema>;

/**
 * First Tree keeps a single group-chat model (see first-tree-context PR #281),
 * so every newly created chat MUST be a `group`. `chatTypeSchema` survives
 * for the read path (legacy `direct` rows still exist on disk and must
 * deserialise), but the write path is locked down to `"group"` — a caller
 * that explicitly sends `type: "direct"` gets a 400 instead of silently
 * minting a new `direct` row.
 */
export const legacyCreateChatSchema = z.object({
  type: z.literal("group"),
  topic: z.string().max(500).optional(),
  participantIds: z.array(z.string()).min(1),
  metadata: optionalChatMetadataSchema.optional(),
});
export type LegacyCreateChat = z.infer<typeof legacyCreateChatSchema>;

const createTaskChatShape = {
  mode: z.literal("task"),
  topic: z.string().trim().max(500).nullable().optional(),
  // Description cap matches `updateChatSchema` (1500) — see the rationale there.
  description: z.string().trim().max(1500).nullable().optional(),
  initialRecipientAgentIds: z.array(z.string().min(1)).default([]),
  initialRecipientNames: z.array(z.string().min(1)).default([]),
  contextParticipantAgentIds: z.array(z.string().min(1)).default([]),
  contextParticipantNames: z.array(z.string().min(1)).default([]),
  initialMessage: sendMessageSchema,
} as const;

const hasInitialRecipient = (value: { initialRecipientAgentIds: string[]; initialRecipientNames: string[] }) =>
  value.initialRecipientAgentIds.length > 0 || value.initialRecipientNames.length > 0;

/** Agent SDK task-chat request accepted by `/api/v1/agent/chats`. */
export const createTaskChatSchema = z.object(createTaskChatShape).refine(hasInitialRecipient, {
  message: "task chat creation requires at least one initial recipient",
});
export type CreateTaskChat = z.infer<typeof createTaskChatSchema>;

/** Signed-in Web task-chat request accepted by `/api/v1/orgs/:orgId/chats`. */
export const createWebTaskChatSchema = z
  .object({
    ...createTaskChatShape,
    // Trusted landing-campaign action context. The server derives the shared
    // idempotency key from this pair; the browser never supplies the key.
    campaignAction: landingCampaignActionContextSchema.optional(),
    // Compatibility for already-deployed production-scan clients.
    scanFixRepoSlug: landingCampaignRepoSlugSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.campaignAction && value.scanFixRepoSlug) {
      ctx.addIssue({ code: "custom", message: "Use campaignAction or scanFixRepoSlug, not both." });
    }
  })
  .refine(hasInitialRecipient, {
    message: "task chat creation requires at least one initial recipient",
  });
export type CreateWebTaskChat = z.infer<typeof createWebTaskChatSchema>;

/**
 * Member-authenticated Agent Review dispatch accepted by the existing org
 * chat collection. Recipient, topic, sender, provenance, and idempotency key
 * are server-derived and therefore absent from this strict request.
 */
export const createKeyedTaskChatSchema = z
  .object({
    mode: z.literal("keyed_task"),
    initialMessage: z
      .object({
        format: z.literal("markdown"),
        content: z.string().trim().min(1),
        metadata: contextReviewTaskCreateMetadataSchema,
      })
      .strict(),
  })
  .strict();
export type CreateKeyedTaskChat = z.infer<typeof createKeyedTaskChatSchema>;

export const keyedTaskChatCreateResponseSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
  topic: z.string().min(1).nullable(),
  effectiveSenderId: z.string().min(1),
  reviewerAgentUuid: z.string().min(1),
  outcome: z.enum(["created", "reused"]),
  managedReviewReceiptV1: z
    .object({
      schemaVersion: z.literal(1),
      repository: z
        .string()
        .trim()
        .regex(/^[^\s/]+\/[^\s/]+$/),
      pullRequest: z.number().int().positive(),
      expectedHead: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .strict(),
});
export type KeyedTaskChatCreateResponse = z.infer<typeof keyedTaskChatCreateResponseSchema>;

export const createChatSchema = z.union([createTaskChatSchema, legacyCreateChatSchema]);
export type CreateChat = z.infer<typeof createChatSchema>;

export const chatParticipantSchema = z.object({
  agentId: z.string(),
  role: z.string(),
  mode: z.string(),
  joinedAt: z.string(),
});
export type ChatParticipant = z.infer<typeof chatParticipantSchema>;

/**
 * Participant row with the agent's public-ish metadata resolved — used by the
 * client runtime for `@<name>` mention extraction against the authoritative
 * participant set (see proposals/hub-agent-messaging-reply-and-mentions §4).
 */
export const chatParticipantDetailSchema = chatParticipantSchema.extend({
  name: z.string().nullable(),
  /**
   * Non-null after Phase 2 of the agent-naming refactor — migration 0024
   * enforces `agents.display_name NOT NULL`, so every participant resolves
   * to a real label the client can render.
   */
  displayName: z.string(),
  type: z.string(),
  /**
   * Manager-selected avatar color token (one of `AVATAR_COLOR_TOKENS`).
   * NULL = auto — renderer falls back to the deterministic djb2 hash of
   * `agentId`. Kept as a loose string here (matching `type`) so DB rows
   * with legacy / unrecognised values flow through harmlessly. Mirrors
   * `meChatParticipantSchema` so the chat detail surface (header chips,
   * right-sidebar agent rows) renders the same color the left rail does.
   */
  avatarColorToken: z.string().nullable(),
  /**
   * Synthesized URL for the manager-uploaded avatar image, or NULL when
   * the agent has no image and the renderer should fall back to
   * color + initial.
   */
  avatarImageUrl: z.string().nullable(),
});
export type ChatParticipantDetail = z.infer<typeof chatParticipantDetailSchema>;

export const chatSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: z.string(),
  topic: z.string().nullable(),
  description: z.string().nullable(),
  lifecyclePolicy: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Chat = z.infer<typeof chatSchema>;

export const chatDetailSchema = chatSchema.extend({
  /**
   * Participants with `name / displayName / type` resolved via JOIN
   * `agents`, intentionally **not** filtered by agent visibility. The
   * authoritative trust boundary in a chat-scoped query is
   * `chat_membership`, not org-level discovery — see
   * `docs/agent-space-and-mention-visibility-design.zh-CN.md` §4.3.3.
   * The client renders chat-internal identity (mention autocomplete,
   * participant chips, message sender name) off this field so a private
   * agent that is a member of the chat shows its real name to every
   * other member, not a UUID prefix.
   */
  participants: z.array(chatParticipantDetailSchema),
  /** Server-resolved display title. Priority: `topic` > first message
   *  preview > participant join. Clients should render this directly
   *  rather than re-implementing the fallback chain. */
  title: z.string(),
  /** First message body's text summary (≤ 50 code points), or null if
   *  the chat has no messages yet (or the first message is a file/image
   *  with no `text` field). Exposed alongside the resolved `title` so
   *  callers can use it for tooltips / hover descriptions. */
  firstMessagePreview: z.string().nullable(),
  /** Caller's engagement state for this chat. Server-side COALESCE bridges
   *  the lazy-materialised `chat_user_state` row so the value is always
   *  defined (defaults to `active`); the schema is non-nullable on purpose. */
  engagementStatus: chatEngagementStatusSchema,
  /** Caller's chat-membership view: `"participant"` (speaker), `"watching"`
   *  (watcher), or `null` for supervisor / admin views where the caller has
   *  no direct row in `chat_membership` (access granted via managed agents).
   *  Mirrors the value `services/me-chat.ts` puts on `MeChatRow.membershipKind`
   *  so the chat-detail page can decide between speaker UI and watcher UI
   *  without round-tripping through the conversation-list query. */
  viewerMembershipKind: z.enum(["participant", "watching"]).nullable(),
  /**
   * Task-summary freshness for the `description` specifically (NOT the
   * row-level `updatedAt`, which a topic edit also bumps). `descriptionUpdatedAt`
   * is the ISO time of the last *real* description change — NULL when no
   * description write has landed yet, in which case the summary renders the
   * description with no freshness line rather than a fabricated one.
   * `.default(null)`: version skew, and the agent-route detail payload
   * (`services/chat.ts:getChatDetail`) does not populate it.
   */
  descriptionUpdatedAt: z.string().nullable().default(null),
  /**
   * The caller's own `chat_user_state.last_read_at` (ISO) as it stood when
   * this detail was fetched — i.e. BEFORE opening the chat marks it read.
   * The task header compares it against `descriptionUpdatedAt` to detect an
   * unread description update, and uses its age to gate the one-shot
   * auto-expand ("haven't looked in a while"). NULL when the caller has
   * never read this chat. `.default(null)`: version skew / agent-route
   * payload.
   */
  lastReadAt: z.string().nullable().default(null),
});
export type ChatDetail = z.infer<typeof chatDetailSchema>;

export const updateChatSchema = z
  .object({
    topic: z.string().trim().max(500).nullable().optional(),
    // Description carries two duties at once: the agent's / a teammate's
    // self-location summary (what this task is + where it stands) AND a
    // status report aimed at the human. It holds task background + plan +
    // progress and renders as Markdown, so the cap is wider than the topic's
    // — 1500 chars gives room for that without becoming a log (blockers /
    // decisions belong in a `--request`, not here).
    description: z.string().trim().max(1500).nullable().optional(),
  })
  .refine((v) => v.topic !== undefined || v.description !== undefined, {
    message: "Provide at least one of `topic` or `description`.",
  });
export type UpdateChat = z.infer<typeof updateChatSchema>;

/**
 * Public API body for `POST /api/v1/agent/chats/:chatId/participants`.
 * Phase 1 removed the `mode` field: participant mode is derived server-side
 * from `(chats.type, agents.type)` via `services/participant-mode.ts` and
 * cannot be overridden by the caller. The handler still inspects the raw
 * body and rejects with `400 MODE_FIELD_DEPRECATED` if `mode` is present,
 * so an out-of-tree caller that still sends it gets a clear error and a
 * telemetry counter increments — see `chat-participant-mode-fix-design.md`
 * §3.2 / §6.
 */
/**
 * Identify the target by uuid (`agentId`) or by name (`agentName`). Names are
 * resolved server-side within the chat's organization. Exactly one field
 * must be supplied — both or neither is a 400.
 */
export const addParticipantSchema = z
  .object({
    agentId: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
  })
  .refine((v) => (v.agentId === undefined) !== (v.agentName === undefined), {
    message: "addParticipant requires exactly one of `agentId` or `agentName`",
  });
export type AddParticipant = z.infer<typeof addParticipantSchema>;

export const removeParticipantSchema = z.object({
  agentId: z.string().min(1),
});
export type RemoveParticipant = z.infer<typeof removeParticipantSchema>;
