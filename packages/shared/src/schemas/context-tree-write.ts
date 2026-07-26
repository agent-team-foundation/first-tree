import { z } from "zod";
import { contextTreeActiveBindingSchema, contextTreeProviderSchema } from "./org-settings.js";

export const CONTEXT_TREE_WRITE_PREFLIGHT_ERROR_CODES = [
  "CONTEXT_TREE_WRITE_AUTHORITY_FAILED",
  "CONTEXT_TREE_WRITE_BINDING_UNAVAILABLE",
  "CONTEXT_TREE_WRITE_BINDING_UNSUPPORTED",
  "CONTEXT_TREE_WRITE_CONFIGURATION_INVALID",
  "CONTEXT_TREE_WRITE_REVIEW_UNAVAILABLE",
  "CONTEXT_TREE_WRITE_REVIEWER_UNAVAILABLE",
  "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_REQUIRED",
  "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_MISMATCH",
  "CONTEXT_TREE_WRITE_GITLAB_CONNECTION_MISMATCH",
] as const;

export const contextTreeWritePreflightErrorCodeSchema = z.enum(CONTEXT_TREE_WRITE_PREFLIGHT_ERROR_CODES);
export type ContextTreeWritePreflightErrorCode = z.infer<typeof contextTreeWritePreflightErrorCodeSchema>;

const githubLoginSchema = z.string().trim().min(1).max(255);

export const contextTreeWritePreflightRequestSchema = z
  .object({
    requesterGithubLogin: githubLoginSchema.optional(),
  })
  .strict();
export type ContextTreeWritePreflightRequest = z.infer<typeof contextTreeWritePreflightRequestSchema>;

export const contextTreeWritePreflightResponseSchema = z
  .object({
    organizationId: z.string().min(1),
    provider: contextTreeProviderSchema,
    binding: contextTreeActiveBindingSchema,
    gitlabInstanceOrigin: z.string().url().nullable(),
    reviewerAgentUuid: z.string().min(1),
    requesterGithubLogin: githubLoginSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "gitlab" && value.gitlabInstanceOrigin === null) {
      ctx.addIssue({
        code: "custom",
        path: ["gitlabInstanceOrigin"],
        message: "GitLab Write preflight requires the current instance origin",
      });
    }
    if (value.provider === "github" && value.gitlabInstanceOrigin !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["gitlabInstanceOrigin"],
        message: "GitHub Write preflight must not include a GitLab instance origin",
      });
    }
  });
export type ContextTreeWritePreflightResponse = z.infer<typeof contextTreeWritePreflightResponseSchema>;
