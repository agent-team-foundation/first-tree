import { afterAll, describe, expect, it } from "vitest";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("Inbox Renew & Timeout API", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  async function setupInboxEntry(app: Awaited<ReturnType<typeof createTestApp>>) {
    const uid = crypto.randomUUID().slice(0, 6);
    const { token: t1 } = await createTestAgent(app, { name: `renew-a1-${uid}` });
    const { agent: a2, token: t2 } = await createTestAgent(app, { name: `renew-a2-${uid}` });

    // Create chat and send message
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: [a2.uuid] },
    });
    const chatId = chatRes.json().id;

    await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Renew test" },
    });

    // Poll to get delivered entry
    const pollRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    const entries = pollRes.json();
    return { t2, entryId: entries[0].id };
  }

  it("renews a delivered inbox entry", async () => {
    const app = await appPromise;
    const { t2, entryId } = await setupInboxEntry(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/inbox/${entryId}/renew`,
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it("rejects renewing a non-existent entry", async () => {
    const app = await appPromise;
    const { t2 } = await setupInboxEntry(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/inbox/999999/renew",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects renewing an already acked entry", async () => {
    const app = await appPromise;
    const { t2, entryId } = await setupInboxEntry(app);

    // ACK first
    await app.inject({
      method: "POST",
      url: `/api/v1/agent/inbox/${entryId}/ack`,
      headers: { authorization: `Bearer ${t2}` },
    });

    // Try to renew
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent/inbox/${entryId}/renew`,
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
