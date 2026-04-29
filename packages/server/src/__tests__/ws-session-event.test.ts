import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import * as notificationService from "../services/notification.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import * as sessionEventService from "../services/session-event.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * S10 (NC2 backend) — WS protocol end-to-end.
 *
 * Exercises the full client-to-server flow:
 *   1. `session:event` WS frame ⇒ row lands in `session_events`.
 *   2. `session:completion` WS frame ⇒ `session_completed` notification
 *      is created (5-min cooldown applies on the same chat).
 *   3. `session:state { state: "evicted" }` WS frame ⇒ persisted events
 *      for that (agent, chat) are cleared (D4 eviction hook).
 *
 * All three behaviors were previously wired to `session:output` and
 * `sessionOutputService`; this test protects the new protocol from
 * regression without booting a real Claude Code session.
 */
describe("Agent WS — session event protocol (S10)", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signMemberJwt(
    userId: string,
    memberId: string,
    organizationId: string,
    role: string,
  ): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: userId,
      memberId,
      organizationId,
      role,
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  async function seedBoundAgent(suffix: string) {
    const orgId = await resolveDefaultOrgId(app.db);
    const userId = uuidv7();
    const memberId = uuidv7();
    const clientId = `cli-evt-${suffix}-${crypto.randomUUID().slice(0, 6)}`;
    const role = "admin";

    const agent = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `evt-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: `Evt User ${suffix}`,
      });

      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `evt-human-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: `Evt Human ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
      });

      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId: orgId,
        agentId: humanAgent.uuid,
        role,
      });

      await tx.insert(clients).values({
        id: clientId,
        userId,
        organizationId: orgId,
        status: "connected",
      });

      return createAgent(tx as unknown as typeof app.db, {
        name: `evt-agent-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: `Evt Agent ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        clientId,
        organizationId: orgId,
      });
    });

    const token = await signMemberJwt(userId, memberId, orgId, role);
    return { agent, token, clientId, organizationId: orgId, memberId };
  }

  function waitForFrame(ws: WebSocket, match: (m: unknown) => boolean, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (match(msg)) {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(msg);
          }
        } catch {
          // ignore non-JSON
        }
      };
      ws.on("message", onMessage);
    });
  }

  async function openBoundSocket(seed: Awaited<ReturnType<typeof seedBoundAgent>>): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "auth", token: seed.token }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok");

    ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "client:registered");

    ws.send(
      JSON.stringify({
        type: "agent:bind",
        agentId: seed.agent.uuid,
        ref: "bind-1",
        // Match the seeded agent's `runtime_provider` (defaults to claude-code)
        // so the post-0026 RUNTIME_PROVIDER_MISMATCH check passes.
        runtimeType: "claude-code",
        runtimeVersion: "0.0.0",
      }),
    );
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:bound");

    return ws;
  }

  async function waitForCondition<T>(fn: () => Promise<T | null>, timeoutMs = 3000, stepMs = 50): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value !== null && value !== undefined) return value;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("persists a `session:event` frame into session_events", async () => {
    const seed = await seedBoundAgent("persist");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: seed.agent.uuid,
          chatId,
          event: {
            kind: "tool_call",
            payload: {
              toolUseId: "tu-42",
              name: "Bash",
              args: { command: "ls" },
              status: "ok",
              durationMs: 15,
              resultPreview: "a b c",
            },
          },
        }),
      );

      const listed = await waitForCondition(async () => {
        const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
        return items.length > 0 ? items : null;
      });

      expect(listed).toHaveLength(1);
      const ev = listed[0];
      if (!ev) throw new Error("expected event");
      expect(ev.kind).toBe("tool_call");
      expect(ev.seq).toBe(1);
      const payload = ev.payload as { toolUseId: string; name: string; status: string; durationMs?: number };
      expect(payload.toolUseId).toBe("tu-42");
      expect(payload.name).toBe("Bash");
      expect(payload.status).toBe("ok");
      expect(payload.durationMs).toBe(15);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("rejects an `evicted` session:state frame from a stale client and preserves events", async () => {
    const seed = await seedBoundAgent("evict");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      await sessionEventService.appendEvent(app.db, seed.agent.uuid, chatId, {
        kind: "error",
        payload: { source: "sdk", message: "before stale evicted frame" },
      });
      await sessionEventService.appendEvent(app.db, seed.agent.uuid, chatId, {
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Read", args: {}, status: "ok" },
      });

      const errorMessages: string[] = [];
      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString()) as { type?: string; message?: string };
          if (parsed.type === "error" && parsed.message) errorMessages.push(parsed.message);
        } catch {
          // ignore
        }
      });

      ws.send(
        JSON.stringify({
          type: "session:state",
          agentId: seed.agent.uuid,
          chatId,
          state: "evicted",
        }),
      );

      await waitForCondition(async () => {
        return errorMessages.some((m) => m.includes("Unsupported session state")) ? true : null;
      });

      // Events were NOT cleared — the stale frame produces an error, not a side effect.
      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
      expect(items).toHaveLength(2);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("keeps events when `session:state` moves to 'suspended'", async () => {
    const seed = await seedBoundAgent("suspend");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      await sessionEventService.appendEvent(app.db, seed.agent.uuid, chatId, {
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Read", args: {}, status: "ok" },
      });

      ws.send(
        JSON.stringify({
          type: "session:state",
          agentId: seed.agent.uuid,
          chatId,
          state: "suspended",
        }),
      );

      // Wait a beat for any (incorrect) cleanup to fire, then assert row is still there.
      await new Promise((r) => setTimeout(r, 300));
      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 10 });
      expect(items).toHaveLength(1);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("rejected `evicted` frame following session:event does not disturb persisted events", async () => {
    const seed = await seedBoundAgent("race");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      const eventCount = 5;
      for (let i = 0; i < eventCount; i += 1) {
        ws.send(
          JSON.stringify({
            type: "session:event",
            agentId: seed.agent.uuid,
            chatId,
            event: {
              kind: "tool_call",
              payload: { toolUseId: `tu-${i}`, name: "Bash", args: { i }, status: "ok", durationMs: 1 },
            },
          }),
        );
      }
      ws.send(
        JSON.stringify({
          type: "session:state",
          agentId: seed.agent.uuid,
          chatId,
          state: "evicted",
        }),
      );

      // Give the server time to persist the events and reject the stale frame.
      await new Promise((r) => setTimeout(r, 800));

      const { items } = await sessionEventService.listEvents(app.db, seed.agent.uuid, chatId, { limit: 50 });
      expect(items).toHaveLength(eventCount);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("`session:completion` creates a session_completed notification", async () => {
    const seed = await seedBoundAgent("compl");
    const ws = await openBoundSocket(seed);
    const chatId = `chat-${crypto.randomUUID()}`;

    try {
      ws.send(
        JSON.stringify({
          type: "session:completion",
          agentId: seed.agent.uuid,
          chatId,
        }),
      );

      const hit = await waitForCondition(async () => {
        const { items } = await notificationService.listNotifications(app.db, seed.organizationId, seed.memberId, {
          limit: 50,
        });
        const found = items.find(
          (n) => n.type === "session_completed" && n.agentId === seed.agent.uuid && n.chatId === chatId,
        );
        return found ?? null;
      });

      expect(hit.type).toBe("session_completed");
      expect(hit.severity).toBe("low");
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("`session:reconcile` returns staleChatIds for evicted or missing rows", async () => {
    const seed = await seedBoundAgent("recon");
    const ws = await openBoundSocket(seed);

    try {
      const { agentChatSessions: table } = await import("../db/schema/agent-chat-sessions.js");
      const { chats: chatsTable } = await import("../db/schema/chats.js");

      const activeId = `chat-active-${crypto.randomUUID()}`;
      const suspendedId = `chat-suspended-${crypto.randomUUID()}`;
      const evictedId = `chat-evicted-${crypto.randomUUID()}`;
      const missingId = `chat-missing-${crypto.randomUUID()}`;

      await app.db
        .insert(chatsTable)
        .values([
          { id: activeId, organizationId: seed.organizationId },
          { id: suspendedId, organizationId: seed.organizationId },
          { id: evictedId, organizationId: seed.organizationId },
        ])
        .onConflictDoNothing();
      await app.db
        .insert(table)
        .values([
          { agentId: seed.agent.uuid, chatId: activeId, state: "active" },
          { agentId: seed.agent.uuid, chatId: suspendedId, state: "suspended" },
          { agentId: seed.agent.uuid, chatId: evictedId, state: "evicted" },
        ])
        .onConflictDoNothing();

      ws.send(
        JSON.stringify({
          type: "session:reconcile",
          agentId: seed.agent.uuid,
          chatIds: [activeId, suspendedId, evictedId, missingId],
        }),
      );

      const result = (await waitForFrame(ws, (m) => (m as { type?: string }).type === "session:reconcile:result")) as {
        staleChatIds: string[];
        agentId: string;
      };

      expect(result.agentId).toBe(seed.agent.uuid);
      expect(new Set(result.staleChatIds)).toEqual(new Set([evictedId, missingId]));
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);
});
