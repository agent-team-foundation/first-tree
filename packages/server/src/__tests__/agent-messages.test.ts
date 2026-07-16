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

  it("rejects browser-only campaign action context on the agent task-chat endpoint", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: `action-a1-${crypto.randomUUID().slice(0, 6)}` });
    const a2 = await createTestAgent(app, { name: `action-a2-${crypto.randomUUID().slice(0, 6)}` });

    const response = await a1.request("POST", "/api/v1/agent/chats", {
      mode: "task",
      initialRecipientAgentIds: [a2.agent.uuid],
      campaignAction: { campaign: "production-scan", repoSlug: "acme/app" },
      initialMessage: { format: "text", content: "Start the campaign action.", source: "agent" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("sends and retrieves messages", async () => {
    const app = getApp();
    const { a1, a2, chatId } = await setupChat(app);

    const sendRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "Hello!",
      // Agent endpoint enforces explicit routing — declare the peer's uuid.
      metadata: { mentions: [a2.agent.uuid] },
    });
    expect(sendRes.statusCode).toBe(201);
    // normalizeMentionsInContent on the agent endpoint prepends @<name>
    // since the agent's bare "Hello!" didn't include the mention.
    expect(sendRes.json().content).toBe(`@${a2.agent.name} Hello!`);

    const listRes = await a1.request("GET", `/api/v1/agent/chats/${chatId}/messages`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items).toHaveLength(1);
  });

  it("edits a message for a chat participant", async () => {
    const app = getApp();
    const { a1, a2, chatId } = await setupChat(app);

    const sendRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "Original",
      metadata: { mentions: [a2.agent.uuid] },
    });
    expect(sendRes.statusCode).toBe(201);

    const editRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}/messages/${sendRes.json().id}`, {
      format: "text",
      content: "Edited",
    });
    expect(editRes.statusCode).toBe(200);
    expect(editRes.json().content).toBe("Edited");
    expect(editRes.json().createdAt).toEqual(expect.any(String));
  });

  it("rejects agent edits that would persist escaped multiline markdown", async () => {
    const app = getApp();
    const { a1, a2, chatId } = await setupChat(app);

    const sendRes = await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "markdown",
      content: "Original",
      metadata: { mentions: [a2.agent.uuid] },
    });
    expect(sendRes.statusCode).toBe(201);

    const editRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}/messages/${sendRes.json().id}`, {
      format: "markdown",
      content: "line1\\n\\nline2\\n\\nline3",
    });
    expect(editRes.statusCode).toBe(400);

    const listRes = await a1.request("GET", `/api/v1/agent/chats/${chatId}/messages`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items[0].content).toBe(`@${a2.agent.name} Original`);
  });

  it("creates inbox entries for recipient (fan-out)", async () => {
    const app = getApp();
    const { a1, a2, chatId } = await setupChat(app);

    // Agent endpoint enforces explicit routing — declare the peer via
    // either `metadata.mentions` (uuid) or `receiverNames` (name); CLI
    // uses receiverNames so use that here.
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "Fan-out test",
      receiverNames: [a2.agent.name],
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
