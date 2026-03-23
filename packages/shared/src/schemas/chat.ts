import { z } from "zod";

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
  metadata: z.record(z.unknown()).optional(),
});
export type CreateChat = z.infer<typeof createChatSchema>;

export const chatParticipantSchema = z.object({
  agentId: z.string(),
  role: z.string(),
  mode: z.string(),
  joinedAt: z.string(),
});
export type ChatParticipant = z.infer<typeof chatParticipantSchema>;

export const chatSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: z.string(),
  topic: z.string().nullable(),
  lifecyclePolicy: z.string().nullable().optional(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Chat = z.infer<typeof chatSchema>;

export const chatDetailSchema = chatSchema.extend({
  participants: z.array(chatParticipantSchema),
});
export type ChatDetail = z.infer<typeof chatDetailSchema>;

export const addParticipantSchema = z.object({
  agentId: z.string().min(1),
  mode: z.enum(["full", "mention_only"]).default("full"),
});
export type AddParticipant = z.infer<typeof addParticipantSchema>;

export const removeParticipantSchema = z.object({
  agentId: z.string().min(1),
});
export type RemoveParticipant = z.infer<typeof removeParticipantSchema>;
