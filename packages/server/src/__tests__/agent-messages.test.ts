import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Messages API", () => {
  const getApp = useTestApp();

  async function setupChat(app: FastifyInstance) {
    const a1 = await createTestAgent(app, { name: `msg-a1-${crypto.randomUUID().slice(0, 6)}` });
    const a2 = await createTestAgent(app, { name: `msg-a2-${crypto.randomUUID().slice(0, 6)}` });

    const res = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chat = res.json();
    return { a1, a2, chatId: chat.id };
  }

  it("sends and retrieves messages", async () => {
    const app = getApp();
    const { a1, chatId } = await setupChat(app);

    const sendRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "Hello!",
    });
    expect(sendRes.statusCode).toBe(201);
    expect(sendRes.json().content).toBe("Hello!");

    const listRes = await a1.request("GET", `/api/v1/agent/chats/${chatId}/messages`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items).toHaveLength(1);
  });

  it("sends message with replyToInbox envelope", async () => {
    const app = getApp();
    const { a1, chatId } = await setupChat(app);

    const sendRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "Need approval",
      replyToInbox: a1.agent.inboxId,
    });
    expect(sendRes.statusCode).toBe(201);
    const msg = sendRes.json();
    expect(msg.replyToInbox).toBe(a1.agent.inboxId);
  });

  it("creates inbox entries for recipient (fan-out)", async () => {
    const app = getApp();
    const { a1, a2, chatId } = await setupChat(app);

    // Agent↔agent direct chat is mention_only on both ends (migration 0029)
    // so this fan-out test must include an explicit @ to wake the recipient
    // — without it, the entry would be a silent context row and `pollInbox`
    // would skip it.
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${a2.agent.name} Fan-out test`,
    });

    const pollRes = await a2.request("GET", "/api/v1/agent/inbox");
    expect(pollRes.statusCode).toBe(200);
    const entries = pollRes.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message.content).toContain("Fan-out test");
  });

  it("rejects message from non-participant", async () => {
    const app = getApp();
    const { chatId } = await setupChat(app);
    const outsider = await createTestAgent(app, { name: "outsider" });

    const res = await outsider.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "Intruder!",
    });
    expect(res.statusCode).toBe(403);
  });
});
