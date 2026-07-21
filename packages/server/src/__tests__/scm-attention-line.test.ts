import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { createMeChat } from "../services/me-chat.js";
import {
  executeScmFollowLine,
  resolveAgentScmBindingPair,
  resolveHumanScmBindingPair,
} from "../services/scm-attention-line.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("SCM attention binding pair policy", () => {
  const getApp = useTestApp();

  it("resolves the same complete pair for agent and human follow", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `pair-${randomUUID().slice(0, 8)}` });
    const { chatId } = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    await app.db
      .update(agents)
      .set({ delegateMention: runtime.agent.uuid })
      .where(eq(agents.uuid, runtime.humanAgentUuid));

    await expect(resolveAgentScmBindingPair(app.db, chatId, runtime.agent.uuid)).resolves.toEqual({
      organizationId: runtime.organizationId,
      humanAgentId: runtime.humanAgentUuid,
      wakeAgentId: runtime.agent.uuid,
    });
    await expect(resolveHumanScmBindingPair(app.db, chatId, runtime.humanAgentUuid)).resolves.toEqual({
      organizationId: runtime.organizationId,
      humanAgentId: runtime.humanAgentUuid,
      wakeAgentId: runtime.agent.uuid,
    });
  });

  it("uses a stable active-human fallback for agent follow without relaxing human follow", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `pair-fallback-${randomUUID().slice(0, 8)}` });
    const other = await createTestAgent(app, { name: `pair-other-${randomUUID().slice(0, 8)}` });
    const { chatId } = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    await expect(resolveHumanScmBindingPair(app.db, chatId, runtime.humanAgentUuid)).resolves.toBeNull();

    await app.db.insert(chatMembership).values({
      chatId,
      agentId: other.humanAgentUuid,
      role: "member",
      accessMode: "speaker",
    });
    const representativeHumanId =
      runtime.humanAgentUuid < other.humanAgentUuid ? runtime.humanAgentUuid : other.humanAgentUuid;
    await expect(resolveAgentScmBindingPair(app.db, chatId, runtime.agent.uuid)).resolves.toEqual({
      organizationId: runtime.organizationId,
      humanAgentId: representativeHumanId,
      wakeAgentId: runtime.agent.uuid,
    });
  });

  it("fails closed when multiple humans explicitly link the same wake agent", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `pair-linked-${randomUUID().slice(0, 8)}` });
    const other = await createTestAgent(app, { name: `pair-linked-other-${randomUUID().slice(0, 8)}` });
    const { chatId } = await createMeChat(app.db, runtime.humanAgentUuid, runtime.organizationId, {
      participantIds: [runtime.agent.uuid],
    });
    await app.db
      .update(agents)
      .set({ delegateMention: runtime.agent.uuid })
      .where(eq(agents.uuid, runtime.humanAgentUuid));
    await app.db
      .update(agents)
      .set({ delegateMention: runtime.agent.uuid })
      .where(eq(agents.uuid, other.humanAgentUuid));
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: other.humanAgentUuid,
      role: "member",
      accessMode: "speaker",
    });

    await expect(resolveAgentScmBindingPair(app.db, chatId, runtime.agent.uuid)).resolves.toBeNull();
  });
});

describe.each(["github", "gitlab"] as const)("%s shared follow-line state machine", () => {
  type Line = { id: string; chatId: string };

  function harness(initial: Line[] = []) {
    let lines = [...initial];
    let moveVanishes = false;
    let concurrentCreate: Line | null = null;
    const storage = {
      listLines: async () => [...lines],
      removeLines: async (removed: Line[]) => {
        const ids = new Set(removed.map((line) => line.id));
        lines = lines.filter((line) => !ids.has(line.id));
      },
      getChatTopic: async (chatId: string) => `topic:${chatId}`,
      moveLine: async (line: Line) => {
        if (moveVanishes) {
          lines = lines.filter((candidate) => candidate.id !== line.id);
          if (concurrentCreate) lines.push(concurrentCreate);
          return null;
        }
        const moved = { ...line, chatId: "target" };
        lines = lines.map((candidate) => (candidate.id === line.id ? moved : candidate));
        return moved;
      },
      createLine: async () => {
        const existing = lines[0];
        if (existing) return { record: existing, inserted: false };
        const created = { id: "created", chatId: "target" };
        lines.push(created);
        return { record: created, inserted: true };
      },
    };
    return {
      storage,
      lines: () => lines,
      vanishOnMove(concurrent?: Line) {
        moveVanishes = true;
        concurrentCreate = concurrent ?? null;
      },
    };
  }

  it("shares idempotency, conflict, duplicate cleanup, and rebind outcomes", async () => {
    const same = harness([
      { id: "same", chatId: "target" },
      { id: "duplicate", chatId: "other" },
    ]);
    await expect(
      executeScmFollowLine({ targetChatId: "target", rebind: false, storage: same.storage }),
    ).resolves.toEqual({ outcome: "already_following", record: { id: "same", chatId: "target" } });
    expect(same.lines()).toEqual([{ id: "same", chatId: "target" }]);

    const conflict = harness([{ id: "existing", chatId: "other" }]);
    await expect(
      executeScmFollowLine({ targetChatId: "target", rebind: false, storage: conflict.storage }),
    ).resolves.toEqual({
      outcome: "conflict",
      conflict: { chatId: "other", topic: "topic:other" },
    });

    const rebound = harness([{ id: "existing", chatId: "other" }]);
    await expect(
      executeScmFollowLine({ targetChatId: "target", rebind: true, storage: rebound.storage }),
    ).resolves.toEqual({
      outcome: "rebound",
      record: { id: "existing", chatId: "target" },
    });
  });

  it("shares the vanished-row retry and third-writer conflict outcome", async () => {
    const retry = harness([{ id: "existing", chatId: "other" }]);
    retry.vanishOnMove();
    await expect(
      executeScmFollowLine({ targetChatId: "target", rebind: true, storage: retry.storage }),
    ).resolves.toEqual({
      outcome: "created",
      record: { id: "created", chatId: "target" },
    });

    const thirdWriter = harness([{ id: "existing", chatId: "other" }]);
    thirdWriter.vanishOnMove({ id: "third", chatId: "third-chat" });
    await expect(
      executeScmFollowLine({ targetChatId: "target", rebind: true, storage: thirdWriter.storage }),
    ).resolves.toEqual({
      outcome: "conflict",
      conflict: { chatId: "third-chat", topic: "topic:third-chat" },
    });
  });
});
