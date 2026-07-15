import { z } from "zod";

export const CONTEXT_REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export const CONTEXT_REVIEW_BODY_MAX_BYTES = 64 * 1024;

export const contextReviewEventSchema = z.enum(CONTEXT_REVIEW_EVENTS);
export type ContextReviewEvent = z.infer<typeof contextReviewEventSchema>;

export const contextReviewSubmitRequestSchema = z.object({
  reviewedHead: z.string().regex(/^[0-9a-f]{40}$/i, "reviewedHead must be a full 40-character commit OID"),
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
