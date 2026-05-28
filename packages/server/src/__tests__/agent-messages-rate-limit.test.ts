import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Regression tests for the per-agent rate limit on outbound message writes.
 *
 * The first test asserts the basic ceiling. The second asserts the bucket key
 * is `agent:${uuid}` and not `ip:${req.ip}` — if a future hook-order
 * regression makes `req.agent` undefined inside the keyGenerator, the
 * fallback path keys by IP, which under `fastify.inject` collapses every
 * caller to loopback and would silently degrade the limiter to a global cap.
 * This is exactly the failure mode flagged in
 * `proposals/hub-rate-limit-design.20260506.md` §2.5.
 */
describe("Agent Messages — per-agent rate limit", () => {
  const getApp = useTestApp({ rateLimit: { agentMessageMax: 2 } });

  it("returns 429 once a single agent exceeds agentMessageMax/min", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `rl-${crypto.randomUUID().slice(0, 6)}-s` });
    const target = await createTestAgent(app, { name: `rl-${crypto.randomUUID().slice(0, 6)}-t` });

    const chat = (
      await sender.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [target.agent.uuid],
      })
    ).json();

    const send = (i: number) =>
      sender.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
        format: "text",
        content: `@${target.agent.name} msg ${i}`,
        receiverNames: [target.agent.name],
      });

    expect((await send(1)).statusCode).toBe(201);
    expect((await send(2)).statusCode).toBe(201);
    expect((await send(3)).statusCode).toBe(429);
  });

  it("buckets are per-agent, not per-IP / global", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: `iso-${crypto.randomUUID().slice(0, 6)}-a1` });
    const a3 = await createTestAgent(app, { name: `iso-${crypto.randomUUID().slice(0, 6)}-a3` });
    const target = await createTestAgent(app, { name: `iso-${crypto.randomUUID().slice(0, 6)}-t` });

    const chat1 = (
      await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [target.agent.uuid],
      })
    ).json();
    const chat3 = (
      await a3.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [target.agent.uuid],
      })
    ).json();

    // a1 burns through its 2-msg quota.
    expect(
      (
        await a1.request("POST", `/api/v1/agent/chats/${chat1.id}/messages`, {
          format: "text",
          content: `@${target.agent.name} 1`,
          receiverNames: [target.agent.name],
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await a1.request("POST", `/api/v1/agent/chats/${chat1.id}/messages`, {
          format: "text",
          content: `@${target.agent.name} 2`,
          receiverNames: [target.agent.name],
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await a1.request("POST", `/api/v1/agent/chats/${chat1.id}/messages`, {
          format: "text",
          content: `@${target.agent.name} 3`,
          receiverNames: [target.agent.name],
        })
      ).statusCode,
    ).toBe(429);

    // a3 still has full quota — proves the bucket key is agent.uuid, not ip.
    // Inside fastify.inject every request shares loopback as req.ip; if the
    // keyGenerator silently fell back to ip, this assertion would flip to 429.
    expect(
      (
        await a3.request("POST", `/api/v1/agent/chats/${chat3.id}/messages`, {
          format: "text",
          content: `@${target.agent.name} 1`,
          receiverNames: [target.agent.name],
        })
      ).statusCode,
    ).toBe(201);
  });
});
