import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { addParticipant, createChat } from "../services/chat.js";
import { buildClientMessagePayload, buildClientMessagePayloadsForInbox } from "../services/message-dispatcher.js";
import { createAdminContext, createTestApp } from "./helpers.js";

let app: FastifyInstance;
let ctx: { memberId: string; clientId: string };

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  ctx = await createAdminContext(app, { username: `disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
});

const RAW = {
  id: "msg-1",
  chatId: "chat-1",
  senderId: "sender-1",
  format: "text",
  content: "hello",
  metadata: {},
  inReplyTo: null,
  source: null as string | null,
  createdAt: new Date().toISOString(),
};

describe("buildClientMessagePayload (Step 3)", () => {
  it("includes the current config version (initial = 1)", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-fresh-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const built = await buildClientMessagePayload(app.db, { kind: "agentId", agentId: agent.uuid }, RAW);
    expect(built.configVersion).toBe(1);
    expect(built.id).toBe(RAW.id);
  });

  it("reflects bumped config version after PATCH", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-bumped-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    await app.configService.update(agent.uuid, { expectedVersion: 1, payload: { model: "claude-opus-4-6" } }, "test");
    await app.configService.flush(agent.uuid);
    const built = await buildClientMessagePayload(app.db, { kind: "agentId", agentId: agent.uuid }, RAW);
    expect(built.configVersion).toBe(2);
  });

  it("resolves agentId from inboxId", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-inbox-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const built = await buildClientMessagePayload(app.db, { kind: "inboxId", inboxId: agent.inboxId }, RAW);
    expect(built.configVersion).toBe(1);
    expect(built.id).toBe(RAW.id);
  });

  it("batch variant returns the same version for all messages", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-batch-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const messages = Array.from({ length: 3 }, (_, i) => ({
      entryChatId: RAW.chatId,
      message: { ...RAW, id: `msg-${i}` },
    }));
    const built = await buildClientMessagePayloadsForInbox(app.db, agent.inboxId, messages);
    expect(built.map((b) => b.configVersion)).toEqual([1, 1, 1]);
  });

  it("normalises unknown source values to null", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-srcN-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      { ...RAW, source: "totally-not-a-known-source" },
    );
    expect(built.source).toBeNull();
  });

  it("throws when inboxId has no owning agent", async () => {
    await expect(
      buildClientMessagePayload(app.db, { kind: "inboxId", inboxId: "inbox_does_not_exist" }, RAW),
    ).rejects.toThrow(/No agent owns inbox/);
  });
});

/**
 * v2: `chat_membership.mode` is decision-inert. The wire payload still
 * carries `recipientMode` for backwards compatibility with already-deployed
 * client runtimes, but the value is the constant `"mention_only"` for every
 * recipient and the dispatcher no longer reads `chat_membership.mode` to
 * decide it. See proposals/hub-chat-message-v2-simplify-mode.20260520.md §七.
 */
describe("buildClientMessagePayload — recipientMode (v2 constant)", () => {
  it("emits the constant 'mention_only' regardless of the agent / chat shape", async () => {
    const agent = await createAgent(app.db, {
      name: `rmode-stranger-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      RAW,
      "unrelated-chat-id",
    );
    expect(built.recipientMode).toBe("mention_only");
  });

  it("agent↔agent two-speaker chat → 'mention_only' wire value", async () => {
    const a1 = await createAgent(app.db, {
      name: `rmode-dir1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const a2 = await createAgent(app.db, {
      name: `rmode-dir2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: a2.uuid },
      { ...RAW, chatId: chat.id },
      chat.id,
    );
    expect(built.recipientMode).toBe("mention_only");
  });

  it("human↔agent two-speaker chat → 'mention_only' wire value (no v1 'full' derivation)", async () => {
    const human = await createAgent(app.db, {
      name: `rmode-hum-${Date.now()}`,
      type: "human",
      managerId: ctx.memberId,
    });
    const agent = await createAgent(app.db, {
      name: `rmode-agt-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, human.uuid, { type: "group", participantIds: [agent.uuid] });
    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: agent.uuid },
      { ...RAW, chatId: chat.id },
      chat.id,
    );
    expect(built.recipientMode).toBe("mention_only");
  });

  it("3+ speaker group → every speaker gets the same constant", async () => {
    const a1 = await createAgent(app.db, {
      name: `rmode-a1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const a2 = await createAgent(app.db, {
      name: `rmode-a2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const a3 = await createAgent(app.db, {
      name: `rmode-a3-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const chat = await createChat(app.db, a1.uuid, { type: "group", participantIds: [a2.uuid] });
    await addParticipant(app.db, chat.id, a1.uuid, { agentId: a3.uuid });

    const built = await buildClientMessagePayload(
      app.db,
      { kind: "agentId", agentId: a3.uuid },
      { ...RAW, chatId: chat.id },
      chat.id,
    );
    expect(built.recipientMode).toBe("mention_only");
  });

  it("batch variant emits the same constant wire value for every item", async () => {
    const a1 = await createAgent(app.db, {
      name: `batch-a1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const a2 = await createAgent(app.db, {
      name: `batch-a2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const group = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [a2.uuid],
    });

    const built = await buildClientMessagePayloadsForInbox(app.db, a1.inboxId, [
      {
        entryChatId: group.id,
        message: {
          ...RAW,
          id: `msg-a-${Date.now()}`,
          chatId: group.id,
          senderId: a2.uuid,
          content: "first",
        },
      },
      {
        entryChatId: group.id,
        message: {
          ...RAW,
          id: `msg-b-${Date.now()}`,
          chatId: group.id,
          senderId: a2.uuid,
          content: "second",
        },
      },
    ]);

    expect(built).toHaveLength(2);
    const first = built[0];
    const second = built[1];
    if (!first || !second) throw new Error("expected two payloads");
    expect(first.recipientMode).toBe("mention_only");
    expect(second.recipientMode).toBe("mention_only");
  });
});
