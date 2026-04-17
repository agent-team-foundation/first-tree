import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Chats API", () => {
  const getApp = useTestApp();

  it("creates a chat and retrieves it", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: "chat-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "chat-a2" });

    const createRes = await a.request("POST", "/api/v1/agent/chats", {
      type: "direct",
      participantIds: [a2.uuid],
      topic: "Test chat",
    });
    expect(createRes.statusCode).toBe(201);
    const chat = createRes.json();
    expect(chat.type).toBe("direct");
    expect(chat.participants).toHaveLength(2);
    expect(chat.participants.map((p: { agentId: string }) => p.agentId).sort()).toEqual([a.agent.uuid, a2.uuid].sort());

    const getRes = await a.request("GET", `/api/v1/agent/chats/${chat.id}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(chat.id);
  });

  it("lists chats for an agent", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: "list-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "list-a2" });

    await a.request("POST", "/api/v1/agent/chats", { type: "direct", participantIds: [a2.uuid] });

    const res = await a.request("GET", "/api/v1/agent/chats");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects chat creation with non-existent participant", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: "bad-a1" });

    const res = await a.request("POST", "/api/v1/agent/chats", {
      type: "direct",
      participantIds: ["non-existent"],
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects access to non-participant chat", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "deny-a1" });
    const a2 = await createTestAgent(app, { name: "deny-a2" });
    const { agent: a3 } = await createTestAgent(app, { name: "deny-a3" });

    const createRes = await a2.request("POST", "/api/v1/agent/chats", {
      type: "direct",
      participantIds: [a3.uuid],
    });
    const chatId = createRes.json().id;

    const res = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
    expect(res.statusCode).toBe(403);
  });
});
