import { z } from "zod";

/** Client → server: list locally-held chatIds; server replies with the subset to drop. */
export const sessionReconcileRequestSchema = z.object({
  type: z.literal("session:reconcile"),
  agentId: z.string().min(1),
  chatIds: z.array(z.string().min(1)).max(500),
});
export type SessionReconcileRequest = z.infer<typeof sessionReconcileRequestSchema>;

export const sessionReconcileResultSchema = z.object({
  type: z.literal("session:reconcile:result"),
  agentId: z.string().min(1),
  staleChatIds: z.array(z.string().min(1)),
});
export type SessionReconcileResult = z.infer<typeof sessionReconcileResultSchema>;
