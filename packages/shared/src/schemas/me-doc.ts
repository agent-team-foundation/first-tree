import { z } from "zod";

export const workspaceDocRefSchema = z.object({
  type: z.literal("workspace"),
  chatId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  basePath: z.string().trim().optional(),
  path: z.string().trim().min(1),
});
export type WorkspaceDocRef = z.infer<typeof workspaceDocRefSchema>;

export const getMeDocSchema = z.object({
  agentId: z.string().trim().min(1),
  basePath: z.string().trim().optional(),
  path: z.string().trim().min(1),
});
export type GetMeDoc = z.infer<typeof getMeDocSchema>;

export const getMeDocResponseSchema = z.object({
  ref: workspaceDocRefSchema,
  path: z.string(),
  content: z.string(),
});
export type GetMeDocResponse = z.infer<typeof getMeDocResponseSchema>;
