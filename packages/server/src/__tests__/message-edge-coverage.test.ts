import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { NotFoundError } from "../errors.js";
import { createChat } from "../services/chat.js";
import { buildLandingCampaignChatMetadata } from "../services/landing-campaigns/metadata.js";
import {
  maybeUnwrapDoubleEncoded,
  preflightMessageSendIntent,
  type SendIntentParticipant,
  sendMessage,
} from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("message service edge coverage", () => {
  const getApp = useTestApp();

  const sender = {
    agentId: "sender-1",
    name: "sender",
    displayName: "Sender",
    status: "active",
    type: "agent",
  } satisfies SendIntentParticipant;

  it("rejects inactive explicit and system-routed recipients with recovery copy", () => {
    const suspended = {
      agentId: "target-suspended",
      name: "target",
      displayName: "Suspended Target",
      status: "suspended",
      type: "agent",
    } satisfies SendIntentParticipant;
    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat-1",
        senderId: sender.agentId,
        senderType: "agent",
        data: {
          source: "cli",
          format: "text",
          content: "hello",
          metadata: { mentions: [suspended.agentId] },
        },
        participants: [sender, suspended],
      }),
    ).toThrow(/Reactivate it before sending/);

    const deleted = {
      ...suspended,
      agentId: "target-deleted",
      displayName: "",
      status: "deleted",
    } satisfies SendIntentParticipant;
    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat-1",
        senderId: sender.agentId,
        senderType: "agent",
        data: { source: "cli", format: "text", content: "hello" },
        options: { addressedToAgentIds: [deleted.agentId] },
        participants: [sender, deleted],
      }),
    ).toThrow(/Deleted agents cannot receive new messages/);
  });

  it("returns null when a double-encoded string candidate is not valid JSON", () => {
    expect(maybeUnwrapDoubleEncoded('"bad\\n\\x"')).toBeNull();
  });

  it("rejects sends from an unknown sender before preflight routing", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const peer = await createTestAgent(app, { type: "agent" });
    const chat = await createChat(app.db, owner.agent.uuid, { type: "group", participantIds: [peer.agent.uuid] });

    await expect(
      sendMessage(app.db, chat.id, "missing-sender", {
        source: "cli",
        format: "text",
        content: "hello",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("enforces landing campaign trial chat send locks for humans and agents", async () => {
    const app = getApp();
    const human = await createTestAgent(app, { type: "human", name: `trial-human-${crypto.randomUUID().slice(0, 6)}` });
    const trialAgent = await createTestAgent(app, { name: `trial-agent-${crypto.randomUUID().slice(0, 6)}` });
    const otherAgent = await createTestAgent(app, { name: `trial-other-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [trialAgent.agent.uuid, otherAgent.agent.uuid],
    });
    const setTrialState = (input: {
      state: "running" | "awaiting_user" | "completed" | "failed";
      awaitingUserKind?: "request" | "follow_up";
      completedAgentTurns?: number;
      maxAgentTurns?: number;
    }) =>
      app.db
        .update(chats)
        .set({
          metadata: buildLandingCampaignChatMetadata({
            campaign: "test-campaign",
            agentId: trialAgent.agent.uuid,
            skillSetId: "test-skill",
            skillSetVersion: "1",
            repo: { url: "https://github.com/acme/repo", canonicalKey: "github:acme/repo" },
            state: input.state,
            inputLocked: false,
            awaitingUserKind: input.awaitingUserKind,
            maxAgentTurns: input.maxAgentTurns ?? 2,
            completedAgentTurns: input.completedAgentTurns ?? 0,
          }),
        })
        .where(eq(chats.id, chat.id));
    const humanMessage = {
      source: "cli" as const,
      format: "text" as const,
      content: "hello",
      metadata: { mentions: [trialAgent.agent.uuid] },
    };

    await setTrialState({ state: "completed" });
    await expect(sendMessage(app.db, chat.id, human.agent.uuid, humanMessage)).rejects.toThrow(/already complete/);

    await setTrialState({ state: "running", maxAgentTurns: 1, completedAgentTurns: 1 });
    await expect(sendMessage(app.db, chat.id, human.agent.uuid, humanMessage)).rejects.toThrow(/trial chat is locked/);

    await setTrialState({ state: "awaiting_user", awaitingUserKind: "request" });
    await expect(sendMessage(app.db, chat.id, human.agent.uuid, humanMessage)).rejects.toThrow(/request answer/);

    await setTrialState({ state: "awaiting_user", awaitingUserKind: "request" });
    await expect(
      sendMessage(app.db, chat.id, trialAgent.agent.uuid, {
        source: "cli",
        format: "text",
        content: "agent reply",
        metadata: { mentions: [human.agent.uuid] },
      }),
    ).rejects.toThrow(/only send while the trial is running/);

    await setTrialState({ state: "running" });
    await expect(
      sendMessage(app.db, chat.id, otherAgent.agent.uuid, {
        source: "cli",
        format: "text",
        content: "other reply",
        metadata: { mentions: [human.agent.uuid] },
      }),
    ).rejects.toThrow(/trial chat is locked/);
  });
});
