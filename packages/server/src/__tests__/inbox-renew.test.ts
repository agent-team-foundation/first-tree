import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Inbox Renew & Timeout API", () => {
  const getApp = useTestApp();

  async function setupInboxEntry(app: FastifyInstance) {
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `renew-a1-${uid}` });
    const a2 = await createTestAgent(app, { name: `renew-a2-${uid}` });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "direct",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;

    // mention_only direct (migration 0029) — @a2 to wake the recipient.
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${a2.agent.name} Renew test`,
    });

    const pollRes = await a2.request("GET", "/api/v1/agent/inbox");
    const entries = pollRes.json();
    return { a2, entryId: entries[0].id };
  }

  it("renews a delivered inbox entry", async () => {
    const app = getApp();
    const { a2, entryId } = await setupInboxEntry(app);

    const res = await a2.request("POST", `/api/v1/agent/inbox/${entryId}/renew`);
    expect(res.statusCode).toBe(204);
  });

  it("rejects renewing a non-existent entry", async () => {
    const app = getApp();
    const { a2 } = await setupInboxEntry(app);

    const res = await a2.request("POST", "/api/v1/agent/inbox/999999/renew");
    expect(res.statusCode).toBe(404);
  });

  it("rejects renewing an already acked entry", async () => {
    const app = getApp();
    const { a2, entryId } = await setupInboxEntry(app);

    await a2.request("POST", `/api/v1/agent/inbox/${entryId}/ack`);

    const res = await a2.request("POST", `/api/v1/agent/inbox/${entryId}/renew`);
    expect(res.statusCode).toBe(404);
  });
});
