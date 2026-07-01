import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { agentPresence } from "../db/schema/agent-presence.js";
import { clients } from "../db/schema/clients.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import * as clientService from "../services/client.js";
import * as connectionManager from "../services/connection-manager.js";
import { sendMessage } from "../services/message.js";
import * as presenceService from "../services/presence.js";
import { createTestAdmin, createTestApp } from "./helpers.js";

/**
 * Regression test for the May 7 staging incident: a client reconnects
 * (typical `systemctl restart` flow), the new socket finishes register
 * and the row becomes `connected`, but the *old* socket's `socket.on
 * ("close")` handler — running asynchronously — then awaits
 * `disconnectClient` and stamps `status='disconnected'`, clobbering the
 * fresh state. From the operator's perspective everything is healthy
 * (CLI, doctor, agents bound) but the Web admin shows "offline".
 *
 * The fix in ws-client.ts gates the DB write on
 * `connectionManager.isActiveClientConnection(clientId, socket)` — the
 * old socket sees `false` (the new socket has already taken over) and
 * skips the write.
 *
 * This test reproduces the race deterministically by opening two
 * sockets under the same clientId in sequence; the second register
 * triggers the connection-manager's "ALREADY_CONNECTED" close on the
 * first socket. We then wait for the first socket's onClose handler to
 * complete and assert the row remained `connected`.
 */
describe("WS client reconnect race — late onClose must not clobber a fresh status", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  let userId: string;
  let memberId: string;
  let humanAgentUuid: string;
  let orgId: string;
  let role: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signAccess(): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: userId,
      memberId,
      organizationId: orgId,
      role,
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  /**
   * Open a WS, send `auth` + `client:register`, resolve once the server
   * has acknowledged registration (`client:registered` frame). Returns
   * the open WebSocket so the caller can close it (or wait for the
   * server to close it).
   */
  async function authAndRegister(token: string, clientId: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("register timeout")), 5000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === "auth:ok") {
          ws.send(JSON.stringify({ type: "client:register", clientId }));
        } else if (msg.type === "client:registered") {
          clearTimeout(timer);
          resolve();
        } else if (msg.type === "client:register:rejected") {
          clearTimeout(timer);
          reject(new Error(`register rejected: ${JSON.stringify(msg)}`));
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return ws;
  }

  async function waitForFrame(
    ws: WebSocket,
    predicate: (msg: { type?: string }) => boolean,
  ): Promise<{ type?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error("frame timeout"));
      }, 5000);
      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString()) as { type?: string };
        if (!predicate(msg)) return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      };
      ws.on("message", onMessage);
    });
  }

  async function createBoundAgent(ws: WebSocket, clientId: string): Promise<string> {
    const agent = await createAgent(app.db, {
      name: `race-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Race Agent",
      managerId: memberId,
      clientId,
      runtimeProvider: "claude-code",
    });
    ws.send(
      JSON.stringify({
        type: "agent:bind",
        ref: `bind-${crypto.randomUUID()}`,
        agentId: agent.uuid,
        runtimeType: "claude-code",
      }),
    );
    const msg = await waitForFrame(ws, (m) => m.type === "agent:bound" || m.type === "agent:bind:rejected");
    expect(msg.type).toBe("agent:bound");
    return agent.uuid;
  }

  async function loadNotifyRow(messageId: string) {
    const [row] = await app.db
      .select({
        id: inboxEntries.id,
        status: inboxEntries.status,
        deliveredAt: inboxEntries.deliveredAt,
      })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, messageId), eq(inboxEntries.notify, true)))
      .limit(1);
    return row;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
  });

  beforeEach(async () => {
    const admin = await createTestAdmin(app, { username: `race-${crypto.randomUUID().slice(0, 8)}` });
    userId = admin.userId;
    memberId = admin.memberId;
    humanAgentUuid = admin.humanAgentUuid;
    const { members } = await import("../db/schema/members.js");
    const [m] = await app.db.select().from(members).where(eq(members.id, memberId)).limit(1);
    if (!m) throw new Error("member row missing after setup");
    orgId = m.organizationId;
    role = m.role;
  });

  afterAll(async () => {
    await app.close();
  });

  it("preserves clients.status='connected' when the displaced socket's onClose lands after the new register", async () => {
    const token = await signAccess();
    const clientId = `client_${crypto.randomUUID().slice(0, 8)}`;

    // First connection — registers and becomes the active socket.
    const ws1 = await authAndRegister(token, clientId);

    // Track when ws1 actually finishes closing on the server side. The
    // close is initiated by setClientConnection during ws2's register
    // (code 4009 ALREADY_CONNECTED), and onClose runs asynchronously
    // afterwards. We can't directly observe the server's handler, but
    // the client-side `close` event is a tight upper bound — onClose's
    // own awaits run within a few ms after the network close.
    const ws1Closed = new Promise<void>((resolve) => ws1.on("close", () => resolve()));

    // Second connection under the same clientId — server's
    // setClientConnection forces close on ws1, and ws2's register
    // writes status='connected'.
    const ws2 = await authAndRegister(token, clientId);

    // Wait for ws1's close + a small buffer so onClose's awaited DB
    // write (if any — the fix should suppress it) lands before we
    // sample.
    await ws1Closed;
    await new Promise((r) => setTimeout(r, 100));

    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId));

    // Without the fix, this would be 'disconnected' — ws1's onClose
    // would have stamped it after ws2's register. With the fix, ws1's
    // handler sees `isActiveClientConnection(...)=false` (the slot now
    // points at ws2) and skips the DB write.
    expect(row?.status).toBe("connected");

    ws2.close();
  }, 10_000);

  it("keeps client and agent presence connected during the socket-close grace window", async () => {
    // A single socket close is only a transport loss. Proactive auth
    // refreshes and short network blips reconnect quickly, so the DB
    // should keep the last connected presence until heartbeat staleness
    // cleanup proves the client is gone.
    const token = await signAccess();
    const clientId = `client_${crypto.randomUUID().slice(0, 8)}`;

    const ws = await authAndRegister(token, clientId);
    const agentId = await createBoundAgent(ws, clientId);
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 100));

    const [row] = await app.db.select().from(clients).where(eq(clients.id, clientId));
    expect(row?.status).toBe("connected");

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId));
    expect(presence?.status).toBe("online");
    expect(presence?.clientId).toBe(clientId);
    expect(presence?.runtimeState).toBe("idle");

    const staleAt = new Date(Date.now() - 120_000);
    await app.db.update(clients).set({ lastSeenAt: staleAt }).where(eq(clients.id, clientId));

    await expect(clientService.cleanupStaleClients(app.db, 60)).resolves.toBe(1);

    const [staleClient] = await app.db.select().from(clients).where(eq(clients.id, clientId));
    expect(staleClient?.status).toBe("disconnected");

    const [stalePresence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId));
    expect(stalePresence?.status).toBe("offline");
    expect(stalePresence?.clientId).toBeNull();
    expect(stalePresence?.runtimeState).toBeNull();
  }, 10_000);

  it("self-heals a false-positive stale sweep on heartbeat from the still-active socket", async () => {
    const token = await signAccess();
    const clientId = `client_${crypto.randomUUID().slice(0, 8)}`;

    const ws = await authAndRegister(token, clientId);
    const agentId = await createBoundAgent(ws, clientId);

    const staleAt = new Date(Date.now() - 120_000);
    await app.db.update(clients).set({ lastSeenAt: staleAt }).where(eq(clients.id, clientId));
    await expect(clientService.cleanupStaleClients(app.db, 60)).resolves.toBe(1);
    await presenceService.setRuntimeState(app.db, agentId, "working");

    const ackPromise = waitForFrame(ws, (m) => m.type === "heartbeat:ack");
    ws.send(JSON.stringify({ type: "heartbeat" }));
    await ackPromise;

    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId));
    expect(client?.status).toBe("connected");
    expect(client?.instanceId).toBe("test-instance");
    expect(client?.lastSeenAt.getTime()).toBeGreaterThan(staleAt.getTime());

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId));
    expect(presence?.status).toBe("online");
    expect(presence?.clientId).toBe(clientId);
    expect(presence?.instanceId).toBe("test-instance");
    expect(presence?.runtimeState).toBe("working");

    ws.close();
  }, 10_000);

  it("acks but does not restore when the heartbeat socket is no longer the active client connection", async () => {
    const token = await signAccess();
    const clientId = `client_${crypto.randomUUID().slice(0, 8)}`;

    const ws = await authAndRegister(token, clientId);
    const agentId = await createBoundAgent(ws, clientId);

    const staleAt = new Date(Date.now() - 120_000);
    await app.db.update(clients).set({ lastSeenAt: staleAt }).where(eq(clients.id, clientId));
    await expect(clientService.cleanupStaleClients(app.db, 60)).resolves.toBe(1);

    const activeSpy = vi.spyOn(connectionManager, "isActiveClientConnection").mockReturnValue(false);
    try {
      const ackPromise = waitForFrame(ws, (m) => m.type === "heartbeat:ack");
      ws.send(JSON.stringify({ type: "heartbeat" }));
      await ackPromise;
    } finally {
      activeSpy.mockRestore();
      ws.close();
    }

    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId));
    expect(client?.status).toBe("disconnected");
    expect(client?.lastSeenAt.getTime()).toBe(staleAt.getTime());

    const [presence] = await app.db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId));
    expect(presence?.status).toBe("offline");
    expect(presence?.clientId).toBeNull();
  }, 10_000);

  it("does not repair inbox backlog when liveness guards reject the heartbeat", async () => {
    const token = await signAccess();
    const clientId = `client_${crypto.randomUUID().slice(0, 8)}`;

    const ws = await authAndRegister(token, clientId);
    const agentId = await createBoundAgent(ws, clientId);
    const chat = await createChat(app.db, humanAgentUuid, {
      type: "group",
      participantIds: [agentId],
    });

    const sent = await sendMessage(app.db, chat.id, humanAgentUuid, {
      source: "api",
      format: "text",
      content: "stale heartbeat must not repair inbox",
      metadata: { mentions: [agentId] },
    });
    expect((await loadNotifyRow(sent.message.id))?.status).toBe("pending");

    await app.db.update(clients).set({ instanceId: "other-instance" }).where(eq(clients.id, clientId));

    const ackPromise = waitForFrame(ws, (m) => m.type === "heartbeat:ack");
    ws.send(JSON.stringify({ type: "heartbeat" }));
    await ackPromise;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const row = await loadNotifyRow(sent.message.id);
    expect(row?.status).toBe("pending");
    expect(row?.deliveredAt).toBeNull();

    ws.close();
  }, 10_000);
});
