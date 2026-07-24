import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import * as memberService from "../services/member.js";
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

  it("adds an active human by name without writing a message, then allows addressed delivery", async () => {
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

    const userChatRes = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatId}`,
      headers: { authorization: `Bearer ${human.accessToken}` },
    });
    expect(userChatRes.statusCode).toBe(200);

    const historyBeforeSend = await human.request("GET", `/api/v1/agent/chats/${chatId}/messages`);
    expect(historyBeforeSend.statusCode).toBe(200);
    expect(historyBeforeSend.json().items).toHaveLength(0);
    const inboxBeforeSend = await human.request("GET", "/api/v1/agent/inbox");
    expect(inboxBeforeSend.statusCode).toBe(200);
    expect(inboxBeforeSend.json()).toHaveLength(0);

    const sendRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "Human participant delivery",
      receiverNames: [human.agent.name],
    });
    expect(sendRes.statusCode).toBe(201);

    const inboxRes = await human.request("GET", "/api/v1/agent/inbox");
    expect(inboxRes.statusCode).toBe(200);
    expect(
      inboxRes
        .json()
        .some((entry: { message: { content: string } }) =>
          entry.message.content.includes("Human participant delivery"),
        ),
    ).toBe(true);
  });

  it("rejects a removed human by name through the agent invite path", async () => {
    const app = getApp();
    const { a1, chatId } = await setupChat(app);
    const human = await createTestAgent(app, {
      type: "human",
      name: `part-removed-${crypto.randomUUID().slice(0, 6)}`,
    });
    if (!human.agent.name) throw new Error("removed human participant name missing");
    await memberService.deleteMember(app.db, human.memberId, human.organizationId);

    const res = await a1.request("POST", `/api/v1/agent/chats/${chatId}/participants`, {
      agentName: human.agent.name,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("Inactive participant");
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
