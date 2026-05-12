import { z } from "zod";
import { optionalChatMetadataSchema } from "./chat-metadata.js";

export const CHAT_TYPES = {
  DIRECT: "direct",
  GROUP: "group",
  THREAD: "thread",
} as const;

export const chatTypeSchema = z.enum(["direct", "group", "thread"]);
export type ChatType = z.infer<typeof chatTypeSchema>;

export const createChatSchema = z.object({
  type: chatTypeSchema,
  topic: z.string().max(500).optional(),
  participantIds: z.array(z.string()).min(1),
  metadata: optionalChatMetadataSchema.optional(),
});
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
});
export type ChatParticipantDetail = z.infer<typeof chatParticipantDetailSchema>;

export const chatSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: z.string(),
  topic: z.string().nullable(),
  lifecyclePolicy: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Chat = z.infer<typeof chatSchema>;

export const chatDetailSchema = chatSchema.extend({
  participants: z.array(chatParticipantSchema),
  /** Server-resolved display title. Priority: `topic` > first message
   *  preview > participant join. Clients should render this directly
   *  rather than re-implementing the fallback chain. */
  title: z.string(),
  /** First message body's text summary (≤ 50 code points), or null if
   *  the chat has no messages yet (or the first message is a file/image
   *  with no `text` field). Exposed alongside the resolved `title` so
   *  callers can use it for tooltips / hover descriptions. */
  firstMessagePreview: z.string().nullable(),
});
export type ChatDetail = z.infer<typeof chatDetailSchema>;

export const updateChatSchema = z.object({
  topic: z.string().trim().max(500).nullable(),
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
export const addParticipantSchema = z.object({
  agentId: z.string().min(1),
});
export type AddParticipant = z.infer<typeof addParticipantSchema>;

export const removeParticipantSchema = z.object({
  agentId: z.string().min(1),
});
export type RemoveParticipant = z.infer<typeof removeParticipantSchema>;
