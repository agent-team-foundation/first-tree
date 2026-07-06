import {
  type LandingCampaignRepoMetadata,
  type LandingCampaignTrialAwaitingUserKind,
  type LandingCampaignTrialChatState,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
} from "@first-tree/shared";

export type LandingCampaignTrialAgentLike = {
  metadata: Record<string, unknown> | null;
};

export type LandingCampaignTrialChatLike = {
  metadata: Record<string, unknown> | null;
};

export function isLandingCampaignTrialAgent(agent: LandingCampaignTrialAgentLike | null | undefined): boolean {
  return parseLandingCampaignTrialAgentMetadata(agent?.metadata) !== null;
}

export function getLandingCampaignTrialChat(chat: LandingCampaignTrialChatLike | null | undefined) {
  return parseLandingCampaignTrialChatMetadata(chat?.metadata);
}

export function buildLandingCampaignAgentMetadata(input: {
  campaign: string;
  skillSetId: string;
  skillSetVersion: string;
  repo: LandingCampaignRepoMetadata;
}): Record<string, unknown> {
  return {
    landingCampaignTrial: true,
    campaign: input.campaign,
    skillSetId: input.skillSetId,
    skillSetVersion: input.skillSetVersion,
    repo: input.repo,
  };
}

export function buildLandingCampaignChatMetadata(input: {
  campaign: string;
  agentId: string;
  skillSetId: string;
  skillSetVersion: string;
  repo: LandingCampaignRepoMetadata;
  state: LandingCampaignTrialChatState;
  inputLocked: boolean;
  awaitingUserKind?: LandingCampaignTrialAwaitingUserKind;
  maxAgentTurns?: number;
  completedAgentTurns?: number;
}): Record<string, unknown> {
  return {
    landingCampaignTrial: {
      campaign: input.campaign,
      agentId: input.agentId,
      skillSetId: input.skillSetId,
      skillSetVersion: input.skillSetVersion,
      repo: input.repo,
      state: input.state,
      inputLocked: input.inputLocked,
      ...(input.awaitingUserKind ? { awaitingUserKind: input.awaitingUserKind } : {}),
      maxAgentTurns: input.maxAgentTurns ?? 1,
      completedAgentTurns: input.completedAgentTurns ?? 0,
    },
  };
}

export function withLandingCampaignChatState(
  metadata: Record<string, unknown>,
  state: LandingCampaignTrialChatState,
  inputLocked: boolean,
  updates: {
    awaitingUserKind?: LandingCampaignTrialAwaitingUserKind;
    completedAgentTurns?: number;
    maxAgentTurns?: number;
  } = {},
): Record<string, unknown> {
  const current = parseLandingCampaignTrialChatMetadata(metadata);
  if (!current) return metadata;
  const nextTrial = {
    ...current,
    state,
    inputLocked,
    ...updates,
  };
  if (state !== "awaiting_user") {
    delete nextTrial.awaitingUserKind;
  }
  return {
    ...metadata,
    landingCampaignTrial: nextTrial,
  };
}
