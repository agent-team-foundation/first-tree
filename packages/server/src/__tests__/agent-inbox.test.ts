import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Inbox API", () => {
  const getApp = useTestApp();

  it("polls inbox; first poll claims pending entries, subsequent poll is empty", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "inbox-a1" });
    const a2 = await createTestAgent(app, { name: "inbox-a2" });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;

    // Agent↔agent direct seeds both as mention_only (migration 0029); add
    // the @ so the recipient is woken rather than silently parked.
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${a2.agent.name} Inbox test`,
    });

    const pollRes = await a2.request("GET", "/api/v1/agent/inbox");
    expect(pollRes.statusCode).toBe(200);
    const entries = pollRes.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // GET /inbox claims pending entries (`pending → delivered`), so a follow-up
    // poll without a WS-path ack returns 0 — the entries are in flight.
    const pollRes2 = await a2.request("GET", "/api/v1/agent/inbox");
    expect(pollRes2.json()).toHaveLength(0);
  });

  it("rejects unauthenticated inbox access", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/agent/inbox" });
    expect(res.statusCode).toBe(401);
  });
});
