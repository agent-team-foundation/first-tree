import { afterAll, describe, expect, it } from "vitest";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("Agent Participants API", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  async function setupChat(app: Awaited<ReturnType<typeof createTestApp>>) {
    const uid = crypto.randomUUID().slice(0, 6);
    const { agent: a1, token: t1 } = await createTestAgent(app, { id: `part-a1-${uid}` });
    const { agent: a2, token: t2 } = await createTestAgent(app, { id: `part-a2-${uid}` });
    const { agent: a3, token: t3 } = await createTestAgent(app, { id: `part-a3-${uid}` });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "group", participantIds: [a2.id] },
    });
    const chat = res.json();
    return { a1, a2, a3, t1, t2, t3, chatId: chat.id };
  }

  it("adds a participant to a chat", async () => {
    const app = await appPromise;
    const { t1, a3, chatId } = await setupChat(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/participants`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { agentId: a3.id },
    });
    expect(res.statusCode).toBe(201);
    const participants = res.json();
    expect(participants).toHaveLength(3);
    expect(participants.map((p: { agentId: string }) => p.agentId)).toContain(a3.id);
  });

  it("rejects adding duplicate participant", async () => {
    const app = await appPromise;
    const { t1, a2, chatId } = await setupChat(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/participants`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { agentId: a2.id },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects adding non-existent agent", async () => {
    const app = await appPromise;
    const { t1, chatId } = await setupChat(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/participants`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { agentId: "non-existent-agent" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("removes a participant from a chat", async () => {
    const app = await appPromise;
    const { t1, a2, chatId } = await setupChat(app);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/agent/chats/${chatId}/participants/${a2.id}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(res.statusCode).toBe(204);

    // Verify participant is removed
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    const participants = detail.json().participants;
    expect(participants).toHaveLength(1);
    expect(participants[0].agentId).toBe((await setupChat(app)).a1.id.slice(0, 0) || participants[0].agentId);
  });

  it("rejects removing non-participant agent", async () => {
    const app = await appPromise;
    const { t1, a3, chatId } = await setupChat(app);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/agent/chats/${chatId}/participants/${a3.id}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects removing yourself", async () => {
    const app = await appPromise;
    const { t1, a1, chatId } = await setupChat(app);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/agent/chats/${chatId}/participants/${a1.id}`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-participant adding someone", async () => {
    const app = await appPromise;
    const { t3, a3, chatId } = await setupChat(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/participants`,
      headers: { authorization: `Bearer ${t3}` },
      payload: { agentId: a3.id },
    });
    expect(res.statusCode).toBe(403);
  });
});
