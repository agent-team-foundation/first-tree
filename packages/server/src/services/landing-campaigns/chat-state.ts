import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { chats } from "../../db/schema/chats.js";
import { sessionEvents } from "../../db/schema/session-events.js";
import { getLandingCampaignTrialChat, withLandingCampaignChatState } from "./metadata.js";

type LandingCampaignTrialChat = NonNullable<ReturnType<typeof getLandingCampaignTrialChat>>;
type LandingCampaignTrialLimitReason = NonNullable<LandingCampaignTrialChat["limitReason"]>;
type LandingCampaignTrialCompletionResult = {
  advanced: boolean;
  reachedTurnLimit: boolean;
  reachedLimit: boolean;
  limitReason: LandingCampaignTrialLimitReason | null;
  duplicate: boolean;
};

export function hasRemainingLandingCampaignTrialAgentTurns(trial: LandingCampaignTrialChat): boolean {
  return trial.completedAgentTurns < trial.maxAgentTurns;
}

export function hasRemainingLandingCampaignTrialBudget(trial: LandingCampaignTrialChat): boolean {
  return (
    hasRemainingLandingCampaignTrialAgentTurns(trial) &&
    (trial.maxEstimatedTokens === null || trial.estimatedTokensUsed < trial.maxEstimatedTokens)
  );
}

function limitReasonForTrial(trial: LandingCampaignTrialChat): LandingCampaignTrialLimitReason | null {
  if (trial.limitReason) return trial.limitReason;
  if (!hasRemainingLandingCampaignTrialAgentTurns(trial)) return "turns";
  if (trial.maxEstimatedTokens !== null && trial.estimatedTokensUsed >= trial.maxEstimatedTokens) return "tokens";
  return null;
}

export function normalizeLandingCampaignTrialChatMetadataForRead(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const trial = getLandingCampaignTrialChat({ metadata });
  if (!trial || trial.state !== "running" || trial.inputLocked === false) return metadata;
  if (!hasRemainingLandingCampaignTrialBudget(trial)) return metadata;
  return withLandingCampaignChatState(metadata, "running", false);
}

export async function completeLandingCampaignTrialAgentTurn(
  db: Database,
  chatId: string,
  agentId: string,
  turnCompletionId: string,
): Promise<LandingCampaignTrialCompletionResult> {
  return db.transaction(async (tx) => {
    const [chat] = await tx
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, chatId))
      .for("update")
      .limit(1);
    if (!chat) {
      return { advanced: false, reachedTurnLimit: false, reachedLimit: false, limitReason: null, duplicate: false };
    }

    const trial = getLandingCampaignTrialChat(chat);
    if (!trial || trial.agentId !== agentId) {
      return { advanced: false, reachedTurnLimit: false, reachedLimit: false, limitReason: null, duplicate: false };
    }
    if (trial.completedAgentTurnIds.includes(turnCompletionId)) {
      const limitReason = limitReasonForTrial(trial);
      return {
        advanced: false,
        reachedTurnLimit: limitReason === "turns",
        reachedLimit: limitReason !== null,
        limitReason,
        duplicate: true,
      };
    }
    if (trial.state !== "running") {
      const limitReason = limitReasonForTrial(trial);
      return {
        advanced: false,
        reachedTurnLimit: limitReason === "turns",
        reachedLimit: limitReason !== null,
        limitReason,
        duplicate: false,
      };
    }
    if (!hasRemainingLandingCampaignTrialBudget(trial)) {
      const limitReason = limitReasonForTrial(trial);
      return {
        advanced: false,
        reachedTurnLimit: limitReason === "turns",
        reachedLimit: limitReason !== null,
        limitReason,
        duplicate: false,
      };
    }

    const [usageRow] = await tx
      .select({
        estimatedTokens: sql<string>`coalesce(sum(
          coalesce((${sessionEvents.payload}->>'inputTokens')::bigint, 0) +
          coalesce((${sessionEvents.payload}->>'cachedInputTokens')::bigint, 0) +
          coalesce((${sessionEvents.payload}->>'outputTokens')::bigint, 0)
        ), 0)::text`,
      })
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.agentId, agentId),
          eq(sessionEvents.chatId, chatId),
          eq(sessionEvents.kind, "token_usage"),
        ),
      );

    const observedEstimatedTokens = Number(usageRow?.estimatedTokens ?? 0);
    const turnEstimatedTokens =
      observedEstimatedTokens >= trial.lastObservedEstimatedTokens
        ? observedEstimatedTokens - trial.lastObservedEstimatedTokens
        : observedEstimatedTokens;
    const estimatedTokensUsed = trial.estimatedTokensUsed + turnEstimatedTokens;
    const completedAgentTurns = trial.completedAgentTurns + 1;
    const completedAgentTurnIds = [...trial.completedAgentTurnIds, turnCompletionId];
    const reachedTurnLimit = completedAgentTurns >= trial.maxAgentTurns;
    const reachedTokenLimit = trial.maxEstimatedTokens !== null && estimatedTokensUsed >= trial.maxEstimatedTokens;
    const limitReason: LandingCampaignTrialLimitReason | null = reachedTokenLimit
      ? "tokens"
      : reachedTurnLimit
        ? "turns"
        : null;
    const reachedLimit = limitReason !== null;
    const nextMetadata = withLandingCampaignChatState(
      chat.metadata,
      reachedLimit ? "completed" : "running",
      reachedLimit,
      {
        completedAgentTurns,
        completedAgentTurnIds,
        estimatedTokensUsed,
        lastObservedEstimatedTokens: observedEstimatedTokens,
        ...(limitReason ? { limitReason } : {}),
      },
    );

    await tx.update(chats).set({ metadata: nextMetadata, updatedAt: new Date() }).where(eq(chats.id, chatId));
    return { advanced: true, reachedTurnLimit, reachedLimit, limitReason, duplicate: false };
  });
}
