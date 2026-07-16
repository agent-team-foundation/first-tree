import { z } from "zod";

export const CONTEXT_REVIEW_WORKFLOWS = ["legacy_app", "agent_review"] as const;
export const CONTEXT_REVIEW_GOVERNANCE_MODES = ["human", "autonomous"] as const;
export const CONTEXT_REVIEW_MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export const CONTEXT_REVIEW_TASK_TYPE = "context_tree_pr_review" as const;
export const CONTEXT_REVIEW_PACKET_MAX_BYTES = 32 * 1024;

export const contextReviewWorkflowSchema = z.enum(CONTEXT_REVIEW_WORKFLOWS);
export type ContextReviewWorkflow = z.infer<typeof contextReviewWorkflowSchema>;

export const contextReviewGovernanceModeSchema = z.enum(CONTEXT_REVIEW_GOVERNANCE_MODES);
export type ContextReviewGovernanceMode = z.infer<typeof contextReviewGovernanceModeSchema>;

export const contextReviewMergeMethodSchema = z.enum(CONTEXT_REVIEW_MERGE_METHODS);
export type ContextReviewMergeMethod = z.infer<typeof contextReviewMergeMethodSchema>;

const githubRepositorySchema = z
  .string()
  .trim()
  .regex(/^[^\s/]+\/[^\s/]+$/, "repository must use owner/name form");
const gitRefSchema = z.string().trim().min(1).max(1024);
const commitOidSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "expectedHead must be a full 40-character commit OID")
  .transform((value) => value.toLowerCase());
const repositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "path must be a normalized repository-relative path",
  );

const contextReviewEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reference"),
      label: z.string().trim().min(1),
      reference: z.string().trim().min(1),
      revision: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("excerpt"),
      label: z.string().trim().min(1),
      provenance: z.string().trim().min(1),
      text: z.string().trim().min(1),
    })
    .strict(),
]);

/**
 * Versioned, non-authoritative evidence packet delivered in the opening task
 * message for Agent Review. GitHub remains authoritative for PR/head,
 * author, branch and repair consent; the packet only gives the Reviewer the
 * source context needed to judge the proposed tree change.
 */
export const reviewPacketV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    repository: githubRepositorySchema,
    pullRequest: z.number().int().positive(),
    expectedHead: commitOidSchema,
    baseRef: gitRefSchema,
    sourceRef: gitRefSchema,
    requesterGithubLogin: z.string().trim().min(1).max(255),
    goal: z.string().trim().min(1),
    source: z
      .object({
        label: z.string().trim().min(1),
        reference: z.string().trim().min(1),
        revision: z.string().trim().min(1).optional(),
      })
      .strict(),
    decisionSummary: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    targetPaths: z.array(repositoryPathSchema).default([]),
    repairScope: z.array(repositoryPathSchema).min(1),
    relevantContextRefs: z.array(z.string().trim().min(1)).default([]),
    unresolvedQuestions: z.array(z.string().trim().min(1)).default([]),
    verify: z
      .object({
        status: z.enum(["passed", "failed", "not_run"]),
        summary: z.string().trim().min(1),
      })
      .strict(),
    evidence: z.array(contextReviewEvidenceSchema).default([]),
  })
  .strict();
export type ReviewPacketV1 = z.infer<typeof reviewPacketV1Schema>;

function decodedStringBytes(value: unknown): number {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (Array.isArray(value)) return value.reduce((total, item) => total + decodedStringBytes(item), 0);
  if (typeof value !== "object" || value === null) return 0;
  return Object.values(value).reduce((total, item) => total + decodedStringBytes(item), 0);
}

/**
 * Generic task-message metadata contract consumed by Context Review. The
 * aggregate limit counts decoded UTF-8 string values, not JSON escaping or
 * transport encoding, so every client reaches the same answer.
 */
const contextReviewTaskMetadataShape = z
  .object({
    taskType: z.literal(CONTEXT_REVIEW_TASK_TYPE),
    reviewPacketV1: reviewPacketV1Schema,
  })
  .strict();

export const contextReviewTaskMetadataSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (decodedStringBytes(value) > CONTEXT_REVIEW_PACKET_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Context Review task metadata must not exceed ${CONTEXT_REVIEW_PACKET_MAX_BYTES} decoded UTF-8 bytes`,
      });
    }
  })
  .pipe(contextReviewTaskMetadataShape);
export type ContextReviewTaskMetadata = z.infer<typeof contextReviewTaskMetadataSchema>;

export const CONTEXT_REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export const CONTEXT_REVIEW_BODY_MAX_BYTES = 64 * 1024;

export const contextReviewEventSchema = z.enum(CONTEXT_REVIEW_EVENTS);
export type ContextReviewEvent = z.infer<typeof contextReviewEventSchema>;

export const contextReviewSubmitRequestSchema = z.object({
  reviewedHead: z
    .string()
    .regex(/^[0-9a-f]{40}$/i, "reviewedHead must be a full 40-character commit OID")
    .transform((value) => value.toLowerCase()),
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
