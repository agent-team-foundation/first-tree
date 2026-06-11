import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { agentRequest, createAdminContext, createTestAdmin, createTestAgent, createTestApp } from "./helpers.js";

describe("Rate limit", () => {
  it("keys authenticated user buckets by user id instead of IP", async () => {
    const app = await createTestApp({ rateLimit: { max: 2 } });
    try {
      const first = await createTestAdmin(app, { username: `rl-u1-${crypto.randomUUID().slice(0, 8)}` });
      const second = await createTestAdmin(app, { username: `rl-u2-${crypto.randomUUID().slice(0, 8)}` });

      const getMe = (accessToken: string) =>
        app.inject({
          method: "GET",
          url: "/api/v1/me",
          headers: { authorization: `Bearer ${accessToken}` },
        });

      expect((await getMe(first.accessToken)).statusCode).toBe(200);
      expect((await getMe(first.accessToken)).statusCode).toBe(200);
      expect((await getMe(first.accessToken)).statusCode).toBe(429);

      expect((await getMe(second.accessToken)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("keys agent runtime buckets by agent id before manager user id", async () => {
    const app = await createTestApp({ rateLimit: { max: 2 } });
    try {
      const admin = await createAdminContext(app, { username: `rl-manager-${crypto.randomUUID().slice(0, 8)}` });
      const firstAgent = await createAgent(app.db, {
        name: `rl-a1-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        displayName: "Rate Limit Agent 1",
        managerId: admin.memberId,
        clientId: admin.clientId,
      });
      const secondAgent = await createAgent(app.db, {
        name: `rl-a2-${crypto.randomUUID().slice(0, 8)}`,
        type: "agent",
        displayName: "Rate Limit Agent 2",
        managerId: admin.memberId,
        clientId: admin.clientId,
      });

      const firstRequest = agentRequest(app, admin.accessToken, firstAgent.uuid);
      const secondRequest = agentRequest(app, admin.accessToken, secondAgent.uuid);

      expect((await firstRequest("GET", "/api/v1/agent/me")).statusCode).toBe(200);
      expect((await firstRequest("GET", "/api/v1/agent/me")).statusCode).toBe(200);
      expect((await firstRequest("GET", "/api/v1/agent/me")).statusCode).toBe(429);

      expect((await secondRequest("GET", "/api/v1/agent/me")).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("falls back to IP for unauthenticated requests", async () => {
    const app = await createTestApp({ rateLimit: { max: 2 } });
    try {
      const attemptLogin = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { username: "missing", password: "wrong" },
        });

      expect((await attemptLogin()).statusCode).toBe(401);
      expect((await attemptLogin()).statusCode).toBe(401);
      expect((await attemptLogin()).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("does not apply the removed 30/min route cap to agent message writes", async () => {
    const app = await createTestApp({ rateLimit: { max: 40 } });
    try {
      const sender = await createTestAgent(app, { name: `rl-msg-${crypto.randomUUID().slice(0, 8)}-s` });
      const target = await createTestAgent(app, { name: `rl-msg-${crypto.randomUUID().slice(0, 8)}-t` });

      const chat = (
        await sender.request("POST", "/api/v1/agent/chats", {
          type: "group",
          participantIds: [target.agent.uuid],
        })
      ).json<{ id: string }>();

      for (let i = 1; i <= 31; i++) {
        const res = await sender.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
          format: "text",
          content: `@${target.agent.name} msg ${i}`,
          receiverNames: [target.agent.name],
        });
        expect(res.statusCode).toBe(201);
      }
    } finally {
      await app.close();
    }
  });

  it("does not apply the removed 6/min route cap to context snapshots", async () => {
    const app = await createTestApp({ rateLimit: { max: 10 } });
    try {
      const admin = await createTestAdmin(app, { username: `rl-context-${crypto.randomUUID().slice(0, 8)}` });

      for (let i = 1; i <= 7; i++) {
        const res = await app.inject({
          method: "GET",
          url: "/api/v1/context-tree/snapshot?window=1d",
          headers: { authorization: `Bearer ${admin.accessToken}` },
        });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
