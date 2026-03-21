import { z } from "zod";

export const createAgentTokenSchema = z.object({
  name: z.string().max(100).optional(),
  expiresAt: z.string().datetime().optional(),
});
export type CreateAgentToken = z.infer<typeof createAgentTokenSchema>;

export const agentTokenSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type AgentToken = z.infer<typeof agentTokenSchema>;

export const agentTokenCreatedSchema = agentTokenSchema.extend({
  token: z.string(),
});
export type AgentTokenCreated = z.infer<typeof agentTokenCreatedSchema>;
