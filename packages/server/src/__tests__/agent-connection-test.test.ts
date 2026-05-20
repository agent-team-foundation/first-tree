import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Health-only connection test. The endpoint reports WS-connection health
 * (connected / stale / offline) and never creates a chat or sends an LLM
 * round-trip message. The `connected` path needs a real WS connection to
 * register in connection-manager's in-memory map, so it is covered by E2E
 * suites that spawn an actual client process; these unit tests cover the
 * two paths reachable without a live socket.
 */
describe("POST /api/v1/agents/:uuid/test — health-only", () => {
  const getApp = useTestApp();

  async function countChatsAndMessages(app: FastifyInstance) {
    const allChats = await app.db.select({ id: chats.id }).from(chats);
    const allMessages = await app.db.select({ id: messages.id }).from(messages);
    return { chatCount: allChats.length, messageCount: allMessages.length };
  }

  it("returns status=offline when the agent has no presence row", async () => {
    const app = getApp();
    const { agent, request } = await createTestAgent(app, { name: "test-offline" });

    const before = await countChatsAndMessages(app);
    const res = await request("POST", `/api/v1/agents/${agent.uuid}/test`);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("offline");
    expect(body.connection.health).toBe("disconnected");
    expect(body.connection.client).toBeNull();

    const after = await countChatsAndMessages(app);
    expect(after.chatCount).toBe(before.chatCount);
    expect(after.messageCount).toBe(before.messageCount);
  });

  it("returns status=stale when presence.status=online but no live WS", async () => {
    const app = getApp();
    const { agent, clientId, request } = await createTestAgent(app, { name: "test-stale" });

    await app.db.insert(agentPresence).values({
      agentId: agent.uuid,
      status: "online",
      clientId,
      instanceId: "test-instance",
      connectedAt: new Date(),
      lastSeenAt: new Date(),
    });

    const before = await countChatsAndMessages(app);
    const res = await request("POST", `/api/v1/agents/${agent.uuid}/test`);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("stale");
    expect(body.connection.health).toBe("stale");
    expect(body.connection.client).not.toBeNull();
    expect(body.connection.client.id).toBe(clientId);

    const after = await countChatsAndMessages(app);
    expect(after.chatCount).toBe(before.chatCount);
    expect(after.messageCount).toBe(before.messageCount);
  });

  it("does not return chatId / responseContent / responseTime fields", async () => {
    const app = getApp();
    const { agent, request } = await createTestAgent(app, { name: "test-no-fields" });
    const res = await request("POST", `/api/v1/agents/${agent.uuid}/test`);
    const body = res.json();
    expect(body).not.toHaveProperty("chatId");
    expect(body).not.toHaveProperty("responseContent");
    expect(body).not.toHaveProperty("responseTime");
  });
});
