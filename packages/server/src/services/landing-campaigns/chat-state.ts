import { eq } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { chats } from "../../db/schema/chats.js";
import { getLandingCampaignTrialChat, withLandingCampaignChatState } from "./metadata.js";

type LandingCampaignTrialChat = NonNullable<ReturnType<typeof getLandingCampaignTrialChat>>;

export function hasRemainingLandingCampaignTrialAgentTurns(trial: LandingCampaignTrialChat): boolean {
  return trial.completedAgentTurns < trial.maxAgentTurns;
}

export function normalizeLandingCampaignTrialChatMetadataForRead(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const trial = getLandingCampaignTrialChat({ metadata });
  if (!trial || trial.state !== "running" || trial.inputLocked === false) return metadata;
  if (!hasRemainingLandingCampaignTrialAgentTurns(trial)) return metadata;
  return withLandingCampaignChatState(metadata, "running", false);
}

export async function completeLandingCampaignTrialAgentTurn(
  db: Database,
  chatId: string,
  agentId: string,
  turnCompletionId: string,
): Promise<{ advanced: boolean; reachedTurnLimit: boolean; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    const [chat] = await tx
      .select({ metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, chatId))
      .for("update")
      .limit(1);
    if (!chat) return { advanced: false, reachedTurnLimit: false, duplicate: false };

    const trial = getLandingCampaignTrialChat(chat);
    if (!trial || trial.agentId !== agentId || trial.state !== "running") {
      return { advanced: false, reachedTurnLimit: false, duplicate: false };
    }
    if (trial.completedAgentTurnIds.includes(turnCompletionId)) {
      return {
        advanced: false,
        reachedTurnLimit: !hasRemainingLandingCampaignTrialAgentTurns(trial),
        duplicate: true,
      };
    }
    if (!hasRemainingLandingCampaignTrialAgentTurns(trial)) {
      return { advanced: false, reachedTurnLimit: true, duplicate: false };
    }

    const completedAgentTurns = trial.completedAgentTurns + 1;
    const completedAgentTurnIds = [...trial.completedAgentTurnIds, turnCompletionId];
    const reachedTurnLimit = completedAgentTurns >= trial.maxAgentTurns;
    const nextMetadata = withLandingCampaignChatState(
      chat.metadata,
      reachedTurnLimit ? "completed" : "running",
      reachedTurnLimit,
      { completedAgentTurns, completedAgentTurnIds },
    );

    await tx.update(chats).set({ metadata: nextMetadata, updatedAt: new Date() }).where(eq(chats.id, chatId));
    return { advanced: true, reachedTurnLimit, duplicate: false };
  });
}
