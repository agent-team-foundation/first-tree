import { z } from "zod";
import { CONTEXT_REVIEW_BODY_MAX_BYTES, CONTEXT_REVIEW_RUN_MARKER_PREFIX } from "./context-review-constants.js";

export const CONTEXT_REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export { CONTEXT_REVIEW_BODY_MAX_BYTES, CONTEXT_REVIEW_RUN_MARKER_PREFIX } from "./context-review-constants.js";

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
const contextReviewerRunCommonSchema = {
  contextTreeReviewer: z.literal(true),
  contextReviewRunId: z.string().min(1),
  contextReviewOrganizationId: z.string().min(1),
  contextReviewReviewerAgentUuid: z.string().min(1),
  contextReviewReviewerManagerHumanAgentId: z.string().min(1),
};

const githubContextReviewerRunMessageMetadataSchema = z
  .object({
    source: z.literal("github"),
    ...contextReviewerRunCommonSchema,
    contextReviewRepository: z
      .string()
      .trim()
      .regex(/^[^\s/]+\/[^\s/]+$/),
    contextReviewPrNumber: z.number().int().positive(),
    contextReviewHeadSha: commitOidSchema.optional(),
    contextReviewSubmission: contextReviewSubmissionStateSchema,
  })
  .passthrough();

const gitlabContextReviewerRunMessageMetadataSchema = z
  .object({
    source: z.literal("gitlab"),
    ...contextReviewerRunCommonSchema,
    contextReviewRepository: z
      .string()
      .trim()
      .regex(/^[^\s/]+\/[^\s]+$/),
    contextReviewConnectionId: z.string().min(1),
    contextReviewProjectId: z.number().int().positive(),
    contextReviewMrIid: z.number().int().positive(),
    contextReviewEntityUrl: z.string().url(),
    contextReviewHeadSha: commitOidSchema.optional(),
  })
  .passthrough();

export const contextReviewerRunMessageMetadataSchema = z.discriminatedUnion("source", [
  githubContextReviewerRunMessageMetadataSchema,
  gitlabContextReviewerRunMessageMetadataSchema,
]);
export type ContextReviewerRunMessageMetadata = z.infer<typeof contextReviewerRunMessageMetadataSchema>;

export const contextReviewSubmitRequestSchema = z
  .object({
    event: contextReviewEventSchema,
    body: z
      .string()
      .refine((value) => value.trim().length > 0, "body must not be empty")
      .refine(
        (value) => !value.includes(CONTEXT_REVIEW_RUN_MARKER_PREFIX),
        "body must not contain the reserved Context Review run marker",
      )
      .refine((value) => new TextEncoder().encode(value).byteLength <= CONTEXT_REVIEW_BODY_MAX_BYTES, {
        message: `body must not exceed ${CONTEXT_REVIEW_BODY_MAX_BYTES} bytes`,
      }),
  })
  .strict();
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
  "CONTEXT_REVIEW_PR_NOT_REVIEWABLE",
  "CONTEXT_REVIEW_APP_NOT_INSTALLED",
  "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED",
  "CONTEXT_REVIEW_REPO_NOT_ACCESSIBLE",
  "CONTEXT_REVIEW_GITHUB_REJECTED",
  "CONTEXT_REVIEW_GITHUB_UNKNOWN",
] as const;
export const contextReviewErrorCodeSchema = z.enum(CONTEXT_REVIEW_ERROR_CODES);
export type ContextReviewErrorCode = z.infer<typeof contextReviewErrorCodeSchema>;
