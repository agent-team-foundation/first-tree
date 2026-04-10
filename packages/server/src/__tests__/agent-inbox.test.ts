import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Inbox API", () => {
  const getApp = useTestApp();

  it("polls inbox and acks entry", async () => {
    const app = getApp();
    const { token: t1 } = await createTestAgent(app, { name: "inbox-a1" });
    const { agent: a2, token: t2 } = await createTestAgent(app, { name: "inbox-a2" });

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
      payload: { format: "text", content: "Inbox test" },
    });

    // Poll inbox as recipient
    const pollRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(pollRes.statusCode).toBe(200);
    const entries = pollRes.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entryId = entries[0].id;

    // ACK the entry
    const ackRes = await app.inject({
      method: "POST",
      url: `/api/v1/agent/inbox/${entryId}/ack`,
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(ackRes.statusCode).toBe(204);

    // Poll again — should be empty
    const pollRes2 = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(pollRes2.json()).toHaveLength(0);
  });

  it("rejects unauthenticated inbox access", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/agent/inbox" });
    expect(res.statusCode).toBe(401);
  });
});
