import { afterAll, describe, expect, it } from "vitest";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("Agent Send-to-Agent API", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("sends a message to another agent (auto-creates direct chat)", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "sta-a1" });
    const { agent: a2, token: t2 } = await createTestAgent(app, { id: "sta-a2" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.id}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Hello agent!" },
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.content).toBe("Hello agent!");
    expect(msg.chatId).toBeDefined();

    // Recipient should see the message in inbox
    const pollRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(pollRes.statusCode).toBe(200);
    const entries = pollRes.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message.content).toBe("Hello agent!");
  });

  it("reuses existing direct chat for same pair", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "reuse-a1" });
    const { agent: a2 } = await createTestAgent(app, { id: "reuse-a2" });

    const res1 = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.id}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "First message" },
    });
    const chatId1 = res1.json().chatId;

    const res2 = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.id}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Second message" },
    });
    const chatId2 = res2.json().chatId;

    expect(chatId1).toBe(chatId2);
  });

  it("rejects sending to non-existent agent", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "noagent-a1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/agents/non-existent/messages",
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Hello?" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("sends with replyTo fields", async () => {
    const app = await appPromise;
    const { agent: a1, token: t1 } = await createTestAgent(app, { id: "reply-a1" });
    const { agent: a2 } = await createTestAgent(app, { id: "reply-a2" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/agents/${a2.id}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: {
        format: "text",
        content: "Need approval",
        replyToInbox: a1.inboxId,
        replyToChat: "some-chat-id",
      },
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.replyToInbox).toBe(a1.inboxId);
    expect(msg.replyToChat).toBe("some-chat-id");
  });
});
