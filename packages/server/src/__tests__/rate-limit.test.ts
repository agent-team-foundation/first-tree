import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
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

  it("applies the global user bucket to connect-code minting", async () => {
    const app = await createTestApp({ rateLimit: { max: 2 } });
    try {
      const admin = await createTestAdmin(app, { username: `rl-connect-${crypto.randomUUID().slice(0, 8)}` });
      const mintConnectCode = () =>
        app.inject({
          method: "POST",
          url: "/api/v1/me/connect-tokens",
          headers: { authorization: `Bearer ${admin.accessToken}` },
        });

      expect((await mintConnectCode()).statusCode).toBe(200);
      expect((await mintConnectCode()).statusCode).toBe(200);
      expect((await mintConnectCode()).statusCode).toBe(429);
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

  it("counts agent task chat creation in the agent actor bucket", async () => {
    const app = await createTestApp({ rateLimit: { max: 2 } });
    try {
      const uid = crypto.randomUUID().slice(0, 8);
      const sender = await createTestAgent(app, { name: `rl-create-${uid}-s` });
      const target = await createTestAgent(app, { name: `rl-create-${uid}-t` });

      const createTask = (topic: string) =>
        sender.request("POST", "/api/v1/agent/chats", {
          mode: "task",
          initialRecipientAgentIds: [target.agent.uuid],
          initialRecipientNames: [],
          contextParticipantAgentIds: [],
          contextParticipantNames: [],
          topic,
          initialMessage: { source: "cli", format: "text", content: "task handoff" },
        });

      expect((await createTask(`rl-create-ok-1-${uid}`)).statusCode).toBe(201);
      expect((await createTask(`rl-create-ok-2-${uid}`)).statusCode).toBe(201);

      const blockedTopic = `rl-create-blocked-${uid}`;
      expect((await createTask(blockedTopic)).statusCode).toBe(429);

      const leakedChats = await app.db.select({ id: chats.id }).from(chats).where(eq(chats.topic, blockedTopic));
      expect(leakedChats).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("keeps /healthz and /readyz exempt from the global limiter but not /api/v1/health", async () => {
    const app = await createTestApp({ rateLimit: { max: 2 } });
    try {
      // Exempt probes: far past `max` without a 429. `/readyz` may be 503
      // depending on bootstrap state shared across the worker, so only the
      // exemption (never 429) is asserted for it.
      for (let i = 0; i < 5; i++) {
        expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
        expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).not.toBe(429);
      }

      // Not exempt: `/api/v1/health` stays behind the global limiter.
      expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(429);
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
