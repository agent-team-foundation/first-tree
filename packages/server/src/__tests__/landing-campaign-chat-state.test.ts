import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { createAgent } from "../services/agent.js";
import {
  completeLandingCampaignTrialAgentTurn,
  normalizeLandingCampaignTrialChatMetadataForRead,
} from "../services/landing-campaigns/chat-state.js";
import { buildLandingCampaignChatMetadata } from "../services/landing-campaigns/metadata.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

function trialMetadata(
  agentId: string,
  overrides: Partial<Parameters<typeof buildLandingCampaignChatMetadata>[0]> = {},
) {
  return buildLandingCampaignChatMetadata({
    campaign: "production-scan",
    agentId,
    skillSetId: "production-scan",
    skillSetVersion: "test",
    repo: { url: "https://github.com/acme/api", canonicalKey: "github.com/acme/api" },
    state: "running",
    inputLocked: false,
    maxAgentTurns: 2,
    ...overrides,
  });
}

describe("landing campaign chat state service edges", () => {
  const getApp = useTestApp();

  async function setupTrialChat(overrides: Partial<Parameters<typeof buildLandingCampaignChatMetadata>[0]> = {}) {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createAgent(app.db, {
      name: `lc-state-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Landing State Agent",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [agent.uuid],
    });
    await app.db
      .update(chats)
      .set({ metadata: trialMetadata(agent.uuid, overrides) })
      .where(eq(chats.id, chatId));
    return { app, agent, chatId };
  }

  it("returns no-op results for missing, non-trial, and wrong-agent chats", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agent = await createAgent(app.db, {
      name: `lc-noop-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Landing Noop Agent",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [agent.uuid],
    });

    await expect(
      completeLandingCampaignTrialAgentTurn(app.db, crypto.randomUUID(), agent.uuid, "turn-missing"),
    ).resolves.toMatchObject({ advanced: false, reachedLimit: false, limitReason: null, duplicate: false });
    await expect(
      completeLandingCampaignTrialAgentTurn(app.db, chatId, agent.uuid, "turn-plain"),
    ).resolves.toMatchObject({ advanced: false, reachedLimit: false, limitReason: null, duplicate: false });

    await app.db
      .update(chats)
      .set({ metadata: trialMetadata("other-agent") })
      .where(eq(chats.id, chatId));
    await expect(
      completeLandingCampaignTrialAgentTurn(app.db, chatId, agent.uuid, "turn-wrong"),
    ).resolves.toMatchObject({ advanced: false, reachedLimit: false, limitReason: null, duplicate: false });
  });

  it("classifies duplicate and already-completed turns without advancing metadata", async () => {
    const duplicate = await setupTrialChat({
      state: "completed",
      inputLocked: true,
      completedAgentTurns: 2,
      completedAgentTurnIds: ["turn-2"],
      limitReason: "turns",
    });

    await expect(
      completeLandingCampaignTrialAgentTurn(duplicate.app.db, duplicate.chatId, duplicate.agent.uuid, "turn-2"),
    ).resolves.toEqual({
      advanced: false,
      reachedTurnLimit: true,
      reachedLimit: true,
      limitReason: "turns",
      duplicate: true,
    });

    const completed = await setupTrialChat({
      state: "completed",
      inputLocked: true,
      completedAgentTurns: 1,
      maxEstimatedTokens: 100,
      estimatedTokensUsed: 100,
      limitReason: "tokens",
    });
    await expect(
      completeLandingCampaignTrialAgentTurn(completed.app.db, completed.chatId, completed.agent.uuid, "turn-new"),
    ).resolves.toEqual({
      advanced: false,
      reachedTurnLimit: false,
      reachedLimit: true,
      limitReason: "tokens",
      duplicate: false,
    });
  });

  it("classifies exhausted running trials without advancing metadata", async () => {
    const exhausted = await setupTrialChat({
      state: "running",
      inputLocked: true,
      completedAgentTurns: 2,
      maxAgentTurns: 2,
    });

    await expect(
      completeLandingCampaignTrialAgentTurn(exhausted.app.db, exhausted.chatId, exhausted.agent.uuid, "turn-new"),
    ).resolves.toEqual({
      advanced: false,
      reachedTurnLimit: true,
      reachedLimit: true,
      limitReason: "turns",
      duplicate: false,
    });
  });

  it("unlocks running trial metadata on read only when budget remains", () => {
    const locked = trialMetadata("agent-1", { inputLocked: true, completedAgentTurns: 0, maxAgentTurns: 2 });

    expect(normalizeLandingCampaignTrialChatMetadataForRead(locked)).toMatchObject({
      landingCampaignTrial: { inputLocked: false, state: "running" },
    });
    expect(
      normalizeLandingCampaignTrialChatMetadataForRead(
        trialMetadata("agent-1", { inputLocked: true, completedAgentTurns: 2, maxAgentTurns: 2 }),
      ),
    ).toMatchObject({ landingCampaignTrial: { inputLocked: true } });
  });
});
