import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Messages API", () => {
  const getApp = useTestApp();

  async function setupChat(app: FastifyInstance) {
    const { agent: a1, token: t1 } = await createTestAgent(app, { name: `msg-a1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2, token: t2 } = await createTestAgent(app, { name: `msg-a2-${crypto.randomUUID().slice(0, 6)}` });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: [a2.uuid] },
    });
    const chat = res.json();
    return { a1, a2, t1, t2, chatId: chat.id };
  }

  it("sends and retrieves messages", async () => {
    const app = getApp();
    const { t1, chatId } = await setupChat(app);

    const sendRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Hello!" },
    });
    expect(sendRes.statusCode).toBe(201);
    expect(sendRes.json().content).toBe("Hello!");

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t1}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items).toHaveLength(1);
  });

  it("sends message with replyTo fields", async () => {
    const app = getApp();
    const { t1, a1, chatId } = await setupChat(app);

    const sendRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: {
        format: "text",
        content: "Need approval",
        replyToInbox: a1.inboxId,
        replyToChat: chatId,
      },
    });
    expect(sendRes.statusCode).toBe(201);
    const msg = sendRes.json();
    expect(msg.replyToInbox).toBe(a1.inboxId);
    expect(msg.replyToChat).toBe(chatId);
  });

  it("creates inbox entries for recipient (fan-out)", async () => {
    const app = getApp();
    const { t1, t2, chatId } = await setupChat(app);

    await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Fan-out test" },
    });

    // Recipient should have inbox entries
    const pollRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(pollRes.statusCode).toBe(200);
    const entries = pollRes.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message.content).toBe("Fan-out test");
  });

  it("rejects message from non-participant", async () => {
    const app = getApp();
    const { chatId } = await setupChat(app);
    const { token: outsider } = await createTestAgent(app, { name: "outsider" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${outsider}` },
      payload: { format: "text", content: "Intruder!" },
    });
    expect(res.statusCode).toBe(403);
  });
});
