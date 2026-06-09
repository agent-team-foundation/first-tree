import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Chats API", () => {
  const getApp = useTestApp();

  it("creates a chat and retrieves it", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: "chat-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "chat-a2" });

    const createRes = await a.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
      topic: "Test chat",
    });
    expect(createRes.statusCode).toBe(201);
    const chat = createRes.json();
    expect(chat.type).toBe("group");
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

    await a.request("POST", "/api/v1/agent/chats", { type: "group", participantIds: [a2.uuid] });

    const res = await a.request("GET", "/api/v1/agent/chats");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects chat creation with non-existent participant", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: "bad-a1" });

    const res = await a.request("POST", "/api/v1/agent/chats", {
      type: "group",
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
      type: "group",
      participantIds: [a3.uuid],
    });
    const chatId = createRes.json().id;

    const res = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
    expect(res.statusCode).toBe(403);
  });

  it("GET /chats/:id/participants returns agent names for mention resolution", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `parts-a1-${uid}`, displayName: "Alice" });
    const { agent: a2 } = await createTestAgent(app, { name: `parts-a2-${uid}`, displayName: "Bob" });

    const createRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
    });
    const chatId = createRes.json().id;

    const res = await a1.request("GET", `/api/v1/agent/chats/${chatId}/participants`);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{
      agentId: string;
      name: string | null;
      displayName: string | null;
      mode: string;
      type: string;
    }>;

    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.agentId, r]));
    expect(byId.get(a1.agent.uuid)?.name).toBe(`parts-a1-${uid}`);
    expect(byId.get(a2.uuid)?.displayName).toBe("Bob");
    for (const r of rows) {
      // Agent↔agent direct → both start in mention_only (migration 0029).
      expect(r.mode).toBe("mention_only");
      expect(r.type).toBe("agent");
    }
  });

  it("GET /chats/:id/participants rejects non-participants with 403", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `secret-a1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `secret-a2-${uid}` });
    const a3 = await createTestAgent(app, { name: `secret-a3-${uid}` });

    const createRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
    });
    const chatId = createRes.json().id;

    const res = await a3.request("GET", `/api/v1/agent/chats/${chatId}/participants`);
    expect(res.statusCode).toBe(403);
  });

  describe("PATCH /chats/:id (set topic / description)", () => {
    it("updates topic and persists; null clears", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `topic-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `topic-a2-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const setRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, { topic: "ship plan" });
      expect(setRes.statusCode).toBe(200);
      expect(setRes.json().topic).toBe("ship plan");

      const detailRes = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
      expect(detailRes.json().topic).toBe("ship plan");

      const clearRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, { topic: null });
      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.json().topic).toBeNull();
    });

    it("updates description and persists; null clears", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `desc-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `desc-a2-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const setRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, {
        description: "reviewing PR #42; CI green; awaiting approval",
      });
      expect(setRes.statusCode).toBe(200);
      expect(setRes.json().description).toBe("reviewing PR #42; CI green; awaiting approval");

      const detailRes = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
      expect(detailRes.json().description).toBe("reviewing PR #42; CI green; awaiting approval");

      const clearRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, { description: null });
      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.json().description).toBeNull();
    });

    it("updates topic and description together; a single-field update leaves the other untouched", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `both-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `both-a2-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const bothRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, {
        topic: "ship plan",
        description: "drafting the rollout steps",
      });
      expect(bothRes.statusCode).toBe(200);
      expect(bothRes.json().topic).toBe("ship plan");
      expect(bothRes.json().description).toBe("drafting the rollout steps");

      // Updating only the description must not clobber the existing topic.
      const descOnlyRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, {
        description: "rollout steps reviewed",
      });
      expect(descOnlyRes.statusCode).toBe(200);
      expect(descOnlyRes.json().topic).toBe("ship plan");
      expect(descOnlyRes.json().description).toBe("rollout steps reviewed");
    });

    it("rejects non-participants with 403", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `topic-deny-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `topic-deny-a2-${uid}` });
      const a3 = await createTestAgent(app, { name: `topic-deny-a3-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const res = await a3.request("PATCH", `/api/v1/agent/chats/${chatId}`, { topic: "intrusion" });
      expect(res.statusCode).toBe(403);
    });

    it("rejects empty body (no topic or description)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `topic-bad-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `topic-bad-a2-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const res = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, {});
      expect(res.statusCode).toBe(400);
    });
  });
});
