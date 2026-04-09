import { z } from "zod";

export const orgStatsSchema = z.object({
  organizationId: z.string(),
  agentCount: z.number(),
  chatCount: z.number(),
  messageCount: z.number(),
});
export type OrgStats = z.infer<typeof orgStatsSchema>;

export const statsSchema = z.object({
  totalAgents: z.number(),
  totalChats: z.number(),
  totalMessages: z.number(),
  byOrganization: z.array(orgStatsSchema),
});
export type Stats = z.infer<typeof statsSchema>;
