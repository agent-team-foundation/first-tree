import { z } from "zod";
import {
  contextTreeActiveBindingSchema,
  contextTreeBranchSchema,
  contextTreeProviderSchema,
  contextTreeRepoSchema,
} from "./org-settings.js";

export const CONTEXT_TREE_SEED_PREFLIGHT_ERROR_CODES = [
  "CONTEXT_TREE_SEED_AUTHORITY_FAILED",
  "CONTEXT_TREE_SEED_NEEDS_ADMIN",
  "CONTEXT_TREE_SEED_CONFIGURATION_INVALID",
  "CONTEXT_TREE_SEED_TARGET_UNAVAILABLE",
] as const;

export const contextTreeSeedPreflightErrorCodeSchema = z.enum(CONTEXT_TREE_SEED_PREFLIGHT_ERROR_CODES);
export type ContextTreeSeedPreflightErrorCode = z.infer<typeof contextTreeSeedPreflightErrorCodeSchema>;

export const contextTreeSeedPreflightTargetSchema = z
  .object({
    provider: contextTreeProviderSchema,
    repo: contextTreeRepoSchema,
    branch: contextTreeBranchSchema,
  })
  .strict();
export type ContextTreeSeedPreflightTarget = z.infer<typeof contextTreeSeedPreflightTargetSchema>;

export const contextTreeSeedPreflightRequestSchema = z
  .object({
    target: contextTreeSeedPreflightTargetSchema.optional(),
  })
  .strict();
export type ContextTreeSeedPreflightRequest = z.infer<typeof contextTreeSeedPreflightRequestSchema>;

export const contextTreeSeedPreflightStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unbound"),
      branch: contextTreeBranchSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("bound"),
      binding: contextTreeActiveBindingSchema,
    })
    .strict(),
]);
export type ContextTreeSeedPreflightState = z.infer<typeof contextTreeSeedPreflightStateSchema>;

export const contextTreeSeedPreflightResponseSchema = z
  .object({
    organizationId: z.string().min(1),
    state: contextTreeSeedPreflightStateSchema,
  })
  .strict();
export type ContextTreeSeedPreflightResponse = z.infer<typeof contextTreeSeedPreflightResponseSchema>;
