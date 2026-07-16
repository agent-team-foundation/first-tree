import { z } from "zod";

export const GITLAB_REVIEWER_MODES = ["unknown", "assignee", "reviewers"] as const;
export const gitlabReviewerModeSchema = z.enum(GITLAB_REVIEWER_MODES);
export type GitlabReviewerMode = z.infer<typeof gitlabReviewerModeSchema>;

export const GITLAB_IDENTITY_LINK_STATES = ["active", "suspended", "revoked"] as const;
export const gitlabIdentityLinkStateSchema = z.enum(GITLAB_IDENTITY_LINK_STATES);
export type GitlabIdentityLinkState = z.infer<typeof gitlabIdentityLinkStateSchema>;

export const GITLAB_IDENTITY_TRANSITIONS = [
  "created",
  "suspended",
  "reconfirmed",
  "revoked",
  "member_left",
  "member_removed",
  "connection_removed",
] as const;
export const gitlabIdentityTransitionSchema = z.enum(GITLAB_IDENTITY_TRANSITIONS);
export type GitlabIdentityTransition = z.infer<typeof gitlabIdentityTransitionSchema>;

export const GITLAB_SKIPPED_TARGET_REASONS = [
  "automatic_actions_disabled",
  "reviewer_mode_unconfirmed",
  "review_target_schema_anomaly",
  "identity_not_found",
  "identity_not_active",
  "membership_not_active",
  "delegate_missing",
  "delegate_ineligible",
] as const;
export const gitlabSkippedTargetReasonSchema = z.enum(GITLAB_SKIPPED_TARGET_REASONS);
export type GitlabSkippedTargetReason = z.infer<typeof gitlabSkippedTargetReasonSchema>;

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
  automaticActions: z.object({
    enabled: z.boolean(),
    acceptedAt: z.string().nullable(),
    acceptedByMemberId: z.string().nullable(),
  }),
  reviewerCapability: z.object({
    mode: gitlabReviewerModeSchema,
    assigneeConfirmedAt: z.string().nullable(),
    assigneeConfirmedByMemberId: z.string().nullable(),
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

export const gitlabAutomaticActionsUpdateSchema = z.object({
  enabled: z.boolean(),
  /** Required acknowledgement when enabling the Team-wide URL bearer risk. */
  acceptTeamWideForgeryRisk: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});
export type GitlabAutomaticActionsUpdate = z.infer<typeof gitlabAutomaticActionsUpdateSchema>;

export const gitlabAssigneeModeConfirmationSchema = z.object({
  confirmLegacyAssigneeMode: z.literal(true),
});
export type GitlabAssigneeModeConfirmation = z.infer<typeof gitlabAssigneeModeConfirmationSchema>;

export const gitlabIdentityLinkCreateSchema = z.object({
  connectionId: z.string().min(1),
  membershipId: z.string().min(1),
  username: z.string().trim().min(1).max(255),
});
export type GitlabIdentityLinkCreate = z.infer<typeof gitlabIdentityLinkCreateSchema>;

export const gitlabIdentityLinkTransitionSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type GitlabIdentityLinkTransition = z.infer<typeof gitlabIdentityLinkTransitionSchema>;

export const gitlabIdentityLinkSummarySchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  membershipId: z.string().min(1),
  connectionId: z.string().nullable(),
  instanceOrigin: z.string(),
  displayUsername: z.string(),
  normalizedUsername: z.string(),
  state: gitlabIdentityLinkStateSchema,
  stateReason: z.string().nullable(),
  createdByMemberId: z.string().nullable(),
  confirmedByMemberId: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  suspendedByMemberId: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  revokedByMemberId: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GitlabIdentityLinkSummary = z.infer<typeof gitlabIdentityLinkSummarySchema>;

export const gitlabIdentityTransitionAuditSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  identityLinkId: z.string().min(1),
  connectionId: z.string().nullable(),
  instanceOrigin: z.string(),
  membershipId: z.string().min(1),
  displayUsername: z.string(),
  normalizedUsername: z.string(),
  transition: gitlabIdentityTransitionSchema,
  actorMemberId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type GitlabIdentityTransitionAudit = z.infer<typeof gitlabIdentityTransitionAuditSchema>;

export const gitlabAutomaticActionsAuditSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  connectionId: z.string().min(1),
  instanceOrigin: z.string(),
  enabled: z.boolean(),
  actorMemberId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type GitlabAutomaticActionsAudit = z.infer<typeof gitlabAutomaticActionsAuditSchema>;

export const gitlabSkippedTargetAuditSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  connectionId: z.string().min(1),
  entityKey: z.string().min(1),
  targetClass: gitlabTargetClassSchema,
  externalUsername: z.string().min(1),
  reason: gitlabSkippedTargetReasonSchema,
  createdAt: z.string(),
});
export type GitlabSkippedTargetAudit = z.infer<typeof gitlabSkippedTargetAuditSchema>;

export const followGitlabEntitySchema = z.object({
  connectionId: z.string().min(1),
  entityUrl: z.url(),
});
export type FollowGitlabEntity = z.infer<typeof followGitlabEntitySchema>;
