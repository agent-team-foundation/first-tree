import { z } from "zod";

export const sessionOutputSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  chatId: z.string(),
  content: z.string(),
  updatedAt: z.string(),
});
export type SessionOutput = z.infer<typeof sessionOutputSchema>;

/** WS message: client reports session output text to server. */
export const sessionOutputMessageSchema = z.object({
  agentId: z.string(),
  chatId: z.string(),
  content: z.string().max(50_000),
});
export type SessionOutputMessage = z.infer<typeof sessionOutputMessageSchema>;
