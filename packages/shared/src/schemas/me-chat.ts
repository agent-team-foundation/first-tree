import { z } from "zod";

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

export const listMeChatsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(ME_CHAT_MAX_LIMIT).default(ME_CHAT_DEFAULT_LIMIT),
  filter: meChatFilterSchema.default("all"),
});
export type ListMeChatsQuery = z.infer<typeof listMeChatsQuerySchema>;

export const meChatParticipantSchema = z.object({
  agentId: z.string(),
  displayName: z.string(),
  type: z.string(),
});
export type MeChatParticipant = z.infer<typeof meChatParticipantSchema>;

export const meChatRowSchema = z.object({
  chatId: z.string(),
  type: z.string(),
  membershipKind: meChatMembershipKindSchema,
  title: z.string(),
  topic: z.string().nullable(),
  participants: z.array(meChatParticipantSchema),
  participantCount: z.number().int(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  unreadMentionCount: z.number().int(),
  canReply: z.boolean(),
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
