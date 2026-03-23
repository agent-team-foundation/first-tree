import { afterAll, describe, expect, it } from "vitest";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("Agent Chats API", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("creates a chat and retrieves it", async () => {
    const app = await appPromise;
    const { agent: a1, token: t1 } = await createTestAgent(app, { id: "chat-a1" });
    const { agent: a2 } = await createTestAgent(app, { id: "chat-a2" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: {
        type: "direct",
        participantIds: [a2.id],
        topic: "Test chat",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const chat = createRes.json();
    expect(chat.type).toBe("direct");
    expect(chat.participants).toHaveLength(2);
    expect(chat.participants.map((p: { agentId: string }) => p.agentId).sort()).toEqual([a1.id, a2.id].sort());

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chat.id}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(chat.id);
  });

  it("lists chats for an agent", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "list-a1" });
    const { agent: a2 } = await createTestAgent(app, { id: "list-a2" });

    await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: [a2.id] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects chat creation with non-existent participant", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "bad-a1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: ["non-existent"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects access to non-participant chat", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "deny-a1" });
    const { token: t2 } = await createTestAgent(app, { id: "deny-a2" });
    const { agent: a3 } = await createTestAgent(app, { id: "deny-a3" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t2}` },
      payload: { type: "direct", participantIds: [a3.id] },
    });
    const chatId = createRes.json().id;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
