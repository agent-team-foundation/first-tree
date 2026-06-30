import { z } from "zod";

export const activeRuntimeChatIdsResponseSchema = z.object({
  chatIds: z.array(z.string().min(1)),
});
export type ActiveRuntimeChatIdsResponse = z.infer<typeof activeRuntimeChatIdsResponseSchema>;
