import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { decideScmPersonnelTargetChat } from "../services/scm-target-chat-policy.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("SCM personnel target chat policy", () => {
  const getApp = useTestApp();

  async function setupChat() {
    const app = getApp();
    const human = await createTestAdmin(app, {
      username: `target-policy-${randomUUID().slice(0, 8)}`,
    });
    const wake = await createAgent(app.db, {
      name: `target-agent-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Target Agent",
      managerId: human.memberId,
      organizationId: human.organizationId,
    });
    const chat = await createChat(app.db, human.humanAgentUuid, {
      type: "group",
      participantIds: [wake.uuid],
    });
    return { app, humanAgentId: human.humanAgentUuid, wakeAgentId: wake.uuid, chatId: chat.id };
  }

  it("reuses exactly one reviewer membership chat", async () => {
    const setup = await setupChat();
    await expect(
      decideScmPersonnelTargetChat(setup.app.db, {
        reason: "review_requested",
        candidateChatIds: [setup.chatId],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "reuse", chatId: setup.chatId });
  });

  it("fails closed for zero or multiple reviewer candidates", async () => {
    const first = await setupChat();
    const second = await createChat(first.app.db, first.humanAgentId, {
      type: "group",
      participantIds: [first.wakeAgentId],
    });
    await expect(
      decideScmPersonnelTargetChat(first.app.db, {
        reason: "review_requested",
        candidateChatIds: [],
        humanAgentId: first.humanAgentId,
        wakeAgentId: first.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "strict_new_line" });
    await expect(
      decideScmPersonnelTargetChat(first.app.db, {
        reason: "review_requested",
        candidateChatIds: [first.chatId, second.id],
        humanAgentId: first.humanAgentId,
        wakeAgentId: first.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "strict_new_line" });
  });

  it.each(["mentioned", "assigned"] as const)("%s always establishes a strict line", async (reason) => {
    const setup = await setupChat();
    await expect(
      decideScmPersonnelTargetChat(setup.app.db, {
        reason,
        candidateChatIds: [setup.chatId],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "strict_new_line" });
  });
});
