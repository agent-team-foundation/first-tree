import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Participants API", () => {
  const getApp = useTestApp();

  async function setupChat(app: FastifyInstance) {
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `part-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `part-a2-${uid}` });
    const a3 = await createTestAgent(app, { name: `part-a3-${uid}` });

    const res = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chat = res.json();
    return { a1, a2, a3, chatId: chat.id };
  }

  it("adds a participant to a chat", async () => {
    const app = getApp();
    const { a1, a3, chatId } = await setupChat(app);

    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {
      agentId: a3.agent.uuid,
    });
    expect(res.statusCode).toBe(201);
    const participants = res.json();
    expect(participants).toHaveLength(3);
    expect(participants.map((p: { agentId: string }) => p.agentId)).toContain(a3.agent.uuid);
  });

  it("adds a participant by name (chat invite CLI path)", async () => {
    const app = getApp();
    const { a1, a3, chatId } = await setupChat(app);
    if (!a3.agent.name) throw new Error("a3 name missing");

    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {
      agentName: a3.agent.name,
    });
    expect(res.statusCode).toBe(201);
    const participants = res.json();
    expect(participants.map((p: { agentId: string }) => p.agentId)).toContain(a3.agent.uuid);
  });

  it("adds an active human by name (chat invite CLI path)", async () => {
    const app = getApp();
    const { a1, chatId } = await setupChat(app);
    const human = await createTestAgent(app, {
      type: "human",
      name: `part-human-${crypto.randomUUID().slice(0, 6)}`,
    });
    if (!human.agent.name) throw new Error("human participant name missing");

    const addRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {
      agentName: human.agent.name,
    });
    expect(addRes.statusCode).toBe(201);
    expect(addRes.json().map((p: { agentId: string }) => p.agentId)).toContain(human.agent.uuid);
  });

  it("rejects request with neither agentId nor agentName", async () => {
    const app = getApp();
    const { a1, chatId } = await setupChat(app);

    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {});
    expect(res.statusCode).toBe(400);
  });

  it("rejects request with both agentId and agentName", async () => {
    const app = getApp();
    const { a1, a3, chatId } = await setupChat(app);
    if (!a3.agent.name) throw new Error("a3 name missing");

    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {
      agentId: a3.agent.uuid,
      agentName: a3.agent.name,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects adding duplicate participant", async () => {
    const app = getApp();
    const { a1, a2, chatId } = await setupChat(app);

    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {
      agentId: a2.agent.uuid,
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects adding non-existent agent", async () => {
    const app = getApp();
    const { a1, chatId } = await setupChat(app);

    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {
      agentId: "non-existent-agent",
    });
    expect(res.statusCode).toBe(404);
  });

  it("removes a participant from a chat", async () => {
    const app = getApp();
    const { a1, a2, chatId } = await setupChat(app);

    const res = await a1.request("DELETE", `/api/v1/agent/chats/${chatId}/participants/${a2.agent.uuid}`);
    expect(res.statusCode).toBe(204);

    const detail = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
    const participants = detail.json().participants;
    expect(participants).toHaveLength(1);
    expect(participants[0].agentId).toBe(a1.agent.uuid);
  });

  it("rejects removing non-participant agent", async () => {
    const app = getApp();
    const { a1, a3, chatId } = await setupChat(app);

    const res = await a1.request("DELETE", `/api/v1/agent/chats/${chatId}/participants/${a3.agent.uuid}`);
    expect(res.statusCode).toBe(404);
  });

  it("rejects removing yourself", async () => {
    const app = getApp();
    const { a1, chatId } = await setupChat(app);

    const res = await a1.request("DELETE", `/api/v1/agent/chats/${chatId}/participants/${a1.agent.uuid}`);
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-participant adding someone", async () => {
    const app = getApp();
    const { a3, chatId } = await setupChat(app);

    const res = await a3.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {
      agentId: a3.agent.uuid,
    });
    expect(res.statusCode).toBe(403);
  });
});
