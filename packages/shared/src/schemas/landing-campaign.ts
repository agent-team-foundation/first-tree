import { z } from "zod";
import { repoUrlSchema } from "./org-settings.js";

export const landingCampaignSlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/u, "Campaign must be a kebab-case slug.");

/** Campaigns that the current Cloud build can actively launch or hand off. */
export const KNOWN_LANDING_CAMPAIGN_SLUGS = ["production-scan"] as const;
export const knownLandingCampaignSlugSchema = z.enum(KNOWN_LANDING_CAMPAIGN_SLUGS);
export type KnownLandingCampaignSlug = z.infer<typeof knownLandingCampaignSlugSchema>;

export function isKnownLandingCampaignSlug(value: unknown): value is KnownLandingCampaignSlug {
  return knownLandingCampaignSlugSchema.safeParse(value).success;
}

export const landingCampaignRepoSlugSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u);

export const landingCampaignAttributionSchema = z
  .object({
    attemptId: z.string().uuid(),
    variant: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  })
  .strict();
export type LandingCampaignAttribution = z.infer<typeof landingCampaignAttributionSchema>;

export const landingCampaignActionConversionSchema = z
  .object({
    chatId: z.string().min(1),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type LandingCampaignActionConversion = z.infer<typeof landingCampaignActionConversionSchema>;

/** Trusted campaign action context carried by direct and onboarding chat creation. */
export const landingCampaignActionContextSchema = z
  .object({
    campaign: knownLandingCampaignSlugSchema,
    repoSlug: landingCampaignRepoSlugSchema,
  })
  .strict();
export type LandingCampaignActionContext = z.infer<typeof landingCampaignActionContextSchema>;

export const landingCampaignStartRequestSchema = z.object({
  organizationId: z.string().min(1).optional(),
  campaign: landingCampaignSlugSchema,
  repoUrl: repoUrlSchema,
  attribution: landingCampaignAttributionSchema.optional(),
});
export type LandingCampaignStartRequest = z.infer<typeof landingCampaignStartRequestSchema>;

export const landingCampaignStartResponseSchema = z.object({
  chatId: z.string().min(1),
  agentUuid: z.string().min(1),
  campaign: landingCampaignSlugSchema,
  repoCanonicalKey: z.string().min(1),
});
export type LandingCampaignStartResponse = z.infer<typeof landingCampaignStartResponseSchema>;

export const landingCampaignRepoMetadataSchema = z.object({
  url: z.string().min(1),
  canonicalKey: z.string().min(1),
  owner: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
export type LandingCampaignRepoMetadata = z.infer<typeof landingCampaignRepoMetadataSchema>;

export const landingCampaignTrialAgentMetadataSchema = z.object({
  landingCampaignTrial: z.literal(true),
  campaign: landingCampaignSlugSchema,
  skillSetId: z.string().min(1),
  skillSetVersion: z.string().min(1),
  repo: landingCampaignRepoMetadataSchema.optional(),
});
export type LandingCampaignTrialAgentMetadata = z.infer<typeof landingCampaignTrialAgentMetadataSchema>;

export const landingCampaignTrialChatStateSchema = z.enum(["running", "awaiting_user", "completed", "failed"]);
export type LandingCampaignTrialChatState = z.infer<typeof landingCampaignTrialChatStateSchema>;
export const landingCampaignTrialAwaitingUserKindSchema = z.enum(["request", "follow_up"]);
export type LandingCampaignTrialAwaitingUserKind = z.infer<typeof landingCampaignTrialAwaitingUserKindSchema>;
export const landingCampaignTrialLimitReasonSchema = z.enum(["turns", "tokens"]);
export type LandingCampaignTrialLimitReason = z.infer<typeof landingCampaignTrialLimitReasonSchema>;

export const landingCampaignTrialChatMetadataSchema = z.object({
  landingCampaignTrial: z.object({
    campaign: landingCampaignSlugSchema,
    agentId: z.string().min(1),
    skillSetId: z.string().min(1),
    skillSetVersion: z.string().min(1),
    repo: landingCampaignRepoMetadataSchema,
    attribution: landingCampaignAttributionSchema.optional(),
    actionConversion: landingCampaignActionConversionSchema.optional(),
    state: landingCampaignTrialChatStateSchema,
    inputLocked: z.boolean(),
    awaitingUserKind: landingCampaignTrialAwaitingUserKindSchema.optional(),
    maxAgentTurns: z.number().int().min(1).default(1),
    completedAgentTurns: z.number().int().min(0).default(0),
    completedAgentTurnIds: z.array(z.string().min(1)).default([]),
    maxEstimatedTokens: z.number().int().min(1).nullable().default(null),
    estimatedTokensUsed: z.number().int().min(0).default(0),
    lastObservedEstimatedTokens: z.number().int().min(0).default(0),
    lastObservedTokenUsageEventId: z.string().min(1).nullable().default(null),
    limitReason: landingCampaignTrialLimitReasonSchema.optional(),
  }),
});
export type LandingCampaignTrialChatMetadata = z.infer<typeof landingCampaignTrialChatMetadataSchema>;

export function parseLandingCampaignTrialAgentMetadata(
  metadata: Record<string, unknown> | null | undefined,
): LandingCampaignTrialAgentMetadata | null {
  const parsed = landingCampaignTrialAgentMetadataSchema.safeParse(metadata ?? {});
  return parsed.success ? parsed.data : null;
}

export function parseLandingCampaignTrialChatMetadata(
  metadata: Record<string, unknown> | null | undefined,
): LandingCampaignTrialChatMetadata["landingCampaignTrial"] | null {
  const parsed = landingCampaignTrialChatMetadataSchema.safeParse(metadata ?? {});
  return parsed.success ? parsed.data.landingCampaignTrial : null;
}

export function isLandingCampaignTrialAgentMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return parseLandingCampaignTrialAgentMetadata(metadata) !== null;
}

export function isLandingCampaignTrialChatLocked(metadata: Record<string, unknown> | null | undefined): boolean {
  const trial = parseLandingCampaignTrialChatMetadata(metadata);
  return trial?.inputLocked === true;
}
