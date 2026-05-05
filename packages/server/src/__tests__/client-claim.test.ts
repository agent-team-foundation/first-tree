import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { createAgent } from "../services/agent.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { createTestAdmin, createTestApp } from "./helpers.js";

/**
 * `POST /me/clients/:clientId/claim` (decouple-client-from-identity §4.4):
 * a JWT-authenticated user takes ownership of a clients row. The transaction
 * unpins every agent whose manager belongs to the previous owner, and resets
 * the affected `agent_presence` rows. Idempotent when the caller is already
 * the owner. Reverse claim restores the original owner and unpins the new
 * owner's agents.
 *
 * Pairs with the WS `CLIENT_USER_MISMATCH` (4403) handshake refusal — a
 * mismatched JWT cannot register the client without the operator running
 * `client claim --confirm` first.
 */
describe("Client ownership transfer (claim)", () => {
  let app: FastifyInstance;
  let wsUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * Seed two admins (Alice, Bob) in the default org. Alice owns a clients
   * row with one autonomous agent pinned and a presence row marking it
   * online. Returns everything the claim tests need.
   */
  async function seed(suffix: string) {
    const orgId = await resolveDefaultOrgId(app.db);
    const alice = await createTestAdmin(app, { username: `claim-a-${suffix}-${crypto.randomUUID().slice(0, 6)}` });
    const bob = await createTestAdmin(app, { username: `claim-b-${suffix}-${crypto.randomUUID().slice(0, 6)}` });

    const clientId = `cli-claim-${suffix}-${crypto.randomUUID().slice(0, 6)}`;
    await app.db
      .insert(clients)
      .values({ id: clientId, userId: alice.userId, organizationId: orgId, status: "connected" });

    const agentA = await createAgent(app.db, {
      name: `claim-bot-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Alice's Bot",
      managerId: alice.memberId,
      clientId,
      organizationId: orgId,
    });
    await app.db
      .insert(agentPresence)
      .values({ agentId: agentA.uuid, status: "online", clientId, runtimeState: "idle" });

    return { orgId, alice, bob, clientId, agentA };
  }

  it("takeover: Bob's claim transfers ownership and unpins Alice's agent", async () => {
    const s = await seed("takeover");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/me/clients/${s.clientId}/claim`,
      headers: { authorization: `Bearer ${s.bob.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ clientId: string; previousUserId: string | null; unpinnedAgentCount: number }>();
    expect(body.clientId).toBe(s.clientId);
    expect(body.previousUserId).toBe(s.alice.userId);
    expect(body.unpinnedAgentCount).toBe(1);

    // clients.user_id flipped to Bob
    const [clientRow] = await app.db.select({ userId: clients.userId }).from(clients).where(eq(clients.id, s.clientId));
    expect(clientRow?.userId).toBe(s.bob.userId);

    // Alice's agent unpinned (clientId NULL) and presence reset
    const [agentRow] = await app.db
      .select({ clientId: agents.clientId })
      .from(agents)
      .where(eq(agents.uuid, s.agentA.uuid));
    expect(agentRow?.clientId).toBeNull();

    const [presRow] = await app.db
      .select({
        status: agentPresence.status,
        clientId: agentPresence.clientId,
        runtimeState: agentPresence.runtimeState,
      })
      .from(agentPresence)
      .where(eq(agentPresence.agentId, s.agentA.uuid));
    expect(presRow?.status).toBe("offline");
    expect(presRow?.clientId).toBeNull();
    expect(presRow?.runtimeState).toBeNull();
  });

  it("reverse: Alice claims back; Bob's agents go offline; Alice's prior agents remain unpinned", async () => {
    const s = await seed("reverse");

    // Bob claims first.
    const claim1 = await app.inject({
      method: "POST",
      url: `/api/v1/me/clients/${s.clientId}/claim`,
      headers: { authorization: `Bearer ${s.bob.accessToken}` },
      payload: {},
    });
    expect(claim1.statusCode).toBe(200);

    // Bob now pins one of his own agents to the client.
    const orgId = s.orgId;
    const bobAgent = await createAgent(app.db, {
      name: `bobbot-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Bob's Bot",
      managerId: s.bob.memberId,
      clientId: s.clientId,
      organizationId: orgId,
    });
    await app.db
      .insert(agentPresence)
      .values({ agentId: bobAgent.uuid, status: "online", clientId: s.clientId, runtimeState: "idle" });

    // Alice claims back.
    const claim2 = await app.inject({
      method: "POST",
      url: `/api/v1/me/clients/${s.clientId}/claim`,
      headers: { authorization: `Bearer ${s.alice.accessToken}` },
      payload: {},
    });
    expect(claim2.statusCode).toBe(200);
    const body = claim2.json<{ unpinnedAgentCount: number; previousUserId: string | null }>();
    expect(body.previousUserId).toBe(s.bob.userId);
    expect(body.unpinnedAgentCount).toBe(1);

    // clients.user_id back to Alice
    const [clientRow] = await app.db.select({ userId: clients.userId }).from(clients).where(eq(clients.id, s.clientId));
    expect(clientRow?.userId).toBe(s.alice.userId);

    // Bob's just-pinned agent now unpinned + offline
    const [bobRow] = await app.db
      .select({ clientId: agents.clientId })
      .from(agents)
      .where(eq(agents.uuid, bobAgent.uuid));
    expect(bobRow?.clientId).toBeNull();

    // Alice's original agent stays unpinned (was unpinned during Bob's claim;
    // reverse claim does not auto-restore — operator must `agent add` again).
    const [aliceRow] = await app.db
      .select({ clientId: agents.clientId })
      .from(agents)
      .where(eq(agents.uuid, s.agentA.uuid));
    expect(aliceRow?.clientId).toBeNull();
  });

  it("idempotent: claiming a client you already own is a no-op", async () => {
    const s = await seed("idem");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/me/clients/${s.clientId}/claim`,
      headers: { authorization: `Bearer ${s.alice.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ unpinnedAgentCount: number }>().unpinnedAgentCount).toBe(0);

    // Alice's agent still pinned
    const [agentRow] = await app.db
      .select({ clientId: agents.clientId })
      .from(agents)
      .where(eq(agents.uuid, s.agentA.uuid));
    expect(agentRow?.clientId).toBe(s.clientId);
  });

  it("WS handshake: a JWT for a non-owner refuses register with code CLIENT_USER_MISMATCH and closes 4403", async () => {
    const s = await seed("mismatch");

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    // Auth with Bob's JWT (the client.yaml is Alice's).
    ws.send(JSON.stringify({ type: "auth", token: s.bob.accessToken }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("auth timeout")), 5000);
      ws.once("message", (raw) => {
        try {
          const m = JSON.parse(raw.toString()) as { type?: string };
          if (m.type === "auth:ok") {
            clearTimeout(timer);
            resolve();
          }
        } catch {
          // ignore
        }
      });
    });

    // Now register with Alice's clientId — server must reject.
    const rejectedPromise = new Promise<{ code?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("reject timeout")), 5000);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const m = JSON.parse(raw.toString()) as { type?: string; code?: string };
          if (m.type === "client:register:rejected") {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve({ code: m.code });
          }
        } catch {
          // ignore
        }
      };
      ws.on("message", onMessage);
    });
    const closedPromise = new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
    });
    ws.send(JSON.stringify({ type: "client:register", clientId: s.clientId }));

    const rejected = await rejectedPromise;
    const closeCode = await closedPromise;
    expect(rejected.code).toBe("CLIENT_USER_MISMATCH");
    expect(closeCode).toBe(4403);

    // Owner stayed Alice — register did not silently overwrite.
    const [row] = await app.db.select({ userId: clients.userId }).from(clients).where(eq(clients.id, s.clientId));
    expect(row?.userId).toBe(s.alice.userId);
  });

  /**
   * Regression for codex P1 #1 — claim must drop the previous owner's
   * live socket. Without the force-disconnect call in the route handler,
   * the old socket would keep its in-memory `boundAgents` subscriptions
   * and continue receiving inbox NOTIFY pushes for the unpinned agents
   * until the process exited. We exercise the full path end-to-end so a
   * regression in either the route or the connection-manager API gets
   * caught.
   */
  it("claim force-disconnects the previous owner's live WebSocket (P1 #1)", async () => {
    const s = await seed("force-drop");

    // Alice opens her socket and registers — server tracks it in
    // connectionManager.clientConnections under the clientId.
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token: s.alice.accessToken }));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("auth timeout")), 5000);
      const handler = (raw: WebSocket.RawData) => {
        const m = JSON.parse(raw.toString()) as { type?: string };
        if (m.type === "auth:ok") {
          clearTimeout(t);
          ws.off("message", handler);
          resolve();
        }
      };
      ws.on("message", handler);
    });
    ws.send(JSON.stringify({ type: "client:register", clientId: s.clientId }));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("register timeout")), 5000);
      const handler = (raw: WebSocket.RawData) => {
        const m = JSON.parse(raw.toString()) as { type?: string };
        if (m.type === "client:registered") {
          clearTimeout(t);
          ws.off("message", handler);
          resolve();
        }
      };
      ws.on("message", handler);
    });

    // Capture the close code Alice's socket gets when Bob takes over.
    const closedPromise = new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
    });

    const claimRes = await app.inject({
      method: "POST",
      url: `/api/v1/me/clients/${s.clientId}/claim`,
      headers: { authorization: `Bearer ${s.bob.accessToken}` },
      payload: {},
    });
    expect(claimRes.statusCode).toBe(200);

    // Alice's socket must close — without the route fix, this hangs.
    const closeCode = await Promise.race([
      closedPromise,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("socket not closed within timeout")), 3000)),
    ]);
    // 4009 = WS_CLOSE_ALREADY_CONNECTED — server-initiated, "Client disconnected by admin".
    expect(closeCode).toBe(4009);
  });
});
