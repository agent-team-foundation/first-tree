import { RUNTIME_STALE_MS } from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { getChatAgentStatuses } from "../services/agent-chat-status.js";
import { createMeChat, deriveWorkingAgents } from "../services/me-chat.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * WS frame-level harness for the per-chat D-axis runtime ("working but shows
 * idle" fix). Drives the FULL real pipeline — agent WS frame → ws-client handler
 * → chainSessionOp → activity.setSessionRuntime → DB + notifier → org WS
 * broadcast — against a real Fastify server + real Postgres (testcontainers),
 * WITHOUT a real LLM. It simulates exactly the frames a real runtime emits.
 *
 * Coverage vs the 5 manual cases:
 *   1. long-working freshness + ~20s re-affirm (simulated by re-sending the
 *      working frame; staleness simulated by ageing `runtime_state_at`);
 *   2. codex "working with zero session_events";
 *   3. #366 — per-chat isolation;
 *   4. reconnect re-asserts working / disconnect → offline;
 *   5. org WS realtime delivery + the same-value notify rules.
 *
 * NOT covered here (covered by code review + client unit tests): the client
 * runtime actually deciding to emit these frames (handler emit cadence, codex
 * no-event behavior, the SessionManager re-affirm timer, fullStateSync).
 */
describe("Agent WS — per-chat runtime (D-axis) pipeline harness", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  let orgWsBase: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signMemberJwt(
    userId: string,
    memberId: string,
    organizationId: string,
    role: string,
  ): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: userId, memberId, organizationId, role, type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  async function seedBoundAgent(suffix: string) {
    const orgId = await resolveDefaultOrgId(app.db);
    const userId = uuidv7();
    const memberId = uuidv7();
    const clientId = `cli-rt-${suffix}-${crypto.randomUUID().slice(0, 6)}`;
    const role = "admin";

    const { agent, humanAgentUuid } = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `rt-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: `RT User ${suffix}`,
      });
      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `rt-human-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: `RT Human ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
      });
      await tx.insert(members).values({ id: memberId, userId, organizationId: orgId, agentId: humanAgent.uuid, role });
      await tx.insert(clients).values({ id: clientId, userId, organizationId: orgId, status: "connected" });
      const a = await createAgent(tx as unknown as typeof app.db, {
        name: `rt-agent-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: `RT Agent ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        clientId,
        organizationId: orgId,
      });
      return { agent: a, humanAgentUuid: humanAgent.uuid };
    });

    const token = await signMemberJwt(userId, memberId, orgId, role);
    return { agent, humanAgentUuid, token, clientId, organizationId: orgId };
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

  async function waitForCondition<T>(fn: () => Promise<T | null>, timeoutMs = 4000, stepMs = 50): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value !== null && value !== undefined) return value;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
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
        runtimeType: "claude-code",
        runtimeVersion: "0.0.0",
      }),
    );
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:bound");
    return ws;
  }

  async function closeSocket(ws: WebSocket): Promise<void> {
    ws.close();
    await new Promise<void>((r) => ws.once("close", () => r()));
  }

  /** Create a chat the agent speaks in, then drive `session:state active` so the
   *  agent_chat_sessions row exists and is active. */
  async function activeChat(seed: Awaited<ReturnType<typeof seedBoundAgent>>, ws: WebSocket): Promise<string> {
    const { chatId } = await createMeChat(app.db, seed.humanAgentUuid, seed.organizationId, {
      participantIds: [seed.agent.uuid],
    });
    ws.send(JSON.stringify({ type: "session:state", agentId: seed.agent.uuid, chatId, state: "active" }));
    await waitForCondition(async () => {
      const [row] = await app.db
        .select({ state: agentChatSessions.state })
        .from(agentChatSessions)
        .where(and(eq(agentChatSessions.agentId, seed.agent.uuid), eq(agentChatSessions.chatId, chatId)))
        .limit(1);
      return row?.state === "active" ? true : null;
    });
    return chatId;
  }

  function sendRuntime(ws: WebSocket, agentId: string, chatId: string, runtimeState: string): void {
    ws.send(JSON.stringify({ type: "session:runtime", agentId, chatId, runtimeState }));
  }

  /** Age `runtime_state_at` into the past to simulate "no re-affirm landed". */
  async function ageRuntimeStamp(agentId: string, chatId: string, ageMs: number): Promise<void> {
    await app.db.execute(sql`
      UPDATE agent_chat_sessions SET runtime_state_at = NOW() - make_interval(secs => ${ageMs} / 1000.0)
       WHERE agent_id = ${agentId} AND chat_id = ${chatId}
    `);
  }

  async function statusOf(chatId: string, agentId: string) {
    const all = await getChatAgentStatuses(app.db, chatId);
    return all.find((s) => s.agentId === agentId);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
    orgWsBase = `ws://127.0.0.1:${addr.port}/api/v1/orgs`;
  });

  afterAll(async () => {
    await app?.close();
  });

  // Case 2 (headline): codex emits NO intermediate session_events, only the
  // per-chat runtime. v1's event-proxy showed idle the whole turn; v2 is working.
  it("case 2 — `session:runtime=working` with ZERO session_events still reads working", async () => {
    const seed = await seedBoundAgent("codex");
    const ws = await openBoundSocket(seed);
    try {
      const chatId = await activeChat(seed, ws);
      sendRuntime(ws, seed.agent.uuid, chatId, "working");

      const s = await waitForCondition(async () => {
        const st = await statusOf(chatId, seed.agent.uuid);
        return st?.working === true ? st : null;
      });
      expect(s.main).toBe("working");
      expect(s.activity).toBeNull(); // no event → no detail, but authoritatively working

      const busy = await deriveWorkingAgents(app.db, [chatId]);
      expect(busy.get(chatId)).toEqual([seed.agent.uuid]);

      const [eventCount] = await app.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM session_events WHERE agent_id = ${seed.agent.uuid} AND chat_id = ${chatId}`,
      );
      expect(eventCount?.n).toBe(0);
    } finally {
      await closeSocket(ws);
    }
  }, 20000);

  // Case 1: a long turn with no new events stays working as long as the runtime
  // is re-affirmed; once re-affirm stops and the stamp ages past TTL → idle; a
  // fresh re-affirm brings it back — all without any session_events.
  it("case 1 — freshness window: stale (no re-affirm) → idle; re-affirm → working again", async () => {
    const seed = await seedBoundAgent("fresh");
    const ws = await openBoundSocket(seed);
    try {
      const chatId = await activeChat(seed, ws);
      sendRuntime(ws, seed.agent.uuid, chatId, "working");
      await waitForCondition(async () => ((await statusOf(chatId, seed.agent.uuid))?.working ? true : null));

      // Simulate "no re-affirm landed for > TTL".
      await ageRuntimeStamp(seed.agent.uuid, chatId, RUNTIME_STALE_MS + 10_000);
      expect((await statusOf(chatId, seed.agent.uuid))?.working).toBe(false);
      expect((await statusOf(chatId, seed.agent.uuid))?.main).toBe("ready");

      // A re-affirm (same value) refreshes the stamp → working again.
      sendRuntime(ws, seed.agent.uuid, chatId, "working");
      const back = await waitForCondition(async () => {
        const st = await statusOf(chatId, seed.agent.uuid);
        return st?.working === true ? st : null;
      });
      expect(back.main).toBe("working");
    } finally {
      await closeSocket(ws);
    }
  }, 20000);

  // Case 3: #366 — working in chat A must not light chat B.
  it("case 3 — #366: working in chat A leaves chat B idle (per-chat isolation)", async () => {
    const seed = await seedBoundAgent("366");
    const ws = await openBoundSocket(seed);
    try {
      const chatA = await activeChat(seed, ws);
      const chatB = await activeChat(seed, ws);
      sendRuntime(ws, seed.agent.uuid, chatA, "working");

      await waitForCondition(async () => ((await statusOf(chatA, seed.agent.uuid))?.working ? true : null));
      expect((await statusOf(chatA, seed.agent.uuid))?.main).toBe("working");
      expect((await statusOf(chatB, seed.agent.uuid))?.working).toBe(false);
      expect((await statusOf(chatB, seed.agent.uuid))?.main).toBe("ready");

      const busy = await deriveWorkingAgents(app.db, [chatA, chatB]);
      expect(busy.get(chatA)).toEqual([seed.agent.uuid]);
      expect(busy.has(chatB)).toBe(false);
    } finally {
      await closeSocket(ws);
    }
  }, 20000);

  // Case 4: reconnect re-asserts working; a hard disconnect → offline (the
  // reachability gate, not stuck-working).
  it("case 4 — reconnect re-asserts working; disconnect → offline", async () => {
    const seed = await seedBoundAgent("recon");
    let ws = await openBoundSocket(seed);
    let chatId: string;
    try {
      chatId = await activeChat(seed, ws);
      sendRuntime(ws, seed.agent.uuid, chatId, "working");
      await waitForCondition(async () => ((await statusOf(chatId, seed.agent.uuid))?.working ? true : null));
    } finally {
      await closeSocket(ws);
    }

    // Hard disconnect → presence loses its client → reachable=false → offline.
    const offline = await waitForCondition(async () => {
      const st = await statusOf(chatId, seed.agent.uuid);
      return st && st.reachable === false ? st : null;
    });
    expect(offline.main).toBe("offline");

    // Reconnect (process alive → fullStateSync re-asserts active + working).
    ws = await openBoundSocket(seed);
    try {
      ws.send(JSON.stringify({ type: "session:state", agentId: seed.agent.uuid, chatId, state: "active" }));
      sendRuntime(ws, seed.agent.uuid, chatId, "working");
      const back = await waitForCondition(async () => {
        const st = await statusOf(chatId, seed.agent.uuid);
        return st?.working === true ? st : null;
      });
      expect(back.main).toBe("working");
    } finally {
      await closeSocket(ws);
    }
  }, 25000);

  // Case 5: org WS realtime delivery + same-value notify rules. A working
  // transition broadcasts `session:runtime`; a fresh same-value re-affirm does
  // NOT (no invalidation spam); a stale→fresh same-value report DOES.
  it("case 5 — org WS broadcasts on real composite change, stays silent on a fresh re-affirm", async () => {
    const seed = await seedBoundAgent("orgws");
    const agentWs = await openBoundSocket(seed);
    const adminWs = new WebSocket(
      `${orgWsBase}/${encodeURIComponent(seed.organizationId)}/ws/?token=${encodeURIComponent(seed.token)}`,
    );
    const runtimeFrames: Array<{ chatId?: string }> = [];
    try {
      await new Promise<void>((resolve, reject) => {
        adminWs.once("open", () => resolve());
        adminWs.once("error", reject);
      });
      await waitForFrame(adminWs, (m) => (m as { type?: string }).type === "admin:connected");
      adminWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; chatId?: string };
          if (msg.type === "session:runtime") runtimeFrames.push({ chatId: msg.chatId });
        } catch {
          // ignore
        }
      });

      const chatId = await activeChat(seed, agentWs);

      // (a) idle → working = value change → broadcast.
      sendRuntime(agentWs, seed.agent.uuid, chatId, "working");
      await waitForCondition(async () => (runtimeFrames.some((f) => f.chatId === chatId) ? true : null));
      const afterFirst = runtimeFrames.length;

      // (b) fresh same-value re-affirm → NO new broadcast.
      sendRuntime(agentWs, seed.agent.uuid, chatId, "working");
      await new Promise((r) => setTimeout(r, 600));
      expect(runtimeFrames.length).toBe(afterFirst);

      // (c) stale → fresh same-value → broadcast again (Idle→Working flip).
      await ageRuntimeStamp(seed.agent.uuid, chatId, RUNTIME_STALE_MS + 10_000);
      sendRuntime(agentWs, seed.agent.uuid, chatId, "working");
      await waitForCondition(async () => (runtimeFrames.length > afterFirst ? true : null));
      expect(runtimeFrames.length).toBeGreaterThan(afterFirst);
    } finally {
      await closeSocket(agentWs);
      adminWs.close();
      await new Promise<void>((r) => adminWs.once("close", () => r())).catch(() => {});
    }
  }, 25000);
});
