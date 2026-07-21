import { z } from "zod";

export const CONTEXT_REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export const CONTEXT_REVIEW_BODY_MAX_BYTES = 64 * 1024;

export const contextReviewEventSchema = z.enum(CONTEXT_REVIEW_EVENTS);
export type ContextReviewEvent = z.infer<typeof contextReviewEventSchema>;

const commitOidSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "expected a full 40-character commit OID")
  .transform((value) => value.toLowerCase());

const submissionCommonSchema = {
  payloadHash: z.string().min(1),
};

/** Every durable state written by the App review publisher. */
export const contextReviewSubmissionStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z
    .object({
      state: z.literal("submitting"),
      ...submissionCommonSchema,
      attemptId: z.string().min(1),
      reviewedHead: commitOidSchema,
      event: contextReviewEventSchema,
      claimedAt: z.string().datetime(),
      reviewerClientId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("unknown"),
      ...submissionCommonSchema,
      attemptId: z.string().min(1),
      reviewedHead: commitOidSchema,
      event: contextReviewEventSchema,
      failedAt: z.string().datetime(),
      reviewerClientId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      ...submissionCommonSchema,
      code: z.string().min(1),
      failedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      state: z.literal("submitted"),
      ...submissionCommonSchema,
      reviewedHead: commitOidSchema,
      event: contextReviewEventSchema,
      reviewId: z.number().int().positive(),
      reviewUrl: z.string().url(),
      appActor: z.string().min(1),
      submittedAt: z.string().datetime(),
      reviewerAgentUuid: z.string().min(1),
      reviewerManagerHumanAgentId: z.string().min(1),
      reviewerClientId: z.string().min(1),
      reviewerManagerGithubLogin: z.string().min(1).nullable(),
    })
    .strict(),
]);
export type ContextReviewSubmissionState = z.infer<typeof contextReviewSubmissionStateSchema>;

/**
 * Server-authored metadata for a trusted GitHub App Context Reviewer run.
 * Ordinary message writes cannot set the reserved `contextReview*` namespace,
 * so clients may use this complete shape as a synthetic GitHub sender signal.
 */
export const contextReviewerRunMessageMetadataSchema = z
  .object({
    source: z.literal("github"),
    contextTreeReviewer: z.literal(true),
    contextReviewRunId: z.string().min(1),
    contextReviewRepository: z
      .string()
      .trim()
      .regex(/^[^\s/]+\/[^\s/]+$/),
    contextReviewPrNumber: z.number().int().positive(),
    contextReviewHeadSha: commitOidSchema,
    contextReviewOrganizationId: z.string().min(1),
    contextReviewReviewerAgentUuid: z.string().min(1),
    contextReviewReviewerManagerHumanAgentId: z.string().min(1),
    contextReviewSubmission: contextReviewSubmissionStateSchema,
  })
  .passthrough();
export type ContextReviewerRunMessageMetadata = z.infer<typeof contextReviewerRunMessageMetadataSchema>;

/**
 * Read-only compatibility for messages produced by the retired managed
 * dispatcher. This preserves historical GitHub attribution without exposing
 * any managed task or dispatch API.
 */
const legacyContextReviewManagedEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventType: z.enum(["pull_request", "issue_comment", "pull_request_review_comment"]),
    action: z.enum(["opened", "synchronize", "ready_for_review", "reopened", "edited", "created"]),
    triggerEvent: z.string().trim().min(1),
    repository: z
      .string()
      .trim()
      .regex(/^[^\s/]+\/[^\s/]+$/),
    pullRequest: z.number().int().positive(),
    senderLogin: z.string().trim().min(1),
    deliveryId: z.string().trim().min(1).optional(),
    headSha: commitOidSchema.optional(),
    isDraft: z.boolean().optional(),
    commentId: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    commentAuthorLogin: z.string().trim().min(1).optional(),
    commentUrl: z.string().url().optional(),
  })
  .strict();

export const legacyContextReviewManagedMessageMetadataSchema = z
  .object({
    source: z.literal("github"),
    systemSender: z.literal("github"),
    contextReviewManagedEventV1: legacyContextReviewManagedEventSchema,
  })
  .passthrough();

export const contextReviewSubmitRequestSchema = z.object({
  reviewedHead: commitOidSchema,
  event: contextReviewEventSchema,
  body: z
    .string()
    .refine((value) => value.trim().length > 0, "body must not be empty")
    .refine((value) => new TextEncoder().encode(value).byteLength <= CONTEXT_REVIEW_BODY_MAX_BYTES, {
      message: `body must not exceed ${CONTEXT_REVIEW_BODY_MAX_BYTES} bytes`,
    }),
});
export type ContextReviewSubmitRequest = z.infer<typeof contextReviewSubmitRequestSchema>;

export const contextReviewSubmitResponseSchema = z.object({
  action: contextReviewEventSchema,
  reviewedHead: z.string().regex(/^[0-9a-f]{40}$/i),
  reviewId: z.number().int().positive(),
  reviewUrl: z.string().url(),
  appActor: z.string().min(1),
});
export type ContextReviewSubmitResponse = z.infer<typeof contextReviewSubmitResponseSchema>;

export const CONTEXT_REVIEW_ERROR_CODES = [
  "CONTEXT_REVIEW_INVALID_REQUEST",
  "CONTEXT_REVIEW_RUNTIME_SESSION_REQUIRED",
  "CONTEXT_REVIEW_RUN_NOT_FOUND",
  "CONTEXT_REVIEW_RUN_FORBIDDEN",
  "CONTEXT_REVIEW_RUN_ALREADY_SUBMITTED",
  "CONTEXT_REVIEW_RUN_PAYLOAD_MISMATCH",
  "CONTEXT_REVIEW_STALE_HEAD",
  "CONTEXT_REVIEW_PR_NOT_REVIEWABLE",
  "CONTEXT_REVIEW_APP_NOT_INSTALLED",
  "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED",
  "CONTEXT_REVIEW_REPO_NOT_ACCESSIBLE",
  "CONTEXT_REVIEW_GITHUB_REJECTED",
  "CONTEXT_REVIEW_GITHUB_UNKNOWN",
] as const;
export const contextReviewErrorCodeSchema = z.enum(CONTEXT_REVIEW_ERROR_CODES);
export type ContextReviewErrorCode = z.infer<typeof contextReviewErrorCodeSchema>;
