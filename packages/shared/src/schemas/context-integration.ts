import { z } from "zod";
import { canonicalResourceRepoKeySchema } from "./context-activation.js";

export const CONTEXT_INTEGRATION_PROVIDERS = ["claude-code", "codex"] as const;
export const contextIntegrationProviderSchema = z.enum(CONTEXT_INTEGRATION_PROVIDERS);
export type ContextIntegrationProvider = z.infer<typeof contextIntegrationProviderSchema>;

export const contextEnablementIntentSchema = z.enum(["settings", "onboarding"]);
export type ContextEnablementIntent = z.infer<typeof contextEnablementIntentSchema>;

export const contextEnablementHandoffQuerySchema = z
  .object({
    provider: contextIntegrationProviderSchema,
    intent: contextEnablementIntentSchema.default("settings"),
  })
  .strict();
export type ContextEnablementHandoffQuery = z.infer<typeof contextEnablementHandoffQuerySchema>;

export const contextEnablementHandoffSchema = z
  .object({
    protocolVersion: z.literal(1),
    organizationId: z.string().min(1),
    teamDisplayName: z.string().min(1),
    role: z.enum(["admin", "member"]),
    provider: contextIntegrationProviderSchema,
    intent: contextEnablementIntentSchema,
    command: z.string().min(1),
    workingDirectoryInstruction: z.string().min(1),
  })
  .strict();
export type ContextEnablementHandoff = z.infer<typeof contextEnablementHandoffSchema>;

const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const contextIntegrationPathProjectSchema = z
  .object({
    kind: z.literal("path"),
    root: z
      .string()
      .min(1)
      .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"), {
        message: "Project root must be an absolute POSIX, drive-letter, or UNC path.",
      }),
  })
  .strict();

export const contextIntegrationPathlessProjectSchema = z.object({ kind: z.literal("pathless") }).strict();

export const contextIntegrationProjectSchema = z.discriminatedUnion("kind", [
  contextIntegrationPathProjectSchema,
  contextIntegrationPathlessProjectSchema,
]);
export type ContextIntegrationProject = z.infer<typeof contextIntegrationProjectSchema>;

export const contextSessionCandidateIssueRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: contextIntegrationProviderSchema,
    project: contextIntegrationProjectSchema,
    organizationId: z.string().min(1),
  })
  .strict();
export type ContextSessionCandidateIssueRequest = z.infer<typeof contextSessionCandidateIssueRequestSchema>;

export const contextSessionCandidateIssueResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    receipt: z.string().min(32).max(4096),
  })
  .strict();
export type ContextSessionCandidateIssueResponse = z.infer<typeof contextSessionCandidateIssueResponseSchema>;

export const contextSessionCandidateValidateRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: contextIntegrationProviderSchema,
    project: contextIntegrationProjectSchema,
    receipt: z.string().min(32).max(4096),
  })
  .strict();
export type ContextSessionCandidateValidateRequest = z.infer<typeof contextSessionCandidateValidateRequestSchema>;

export const CONTEXT_ACTIVATION_SCOPE_KINDS = ["global", "directory", "session"] as const;
export const contextActivationScopeKindSchema = z.enum(CONTEXT_ACTIVATION_SCOPE_KINDS);
export type ContextActivationScopeKind = z.infer<typeof contextActivationScopeKindSchema>;

export const contextGlobalActivationScopeSchema = z.object({ kind: z.literal("global") }).strict();
export const contextDirectoryActivationScopeSchema = z
  .object({
    kind: z.literal("directory"),
    root: contextIntegrationPathProjectSchema.shape.root,
  })
  .strict();
export const contextSessionActivationScopeSchema = z.object({ kind: z.literal("session") }).strict();
export const contextActivationScopeSchema = z.discriminatedUnion("kind", [
  contextGlobalActivationScopeSchema,
  contextDirectoryActivationScopeSchema,
  contextSessionActivationScopeSchema,
]);
export type ContextActivationScope = z.infer<typeof contextActivationScopeSchema>;

export const contextPersistentActivationScopeSchema = z.discriminatedUnion("kind", [
  contextGlobalActivationScopeSchema,
  contextDirectoryActivationScopeSchema,
]);
export type ContextPersistentActivationScope = z.infer<typeof contextPersistentActivationScopeSchema>;

export const contextIntegrationGrantSchema = z
  .object({
    provider: contextIntegrationProviderSchema,
    organizationId: z.string().min(1),
    activationScope: contextPersistentActivationScopeSchema,
  })
  .strict();
export type ContextIntegrationGrant = z.infer<typeof contextIntegrationGrantSchema>;

export const contextIntegrationConfigSchema = z
  .object({
    schemaVersion: z.literal(3),
    grants: z.array(contextIntegrationGrantSchema).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    config.grants.forEach((grant, index) => {
      const scopeIdentity =
        grant.activationScope.kind === "global" ? "global" : `directory:${grant.activationScope.root}`;
      const identity = `${grant.provider}\0${grant.organizationId}\0${scopeIdentity}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["grants", index],
          message: "Each provider + Team + activation scope may have only one grant.",
        });
      }
      seen.add(identity);
    });
  });
export type ContextIntegrationConfig = z.infer<typeof contextIntegrationConfigSchema>;

/** Read only at the atomic v2 retirement boundary. */
export const legacyV2ContextIntegrationBindingSchema = z
  .object({
    provider: contextIntegrationProviderSchema,
    project: contextIntegrationProjectSchema,
    organizationId: z.string().min(1),
  })
  .strict();
export type LegacyV2ContextIntegrationBinding = z.infer<typeof legacyV2ContextIntegrationBindingSchema>;

/** Read only at the atomic v2 retirement boundary. */
export const legacyV2ContextIntegrationConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    bindings: z.array(legacyV2ContextIntegrationBindingSchema).default([]),
  })
  .strict();
export type LegacyV2ContextIntegrationConfig = z.infer<typeof legacyV2ContextIntegrationConfigSchema>;

/** Read only at the atomic local migration boundary. */
export const legacyContextIntegrationBindingSchema = z
  .object({
    provider: contextIntegrationProviderSchema,
    checkoutRoot: z.string().min(1),
    repositoryKey: canonicalResourceRepoKeySchema,
    organizationId: z.string().min(1),
  })
  .strict();
export type LegacyContextIntegrationBinding = z.infer<typeof legacyContextIntegrationBindingSchema>;

/** Read only at the atomic local migration boundary. */
export const legacyContextIntegrationConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    bindings: z.array(legacyContextIntegrationBindingSchema).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    config.bindings.forEach((binding, index) => {
      const identity = `${binding.provider}\0${binding.checkoutRoot}`;
      if (seen.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index],
          message: "Each provider + checkout identity may migrate to only one Team binding.",
        });
      }
      seen.add(identity);
    });
  });
export type LegacyContextIntegrationConfig = z.infer<typeof legacyContextIntegrationConfigSchema>;

export const contextIntegrationInstallManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    accountClientId: z.string().min(1).optional(),
    channel: z.enum(["prod", "staging", "dev"]),
    provider: contextIntegrationProviderSchema,
    firstTreeVersion: z.string().min(1),
    bundleVersion: z.string().min(1),
    adapterVersion: z.string().min(1).optional(),
    loaderProtocolVersion: z.literal(1).optional(),
    bundleDigest: sha256DigestSchema,
    policyDigest: sha256DigestSchema,
    adapterDigest: sha256DigestSchema,
    marketplaceName: z.string().min(1),
    pluginName: z.string().min(1),
    adoptionGeneration: z
      .string()
      .regex(/^[0-9a-f]{48}$/u)
      .optional(),
    materializedInvocation: z.string().min(1).optional(),
    materializedPayloadDigest: sha256DigestSchema.optional(),
    materializedMarketplaceDigest: sha256DigestSchema.optional(),
    installedAt: z.string().datetime(),
  })
  .strict();
export type ContextIntegrationInstallManifest = z.infer<typeof contextIntegrationInstallManifestSchema>;

export const contextIntegrationInstallJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: contextIntegrationProviderSchema,
    operation: z.enum(["install", "repair", "unchanged", "uninstall"]),
    previousBundleDigest: sha256DigestSchema.nullable(),
    targetBundleDigest: sha256DigestSchema.nullable(),
    startedAt: z.string().datetime(),
    phase: z.enum([
      "prepared",
      "provider_installing",
      "provider_installed",
      "rollback_failed",
      "provider_uninstalling",
      "uninstall_failed",
    ]),
  })
  .strict();
export type ContextIntegrationInstallJournal = z.infer<typeof contextIntegrationInstallJournalSchema>;

export const contextIntegrationReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().min(1),
    channel: z.enum(["prod", "staging", "dev"]),
    bundleDigest: sha256DigestSchema,
    policyDigest: sha256DigestSchema,
    core: z
      .object({
        digest: sha256DigestSchema,
        policy: z
          .object({
            path: z.string().min(1),
            digest: sha256DigestSchema,
          })
          .strict(),
        skills: z.record(
          z.enum(["first-tree-read", "first-tree-write"]),
          z
            .object({
              path: z.string().min(1),
              digest: sha256DigestSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    providers: z.record(
      contextIntegrationProviderSchema,
      z
        .object({
          adapterVersion: z.string().min(1),
          adapterDigest: sha256DigestSchema,
          minimumVersion: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type ContextIntegrationReleaseManifest = z.infer<typeof contextIntegrationReleaseManifestSchema>;

export const CONTEXT_SKILL_LOADER_NAMES = ["first-tree-read", "first-tree-write"] as const;
export const contextSkillLoaderNameSchema = z.enum(CONTEXT_SKILL_LOADER_NAMES);
export type ContextSkillLoaderName = z.infer<typeof contextSkillLoaderNameSchema>;

export const contextSkillLoadRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    loaderProtocolVersion: z.literal(1),
    consumerKind: z.literal("byo"),
    provider: contextIntegrationProviderSchema,
    name: contextSkillLoaderNameSchema,
  })
  .strict();
export type ContextSkillLoadRequest = z.infer<typeof contextSkillLoadRequestSchema>;

export const contextSkillLoadResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    loaderProtocolVersion: z.literal(1),
    consumerKind: z.literal("byo"),
    provider: contextIntegrationProviderSchema,
    releaseVersion: z.string().min(1),
    adapterVersion: z.string().min(1),
    name: contextSkillLoaderNameSchema,
    skillPath: z.string().min(1),
    skillDigest: sha256DigestSchema,
    policyPath: z.string().min(1),
    policyDigest: sha256DigestSchema,
  })
  .strict();
export type ContextSkillLoadResponse = z.infer<typeof contextSkillLoadResponseSchema>;
