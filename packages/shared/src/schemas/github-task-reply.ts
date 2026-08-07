import { z } from "zod";
import {
  GITHUB_TASK_REPLY_BODY_MAX_BYTES,
  GITHUB_TASK_REPLY_RUN_MARKER_PREFIX,
} from "./github-task-reply-constants.js";

export {
  GITHUB_TASK_REPLY_BODY_MAX_BYTES,
  GITHUB_TASK_REPLY_RUN_MARKER_PREFIX,
} from "./github-task-reply-constants.js";

const submissionCommonSchema = {
  payloadHash: z.string().min(1),
};

export const githubTaskReplySubmissionStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z
    .object({
      state: z.literal("submitting"),
      ...submissionCommonSchema,
      attemptId: z.string().min(1),
      claimedAt: z.string().datetime(),
      publisherClientId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("unknown"),
      ...submissionCommonSchema,
      attemptId: z.string().min(1),
      failedAt: z.string().datetime(),
      publisherClientId: z.string().min(1),
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
      commentId: z.number().int().positive(),
      commentUrl: z.string().url(),
      appActor: z.string().min(1),
      submittedAt: z.string().datetime(),
      publisherAgentUuid: z.string().min(1),
      publisherClientId: z.string().min(1),
    })
    .strict(),
]);
export type GithubTaskReplySubmissionState = z.infer<typeof githubTaskReplySubmissionStateSchema>;

/**
 * Server-authored metadata persisted with a publishable, automatically routed
 * GitHub task card. Ordinary message writes cannot set the reserved
 * `githubTask*` namespace.
 */
export const githubTaskRunMessageMetadataSchema = z
  .object({
    source: z.literal("github"),
    githubTaskRun: z.literal(true),
    githubTaskRunId: z.string().uuid(),
    githubTaskOrganizationId: z.string().min(1),
    githubTaskAgentUuid: z.string().min(1),
    githubTaskManagerHumanAgentId: z.string().min(1),
    githubTaskRepository: z
      .string()
      .trim()
      .regex(/^[^\s/]+\/[^\s/]+$/),
    githubTaskEntityType: z.enum(["issue", "pull_request"]),
    githubTaskEntityNumber: z.number().int().positive(),
    githubTaskEntityUrl: z.string().url(),
    githubTaskReplySubmission: githubTaskReplySubmissionStateSchema,
  })
  .passthrough();
export type GithubTaskRunMessageMetadata = z.infer<typeof githubTaskRunMessageMetadataSchema>;

export const githubTaskReplyRequestSchema = z
  .object({
    body: z
      .string()
      .refine((value) => value.trim().length > 0, "body must not be empty")
      .refine(
        (value) => !value.includes(GITHUB_TASK_REPLY_RUN_MARKER_PREFIX),
        "body must not contain the reserved GitHub task reply run marker",
      )
      .refine((value) => new TextEncoder().encode(value).byteLength <= GITHUB_TASK_REPLY_BODY_MAX_BYTES, {
        message: `body must not exceed ${GITHUB_TASK_REPLY_BODY_MAX_BYTES} bytes`,
      }),
  })
  .strict();
export type GithubTaskReplyRequest = z.infer<typeof githubTaskReplyRequestSchema>;

export const githubTaskReplyResponseSchema = z
  .object({
    commentId: z.number().int().positive(),
    commentUrl: z.string().url(),
    appActor: z.string().min(1),
  })
  .strict();
export type GithubTaskReplyResponse = z.infer<typeof githubTaskReplyResponseSchema>;

export const GITHUB_TASK_REPLY_ERROR_CODES = [
  "GITHUB_TASK_REPLY_INVALID_REQUEST",
  "GITHUB_TASK_REPLY_RUNTIME_SESSION_REQUIRED",
  "GITHUB_TASK_REPLY_RUN_NOT_FOUND",
  "GITHUB_TASK_REPLY_RUN_FORBIDDEN",
  "GITHUB_TASK_REPLY_RUN_ALREADY_SUBMITTED",
  "GITHUB_TASK_REPLY_RUN_PAYLOAD_MISMATCH",
  "GITHUB_TASK_REPLY_ENTITY_UNSUPPORTED",
  "GITHUB_TASK_REPLY_APP_NOT_INSTALLED",
  "GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED",
  "GITHUB_TASK_REPLY_REPO_NOT_ACCESSIBLE",
  "GITHUB_TASK_REPLY_GITHUB_REJECTED",
  "GITHUB_TASK_REPLY_GITHUB_UNKNOWN",
] as const;
export const githubTaskReplyErrorCodeSchema = z.enum(GITHUB_TASK_REPLY_ERROR_CODES);
export type GithubTaskReplyErrorCode = z.infer<typeof githubTaskReplyErrorCodeSchema>;
