import { z } from "zod";

export const PRESENCE_STATUSES = {
  ONLINE: "online",
  OFFLINE: "offline",
} as const;

export const presenceStatusSchema = z.enum(["online", "offline"]);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

export const agentPresenceSchema = z.object({
  agentId: z.string(),
  status: presenceStatusSchema,
  connectedAt: z.string().nullable(),
  lastSeenAt: z.string(),
});
export type AgentPresence = z.infer<typeof agentPresenceSchema>;
