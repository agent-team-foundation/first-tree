import { z } from "zod";

export const gitlabReviewerModeSchema = z.enum(["unknown", "assignee", "reviewers"]);
export type GitlabReviewerMode = z.infer<typeof gitlabReviewerModeSchema>;

export const gitlabConnectionCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  instanceOrigin: z.url(),
});
export type GitlabConnectionCreate = z.infer<typeof gitlabConnectionCreateSchema>;

export const gitlabAutomaticActionsUpdateSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), acceptTeamWideUrlBearerRisk: z.literal(true) }),
]);
export type GitlabAutomaticActionsUpdate = z.infer<typeof gitlabAutomaticActionsUpdateSchema>;

export const gitlabConnectionDisableSchema = z.object({ mode: z.enum(["normal", "incident"]) });
export type GitlabConnectionDisable = z.infer<typeof gitlabConnectionDisableSchema>;

export const gitlabConnectionSummarySchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  displayName: z.string(),
  instanceOrigin: z.string(),
  active: z.boolean(),
  recoveryPending: z.boolean(),
  automaticActionsEnabled: z.boolean(),
  reviewerMode: gitlabReviewerModeSchema,
  endpoint: z.object({
    currentGeneration: z.number().int().positive().nullable(),
    previousGeneration: z.number().int().positive().nullable(),
    currentSeen: z.boolean(),
  }),
  health: z.object({
    lastValidInboundAt: z.string().nullable(),
    lastProcessingFailureAt: z.string().nullable(),
    lastProcessingFailureCode: z.string().nullable(),
  }),
  disabledAt: z.string().nullable(),
  disabledMode: z.enum(["normal", "incident"]).nullable(),
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
