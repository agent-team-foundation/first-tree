import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import {
  decideScmPersonnelTargetChat,
  lockAndValidateScmPersonnelPlacement,
} from "../services/scm-target-chat-policy.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("SCM personnel target chat policy", () => {
  const getApp = useTestApp();

  async function decideWithCurrentAuthority(
    db: ReturnType<typeof getApp>["db"],
    input: Omit<Parameters<typeof decideScmPersonnelTargetChat>[1], "authority" | "speakerSnapshot">,
  ) {
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as ReturnType<typeof getApp>["db"];
      const placement = await lockAndValidateScmPersonnelPlacement(tx, input);
      if (!placement) return null;
      return decideScmPersonnelTargetChat(tx, {
        ...input,
        authority: placement.authority,
        speakerSnapshot: placement.speakerSnapshot,
      });
    });
  }

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
    await app.db.update(agents).set({ delegateMention: wake.uuid }).where(eq(agents.uuid, human.humanAgentUuid));
    const chat = await createChat(app.db, human.humanAgentUuid, {
      type: "group",
      participantIds: [wake.uuid],
    });
    return { app, humanAgentId: human.humanAgentUuid, wakeAgentId: wake.uuid, chatId: chat.id };
  }

  async function setupOwnerPrivateCandidate() {
    const app = getApp();
    const human = await createTestAdmin(app, {
      username: `target-private-${randomUUID().slice(0, 8)}`,
    });
    const follower = await createAgent(app.db, {
      name: `existing-follower-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Existing Follower",
      managerId: human.memberId,
      organizationId: human.organizationId,
    });
    const wake = await createAgent(app.db, {
      name: `current-delegate-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Current Delegate",
      managerId: human.memberId,
      organizationId: human.organizationId,
    });
    await app.db.update(agents).set({ delegateMention: wake.uuid }).where(eq(agents.uuid, human.humanAgentUuid));
    const chat = await createChat(app.db, human.humanAgentUuid, {
      type: "group",
      participantIds: [follower.uuid],
    });
    return {
      app,
      human,
      followerAgentId: follower.uuid,
      humanAgentId: human.humanAgentUuid,
      wakeAgentId: wake.uuid,
      chatId: chat.id,
    };
  }

  it("reuses exactly one reviewer membership chat", async () => {
    const setup = await setupChat();
    await expect(
      decideWithCurrentAuthority(setup.app.db, {
        requiresPersistentLine: false,
        candidateChatIds: [setup.chatId],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "reuse_membership", chatId: setup.chatId });
  });

  it("fails closed for zero or multiple reviewer candidates", async () => {
    const first = await setupChat();
    const second = await createChat(first.app.db, first.humanAgentId, {
      type: "group",
      participantIds: [first.wakeAgentId],
    });
    await expect(
      decideWithCurrentAuthority(first.app.db, {
        requiresPersistentLine: false,
        candidateChatIds: [],
        humanAgentId: first.humanAgentId,
        wakeAgentId: first.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "strict_new_line" });
    await expect(
      decideWithCurrentAuthority(first.app.db, {
        requiresPersistentLine: false,
        candidateChatIds: [first.chatId, second.id],
        humanAgentId: first.humanAgentId,
        wakeAgentId: first.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "strict_new_line" });
  });

  it.each(["mentioned", "assigned"] as const)("%s reuses an exact membership chat with a line", async () => {
    const setup = await setupChat();
    await expect(
      decideWithCurrentAuthority(setup.app.db, {
        requiresPersistentLine: true,
        candidateChatIds: [setup.chatId],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "reuse_with_line", chatId: setup.chatId, admitWakeAgent: false });
  });

  it("admits a persistent target only into one owner-private candidate", async () => {
    const setup = await setupOwnerPrivateCandidate();
    await expect(
      decideWithCurrentAuthority(setup.app.db, {
        requiresPersistentLine: true,
        candidateChatIds: [setup.chatId],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "reuse_with_line", chatId: setup.chatId, admitWakeAgent: true });
  });

  it("fails closed when more than one owner-private candidate exists", async () => {
    const setup = await setupOwnerPrivateCandidate();
    const second = await createChat(setup.app.db, setup.humanAgentId, {
      type: "group",
      participantIds: [setup.followerAgentId],
    });
    await expect(
      decideWithCurrentAuthority(setup.app.db, {
        requiresPersistentLine: true,
        candidateChatIds: [setup.chatId, second.id],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "strict_new_line" });
  });

  it("does not treat a chat containing another owner's agent as owner-private", async () => {
    const setup = await setupOwnerPrivateCandidate();
    const otherOwner = await createTestAdmin(setup.app, {
      username: `target-foreign-${randomUUID().slice(0, 8)}`,
    });
    const foreignAgent = await createAgent(setup.app.db, {
      name: `foreign-agent-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Foreign Agent",
      managerId: otherOwner.memberId,
      organizationId: setup.human.organizationId,
      visibility: "organization",
    });
    const chat = await createChat(setup.app.db, setup.humanAgentId, {
      type: "group",
      participantIds: [setup.followerAgentId, foreignAgent.uuid],
    });
    await expect(
      decideWithCurrentAuthority(setup.app.db, {
        requiresPersistentLine: true,
        candidateChatIds: [chat.id],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toEqual({ kind: "strict_new_line" });
  });

  it("fails closed after delegate drift or delegate suspension", async () => {
    const setup = await setupOwnerPrivateCandidate();
    await setup.app.db
      .update(agents)
      .set({ delegateMention: setup.followerAgentId })
      .where(eq(agents.uuid, setup.humanAgentId));
    await expect(
      decideWithCurrentAuthority(setup.app.db, {
        requiresPersistentLine: true,
        candidateChatIds: [setup.chatId],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toBeNull();

    await setup.app.db
      .update(agents)
      .set({ delegateMention: setup.wakeAgentId })
      .where(eq(agents.uuid, setup.humanAgentId));
    await setup.app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, setup.wakeAgentId));
    await expect(
      decideWithCurrentAuthority(setup.app.db, {
        requiresPersistentLine: true,
        candidateChatIds: [setup.chatId],
        humanAgentId: setup.humanAgentId,
        wakeAgentId: setup.wakeAgentId,
      }),
    ).resolves.toBeNull();
  });
});
