import { z } from "zod";

export const adapterBotStatusSchema = z.object({
  configId: z.number(),
  platform: z.string(),
  agentId: z.string(),
  appId: z.string(),
  connected: z.boolean(),
  lastActiveAt: z.string().nullable(),
});
export type AdapterBotStatus = z.infer<typeof adapterBotStatusSchema>;
