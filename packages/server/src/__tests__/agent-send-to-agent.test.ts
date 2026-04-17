import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Send-to-Agent API", () => {
  const getApp = useTestApp();

  it("sends a message to another agent (auto-creates direct chat)", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "sta-a1" });
    const a2 = await createTestAgent(app, { name: "sta-a2" });

    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.agent.name}/messages`, {
      format: "text",
      content: "Hello agent!",
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.content).toBe("Hello agent!");
    expect(msg.chatId).toBeDefined();

    const pollRes = await a2.request("GET", "/api/v1/agent/inbox");
    expect(pollRes.statusCode).toBe(200);
    const entries = pollRes.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message.content).toBe("Hello agent!");
  });

  it("reuses existing direct chat for same pair", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "reuse-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "reuse-a2" });

    const res1 = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "First message",
    });
    const chatId1 = res1.json().chatId;

    const res2 = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "Second message",
    });
    const chatId2 = res2.json().chatId;

    expect(chatId1).toBe(chatId2);
  });

  it("rejects sending to non-existent agent", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "noagent-a1" });

    const res = await a1.request("POST", "/api/v1/agent/agents/non-existent/messages", {
      format: "text",
      content: "Hello?",
    });
    expect(res.statusCode).toBe(404);
  });

  it("sends with replyTo fields", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "reply-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "reply-a2" });

    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "Need approval",
      replyToInbox: a1.agent.inboxId,
      replyToChat: "some-chat-id",
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.replyToInbox).toBe(a1.agent.inboxId);
    expect(msg.replyToChat).toBe("some-chat-id");
  });
});
