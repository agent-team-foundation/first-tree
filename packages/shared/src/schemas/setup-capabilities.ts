import { z } from "zod";
import { contextTreeBranchSchema, contextTreeProviderSchema, contextTreeRepoSchema } from "./org-settings.js";

export const setupCapabilityHealthSchema = z.enum([
  "not_observed",
  "pending_verification",
  "ready",
  "degraded",
  "unavailable",
]);

export const setupBlockerCodeSchema = z.enum([
  "provider_probe_failed",
  "github_app_suspended",
  "github_pull_requests_permission_required",
  "github_tree_repo_not_covered",
  "gitlab_webhook_not_seen",
  "gitlab_processing_failed",
  "context_tree_binding_invalid",
  "context_tree_provider_unresolved",
  "context_tree_connection_mismatch",
  "context_review_provider_prerequisite_missing",
  "context_review_agent_missing",
  "context_review_agent_inactive",
]);

export const setupResolutionOwnerSchema = z.enum(["admin", "operator"]);

export const setupActionKindSchema = z.enum([
  "connect_github",
  "manage_github_installation",
  "connect_gitlab",
  "configure_gitlab_webhook",
  "repair_tree_binding",
  "open_tree_setup_chat",
  "select_review_agent",
  "replace_review_agent",
]);

export const setupBlockerSchema = z
  .object({
    code: setupBlockerCodeSchema,
    resolutionOwner: setupResolutionOwnerSchema,
    actionKind: setupActionKindSchema.nullable(),
  })
  .strict();

export const setupRepositoryAutomationProviderSchema = z
  .object({
    provider: contextTreeProviderSchema,
    adoption: z.enum(["available", "configuring", "enabled"]),
    health: setupCapabilityHealthSchema,
    blockers: z.array(setupBlockerSchema),
    observedAt: z.string().datetime(),
  })
  .strict();

export const setupContextTreeBindingSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unbound") }).strict(),
  z.object({ state: z.literal("invalid") }).strict(),
  z
    .object({
      state: z.literal("bound"),
      provider: contextTreeProviderSchema,
      repo: contextTreeRepoSchema,
      branch: contextTreeBranchSchema,
    })
    .strict(),
]);

export const setupReviewerAgentSchema = z
  .object({
    uuid: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict();

export const setupAutomaticReviewSchema = z
  .object({
    adoption: z.enum(["unavailable", "disabled", "enabled"]),
    health: setupCapabilityHealthSchema,
    reviewerAgent: setupReviewerAgentSchema.nullable(),
    blockers: z.array(setupBlockerSchema),
    observedAt: z.string().datetime(),
  })
  .strict();

export const teamSetupCapabilitiesSchema = z
  .object({
    organizationId: z.string().min(1),
    repositoryAutomation: z
      .object({
        providers: z
          .array(setupRepositoryAutomationProviderSchema)
          .length(2)
          .superRefine((providers, ctx) => {
            const providerNames = new Set(providers.map((provider) => provider.provider));
            if (providerNames.size !== 2 || !providerNames.has("github") || !providerNames.has("gitlab")) {
              ctx.addIssue({
                code: "custom",
                message: "Repository automation must contain exactly one GitHub and one GitLab provider",
              });
            }
          }),
      })
      .strict(),
    contextTree: z
      .object({
        binding: setupContextTreeBindingSchema,
        blockers: z.array(setupBlockerSchema),
        automaticReview: setupAutomaticReviewSchema,
      })
      .strict(),
  })
  .strict();

export type SetupCapabilityHealth = z.infer<typeof setupCapabilityHealthSchema>;
export type SetupBlockerCode = z.infer<typeof setupBlockerCodeSchema>;
export type SetupResolutionOwner = z.infer<typeof setupResolutionOwnerSchema>;
export type SetupActionKind = z.infer<typeof setupActionKindSchema>;
export type SetupBlocker = z.infer<typeof setupBlockerSchema>;
export type SetupRepositoryAutomationProvider = z.infer<typeof setupRepositoryAutomationProviderSchema>;
export type SetupContextTreeBinding = z.infer<typeof setupContextTreeBindingSchema>;
export type SetupReviewerAgent = z.infer<typeof setupReviewerAgentSchema>;
export type SetupAutomaticReview = z.infer<typeof setupAutomaticReviewSchema>;
export type TeamSetupCapabilities = z.infer<typeof teamSetupCapabilitiesSchema>;
