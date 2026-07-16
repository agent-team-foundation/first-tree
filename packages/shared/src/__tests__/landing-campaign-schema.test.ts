import { describe, expect, it } from "vitest";
import {
  isKnownLandingCampaignSlug,
  isLandingCampaignTrialAgentMetadata,
  isLandingCampaignTrialChatLocked,
  landingCampaignActionContextSchema,
  landingCampaignSlugSchema,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
} from "../schemas/landing-campaign.js";

const repo = {
  url: "https://github.com/acme/api.git",
  canonicalKey: "github.com/acme/api",
  owner: "acme",
  name: "api",
};

describe("landing campaign active registry", () => {
  it("distinguishes active campaign slugs from valid historical metadata slugs", () => {
    expect(isKnownLandingCampaignSlug("production-scan")).toBe(true);
    expect(isKnownLandingCampaignSlug("agent-readiness")).toBe(true);
    expect(isKnownLandingCampaignSlug("seed-api")).toBe(false);
    expect(landingCampaignSlugSchema.safeParse("seed-api").success).toBe(true);
  });

  it("validates a trusted campaign + owner/repo action context", () => {
    expect(landingCampaignActionContextSchema.parse({ campaign: "production-scan", repoSlug: "Acme/api.js" })).toEqual({
      campaign: "production-scan",
      repoSlug: "Acme/api.js",
    });
    expect(landingCampaignActionContextSchema.parse({ campaign: "agent-readiness", repoSlug: "Acme/api.js" })).toEqual({
      campaign: "agent-readiness",
      repoSlug: "Acme/api.js",
    });
    expect(landingCampaignActionContextSchema.safeParse({ campaign: "retired", repoSlug: "acme/api" }).success).toBe(
      false,
    );
    expect(
      landingCampaignActionContextSchema.safeParse({ campaign: "production-scan", repoSlug: "acme" }).success,
    ).toBe(false);
  });
});

describe("landing campaign metadata schemas", () => {
  it("parses valid trial agent metadata and rejects absent or invalid values", () => {
    const metadata = {
      landingCampaignTrial: true,
      campaign: "seed-api",
      skillSetId: "starter",
      skillSetVersion: "v1",
      repo,
    };

    expect(parseLandingCampaignTrialAgentMetadata(metadata)).toEqual(metadata);
    expect(isLandingCampaignTrialAgentMetadata(metadata)).toBe(true);
    expect(parseLandingCampaignTrialAgentMetadata(undefined)).toBeNull();
    expect(isLandingCampaignTrialAgentMetadata({ ...metadata, campaign: "Invalid Slug" })).toBe(false);
  });

  it("parses valid trial chat metadata with defaults", () => {
    expect(
      parseLandingCampaignTrialChatMetadata({
        landingCampaignTrial: {
          campaign: "seed-api",
          agentId: "agent-1",
          skillSetId: "starter",
          skillSetVersion: "v1",
          repo,
          state: "awaiting_user",
          inputLocked: true,
          awaitingUserKind: "request",
        },
      }),
    ).toEqual({
      campaign: "seed-api",
      agentId: "agent-1",
      skillSetId: "starter",
      skillSetVersion: "v1",
      repo,
      state: "awaiting_user",
      inputLocked: true,
      awaitingUserKind: "request",
      maxAgentTurns: 1,
      completedAgentTurns: 0,
      completedAgentTurnIds: [],
      maxEstimatedTokens: null,
      estimatedTokensUsed: 0,
      lastObservedEstimatedTokens: 0,
      lastObservedTokenUsageEventId: null,
    });
  });

  it("detects locked trial chats and rejects invalid chat metadata", () => {
    const unlocked = {
      landingCampaignTrial: {
        campaign: "seed-api",
        agentId: "agent-1",
        skillSetId: "starter",
        skillSetVersion: "v1",
        repo,
        state: "running",
        inputLocked: false,
      },
    };

    expect(parseLandingCampaignTrialChatMetadata(null)).toBeNull();
    expect(
      parseLandingCampaignTrialChatMetadata({
        landingCampaignTrial: { ...unlocked.landingCampaignTrial, state: "bad" },
      }),
    ).toBeNull();
    expect(isLandingCampaignTrialChatLocked(unlocked)).toBe(false);
    expect(
      isLandingCampaignTrialChatLocked({
        landingCampaignTrial: {
          ...unlocked.landingCampaignTrial,
          inputLocked: true,
        },
      }),
    ).toBe(true);
  });
});
