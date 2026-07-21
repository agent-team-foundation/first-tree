import { z } from "zod";
import { contextTreeActiveBindingSchema } from "./org-settings.js";

export const CONTEXT_TREE_WRITE_PREFLIGHT_ERROR_CODES = [
  "CONTEXT_TREE_WRITE_AUTHORITY_FAILED",
  "CONTEXT_TREE_WRITE_BINDING_UNAVAILABLE",
  "CONTEXT_TREE_WRITE_BINDING_UNSUPPORTED",
  "CONTEXT_TREE_WRITE_CONFIGURATION_INVALID",
  "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_REQUIRED",
  "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_MISMATCH",
] as const;

export const contextTreeWritePreflightErrorCodeSchema = z.enum(CONTEXT_TREE_WRITE_PREFLIGHT_ERROR_CODES);
export type ContextTreeWritePreflightErrorCode = z.infer<typeof contextTreeWritePreflightErrorCodeSchema>;

const githubLoginSchema = z.string().trim().min(1).max(255);

export const contextTreeWritePreflightRequestSchema = z
  .object({
    requesterGithubLogin: githubLoginSchema,
  })
  .strict();
export type ContextTreeWritePreflightRequest = z.infer<typeof contextTreeWritePreflightRequestSchema>;

export const contextTreeWritePreflightResponseSchema = z
  .object({
    organizationId: z.string().min(1),
    binding: contextTreeActiveBindingSchema,
    requesterGithubLogin: githubLoginSchema,
  })
  .strict();
export type ContextTreeWritePreflightResponse = z.infer<typeof contextTreeWritePreflightResponseSchema>;
