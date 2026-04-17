import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
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
  replyToInbox: null,
  replyToChat: null,
  inReplyTo: null,
  source: null as string | null,
  createdAt: new Date().toISOString(),
};

describe("buildClientMessagePayload (Step 3)", () => {
  it("includes the current config version (initial = 1)", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-fresh-${Date.now()}`,
      type: "autonomous_agent",
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
      type: "autonomous_agent",
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
      type: "autonomous_agent",
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
      type: "autonomous_agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const messages = Array.from({ length: 3 }, (_, i) => ({ ...RAW, id: `msg-${i}` }));
    const built = await buildClientMessagePayloadsForInbox(app.db, agent.inboxId, messages);
    expect(built.map((b) => b.configVersion)).toEqual([1, 1, 1]);
  });

  it("normalises unknown source values to null", async () => {
    const agent = await createAgent(app.db, {
      name: `disp-srcN-${Date.now()}`,
      type: "autonomous_agent",
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
