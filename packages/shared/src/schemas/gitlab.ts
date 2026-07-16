import { z } from "zod";

export const GITLAB_REVIEWER_MODES = ["unknown", "assignee", "reviewers"] as const;
export const gitlabReviewerModeSchema = z.enum(GITLAB_REVIEWER_MODES);
export type GitlabReviewerMode = z.infer<typeof gitlabReviewerModeSchema>;

export const GITLAB_IDENTITY_LINK_STATES = ["active", "suspended"] as const;
export const gitlabIdentityLinkStateSchema = z.enum(GITLAB_IDENTITY_LINK_STATES);
export type GitlabIdentityLinkState = z.infer<typeof gitlabIdentityLinkStateSchema>;

export const gitlabTargetClassSchema = z.enum(["reviewer", "assignee", "mention"]);
export type GitlabTargetClass = z.infer<typeof gitlabTargetClassSchema>;

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
  stableDeliveryObserved: z.boolean(),
  reviewerCapability: z.object({
    mode: gitlabReviewerModeSchema,
    lastObservedVersion: z.string().nullable(),
    lastSchemaAnomalyAt: z.string().nullable(),
    lastSchemaAnomalyCode: z.string().nullable(),
  }),
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

export const gitlabIdentityLinkCreateSchema = z.object({
  connectionId: z.string().min(1),
  membershipId: z.string().min(1),
  username: z.string().trim().min(1).max(255),
});
export type GitlabIdentityLinkCreate = z.infer<typeof gitlabIdentityLinkCreateSchema>;

export const gitlabIdentityLinkSummarySchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  membershipId: z.string().min(1),
  connectionId: z.string(),
  displayUsername: z.string(),
  normalizedUsername: z.string(),
  state: gitlabIdentityLinkStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GitlabIdentityLinkSummary = z.infer<typeof gitlabIdentityLinkSummarySchema>;

export const followGitlabEntitySchema = z.object({
  connectionId: z.string().min(1),
  entityUrl: z.url(),
});
export type FollowGitlabEntity = z.infer<typeof followGitlabEntitySchema>;
