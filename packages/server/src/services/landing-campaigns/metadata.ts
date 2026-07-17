import {
  type LandingCampaignActionConversion,
  type LandingCampaignAttribution,
  type LandingCampaignRepoMetadata,
  type LandingCampaignTrialAwaitingUserKind,
  type LandingCampaignTrialChatState,
  type LandingCampaignTrialLimitReason,
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
}): Record<string, unknown> {
  return {
    landingCampaignTrial: true,
    campaign: input.campaign,
    skillSetId: input.skillSetId,
    skillSetVersion: input.skillSetVersion,
  };
}

export function buildLandingCampaignChatMetadata(input: {
  campaign: string;
  agentId: string;
  skillSetId: string;
  skillSetVersion: string;
  repo: LandingCampaignRepoMetadata;
  attribution?: LandingCampaignAttribution;
  actionConversion?: LandingCampaignActionConversion;
  state: LandingCampaignTrialChatState;
  inputLocked: boolean;
  awaitingUserKind?: LandingCampaignTrialAwaitingUserKind;
  /** Required: an omitted budget must not silently stamp a 1-turn trial. */
  maxAgentTurns: number;
  completedAgentTurns?: number;
  completedAgentTurnIds?: string[];
  maxEstimatedTokens?: number | null;
  estimatedTokensUsed?: number;
  lastObservedEstimatedTokens?: number;
  lastObservedTokenUsageEventId?: string | null;
  limitReason?: LandingCampaignTrialLimitReason;
}): Record<string, unknown> {
  return {
    landingCampaignTrial: {
      campaign: input.campaign,
      agentId: input.agentId,
      skillSetId: input.skillSetId,
      skillSetVersion: input.skillSetVersion,
      repo: input.repo,
      ...(input.attribution ? { attribution: input.attribution } : {}),
      ...(input.actionConversion ? { actionConversion: input.actionConversion } : {}),
      state: input.state,
      inputLocked: input.inputLocked,
      ...(input.awaitingUserKind ? { awaitingUserKind: input.awaitingUserKind } : {}),
      maxAgentTurns: input.maxAgentTurns,
      completedAgentTurns: input.completedAgentTurns ?? 0,
      completedAgentTurnIds: input.completedAgentTurnIds ?? [],
      maxEstimatedTokens: input.maxEstimatedTokens ?? null,
      estimatedTokensUsed: input.estimatedTokensUsed ?? 0,
      lastObservedEstimatedTokens: input.lastObservedEstimatedTokens ?? 0,
      lastObservedTokenUsageEventId: input.lastObservedTokenUsageEventId ?? null,
      ...(input.limitReason ? { limitReason: input.limitReason } : {}),
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
    completedAgentTurnIds?: string[];
    maxAgentTurns?: number;
    maxEstimatedTokens?: number | null;
    estimatedTokensUsed?: number;
    lastObservedEstimatedTokens?: number;
    lastObservedTokenUsageEventId?: string | null;
    limitReason?: LandingCampaignTrialLimitReason;
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
  if (state !== "completed") {
    delete nextTrial.limitReason;
  }
  return {
    ...metadata,
    landingCampaignTrial: nextTrial,
  };
}
