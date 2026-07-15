import { z } from "zod";

export const gitlabConnectionCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  instanceOrigin: z.url(),
});
export type GitlabConnectionCreate = z.infer<typeof gitlabConnectionCreateSchema>;

export const gitlabConnectionSummarySchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  displayName: z.string(),
  instanceOrigin: z.string(),
  endpointSeen: z.boolean(),
  health: z.object({
    lastValidInboundAt: z.string().nullable(),
    lastProcessingFailureAt: z.string().nullable(),
    lastProcessingFailureCode: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GitlabConnectionSummary = z.infer<typeof gitlabConnectionSummarySchema>;

export const gitlabConnectionSecretResponseSchema = z.object({
  connection: gitlabConnectionSummarySchema,
  webhookUrl: z.string().min(1),
});
export type GitlabConnectionSecretResponse = z.infer<typeof gitlabConnectionSecretResponseSchema>;

export const followGitlabEntitySchema = z.object({
  connectionId: z.string().min(1),
  entityUrl: z.url(),
});
export type FollowGitlabEntity = z.infer<typeof followGitlabEntitySchema>;
