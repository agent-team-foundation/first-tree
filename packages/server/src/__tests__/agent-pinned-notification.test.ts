import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createAgent, suspendAgent } from "../services/agent.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * Regression guard for the "auto agent add" fix: when an admin creates (or
 * binds) an agent with a `clientId` pinned to a live client WebSocket, the
 * server must push an `agent:pinned` frame so the client runtime can
 * materialise its local config without a manual `agent add`.
 */
describe("Agent WS — agent:pinned push on create/bind", () => {
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

  async function seedConnectedClient(suffix: string) {
    const orgId = await resolveDefaultOrgId(app.db);
    const userId = uuidv7();
    const memberId = uuidv7();
    const clientId = `cli-pin-${suffix}-${crypto.randomUUID().slice(0, 6)}`;
    const role = "admin";

    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `pin-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: `Pin User ${suffix}`,
      });

      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `pin-human-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: `Pin Human ${suffix}`,
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
    });

    const token = await signMemberJwt(userId, memberId, orgId, role);
    return { token, clientId, memberId, userId, organizationId: orgId };
  }

  function waitForFrame(
    ws: WebSocket,
    match: (m: unknown) => boolean,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (match(parsed)) {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(parsed);
          }
        } catch {
          // ignore non-JSON
        }
      };
      ws.on("message", onMessage);
    });
  }

  async function openRegisteredSocket(seed: Awaited<ReturnType<typeof seedConnectedClient>>): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "auth", token: seed.token }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok");

    ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "client:registered");

    return ws;
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

  it("pushes agent:pinned when POST /admin/agents creates an agent with a live clientId", async () => {
    const seed = await seedConnectedClient("create");
    const ws = await openRegisteredSocket(seed);

    try {
      const pinnedPromise = waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:pinned");

      const name = `pin-created-${crypto.randomUUID().slice(0, 6)}`;
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${seed.organizationId}/agents`,
        headers: { authorization: `Bearer ${seed.token}` },
        payload: {
          name,
          type: "agent",
          displayName: "Pin Created",
          clientId: seed.clientId,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ uuid: string; clientId: string | null }>();
      expect(body.clientId).toBe(seed.clientId);

      const pinned = await pinnedPromise;
      expect(pinned.type).toBe("agent:pinned");
      expect(pinned.agentId).toBe(body.uuid);
      expect(pinned.name).toBe(name);
      expect(pinned.displayName).toBe("Pin Created");
      // Wire-compat: every non-human `agent` row is rendered as
      // `personal_assistant` on the wire so clients on ≤ 0.5.1 (strict
      // zod enum) still decode the frame. The legacy label is
      // intentionally not derived from `visibility` — see
      // `agentService.legacyWireAgentType` for the rationale.
      expect(pinned.agentType).toBe("personal_assistant");
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("pushes agent:pinned when PATCH /admin/agents/:uuid binds a NULL clientId to a live client", async () => {
    const seed = await seedConnectedClient("bind");
    const ws = await openRegisteredSocket(seed);

    try {
      // Create the agent WITHOUT a clientId, then bind it via PATCH — that is
      // the exact "unbound → pinned" transition that the fix must cover.
      const unbound = await createAgent(app.db, {
        name: `pin-bind-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Pin Bound",
        source: "admin-api",
        managerId: seed.memberId,
        organizationId: seed.organizationId,
      });
      expect(unbound.clientId).toBeNull();

      const pinnedPromise = waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:pinned");

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/agents/${unbound.uuid}`,
        headers: { authorization: `Bearer ${seed.token}` },
        payload: { clientId: seed.clientId },
      });
      expect(res.statusCode).toBe(200);

      const pinned = await pinnedPromise;
      expect(pinned.agentId).toBe(unbound.uuid);
      expect(pinned.name).toBe(unbound.name);
      // Wire-compat: see comment in the "create" test above.
      expect(pinned.agentType).toBe("personal_assistant");
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("does NOT push agent:pinned when the creating admin uses a different client", async () => {
    const seed = await seedConnectedClient("noise");
    const ws = await openRegisteredSocket(seed);

    try {
      // Seed a second claimed client owned by the same user. The agent will
      // be pinned to that client, not `seed.clientId` — so the live WS on
      // `seed.clientId` must stay quiet.
      const otherClientId = `cli-other-${crypto.randomUUID().slice(0, 6)}`;
      await app.db.insert(clients).values({
        id: otherClientId,
        userId: seed.userId,
        organizationId: seed.organizationId,
        status: "connected",
      });

      let receivedPinned = false;
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string };
          if (msg.type === "agent:pinned") receivedPinned = true;
        } catch {
          // ignore
        }
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${seed.organizationId}/agents`,
        headers: { authorization: `Bearer ${seed.token}` },
        payload: {
          name: `pin-noise-${crypto.randomUUID().slice(0, 6)}`,
          type: "agent",
          clientId: otherClientId,
        },
      });
      expect(res.statusCode).toBe(201);

      // Give the server a beat to send — if it were going to send.
      await new Promise((r) => setTimeout(r, 200));
      expect(receivedPinned).toBe(false);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("backfills agent:pinned for agents pinned while the client was offline", async () => {
    // Models the gap the realtime push doesn't cover: an admin pins an agent
    // while the client process isn't connected. Without backfill the operator
    // would still need a manual `agent add` after restart.
    const seed = await seedConnectedClient("backfill");

    // Seed two agents pinned to this client BEFORE we open any WS, so the
    // realtime push has nothing to deliver to.
    const offlineCreated = await createAgent(app.db, {
      name: `pin-offline-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Offline Pinned",
      source: "admin-api",
      managerId: seed.memberId,
      clientId: seed.clientId,
      organizationId: seed.organizationId,
    });
    const offlineCreated2 = await createAgent(app.db, {
      name: `pin-offline-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      source: "admin-api",
      managerId: seed.memberId,
      clientId: seed.clientId,
      organizationId: seed.organizationId,
    });

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    try {
      const seenPinned = new Map<string, Record<string, unknown>>();
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === "agent:pinned" && typeof msg.agentId === "string") {
            seenPinned.set(msg.agentId, msg);
          }
        } catch {
          // ignore
        }
      });

      ws.send(JSON.stringify({ type: "auth", token: seed.token }));
      await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok");
      ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId }));
      await waitForFrame(ws, (m) => (m as { type?: string }).type === "client:registered");

      // Both backfill frames must arrive shortly after `client:registered`.
      await waitForFrame(
        ws,
        (m) => {
          const msg = m as { type?: string; agentId?: string };
          return (
            msg.type === "agent:pinned" && seenPinned.has(offlineCreated.uuid) && seenPinned.has(offlineCreated2.uuid)
          );
        },
        2000,
      );

      const a = seenPinned.get(offlineCreated.uuid);
      expect(a).toBeDefined();
      expect(a?.name).toBe(offlineCreated.name);
      // Wire-compat: see comment in the "create" test above.
      expect(a?.agentType).toBe("personal_assistant");
      const b = seenPinned.get(offlineCreated2.uuid);
      expect(b).toBeDefined();
      expect(b?.name).toBe(offlineCreated2.name);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("does not backfill suspended pinned agents", async () => {
    const seed = await seedConnectedClient("suspended-backfill");
    const active = await createAgent(app.db, {
      name: `pin-active-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Active Pinned",
      source: "admin-api",
      managerId: seed.memberId,
      organizationId: seed.organizationId,
      clientId: seed.clientId,
    });
    const suspended = await createAgent(app.db, {
      name: `pin-suspended-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Suspended Pinned",
      source: "admin-api",
      managerId: seed.memberId,
      organizationId: seed.organizationId,
      clientId: seed.clientId,
    });
    await suspendAgent(app.db, suspended.uuid);

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    try {
      const seenPinned = new Set<string>();
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; agentId?: string };
          if (msg.type === "agent:pinned" && typeof msg.agentId === "string") seenPinned.add(msg.agentId);
        } catch {
          // ignore
        }
      });

      ws.send(JSON.stringify({ type: "auth", token: seed.token }));
      await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok");
      ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId }));
      await waitForFrame(ws, (m) => (m as { type?: string }).type === "client:registered");
      await waitForFrame(
        ws,
        (m) => (m as { type?: string; agentId?: string }).type === "agent:pinned" && seenPinned.has(active.uuid),
        2000,
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(seenPinned.has(active.uuid)).toBe(true);
      expect(seenPinned.has(suspended.uuid)).toBe(false);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("suspend sends force-disconnect reason and rejects later runtime frames", async () => {
    const seed = await seedConnectedClient("suspend-force");
    const agent = await createAgent(app.db, {
      name: `pin-force-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Force Suspended",
      source: "admin-api",
      managerId: seed.memberId,
      organizationId: seed.organizationId,
      clientId: seed.clientId,
    });
    const ws = await openRegisteredSocket(seed);

    try {
      ws.send(
        JSON.stringify({
          type: "agent:bind",
          ref: "bind-force",
          agentId: agent.uuid,
          runtimeType: "claude-code",
          runtimeVersion: "test",
        }),
      );
      await waitForFrame(
        ws,
        (m) =>
          (m as { type?: string; agentId?: string }).type === "agent:bound" &&
          (m as { agentId?: string }).agentId === agent.uuid,
      );

      const forcePromise = waitForFrame(
        ws,
        (m) => (m as { type?: string; agentId?: string }).type === "agent:force_disconnect",
      );
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${agent.uuid}/suspend`,
        headers: { authorization: `Bearer ${seed.token}` },
      });
      expect(res.statusCode).toBe(200);

      const frame = await forcePromise;
      expect(frame).toMatchObject({
        type: "agent:force_disconnect",
        agentId: agent.uuid,
        reason: "agent_suspended",
      });

      ws.send(
        JSON.stringify({ type: "session:state", agentId: agent.uuid, chatId: "chat-after-suspend", state: "active" }),
      );
      const error = await waitForFrame(ws, (m) => (m as { type?: string }).type === "error");
      expect(error.message).toBe("Agent not bound");
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("fans runtime route changes to the instance that owns the client socket", async () => {
    const seed = await seedConnectedClient("route-change");
    const agent = await createAgent(app.db, {
      name: `pin-route-change-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Route Changed",
      source: "admin-api",
      managerId: seed.memberId,
      organizationId: seed.organizationId,
      clientId: seed.clientId,
      runtimeProvider: "claude-code",
    });
    const ws = await openRegisteredSocket(seed);

    try {
      ws.send(
        JSON.stringify({
          type: "agent:bind",
          ref: "bind-route-change",
          agentId: agent.uuid,
          runtimeType: "claude-code",
          runtimeVersion: "test",
        }),
      );
      await waitForFrame(
        ws,
        (m) =>
          (m as { type?: string; agentId?: string }).type === "agent:bound" &&
          (m as { agentId?: string }).agentId === agent.uuid,
      );

      const forcePromise = waitForFrame(
        ws,
        (m) =>
          (m as { type?: string; agentId?: string }).type === "agent:force_disconnect" &&
          (m as { agentId?: string }).agentId === agent.uuid,
      );
      const pinnedPromise = waitForFrame(
        ws,
        (m) =>
          (m as { type?: string; agentId?: string }).type === "agent:pinned" &&
          (m as { agentId?: string }).agentId === agent.uuid,
      );

      await app.notifier.notifyAgentRouteChange({
        agentId: agent.uuid,
        name: agent.name,
        displayName: agent.displayName,
        agentType: "personal_assistant",
        oldClientId: seed.clientId,
        targetClientId: seed.clientId,
        runtimeProvider: "codex",
        reason: "agent_runtime_switch",
      });

      await expect(forcePromise).resolves.toMatchObject({
        type: "agent:force_disconnect",
        agentId: agent.uuid,
        reason: "agent_runtime_switch",
      });
      await expect(pinnedPromise).resolves.toMatchObject({
        type: "agent:pinned",
        agentId: agent.uuid,
        runtimeProvider: "codex",
      });
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("does NOT push agent:pinned on PATCHes that don't transition NULL → ID", async () => {
    const seed = await seedConnectedClient("rename");
    const ws = await openRegisteredSocket(seed);

    try {
      const existing = await createAgent(app.db, {
        name: `pin-existing-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Existing",
        source: "admin-api",
        managerId: seed.memberId,
        clientId: seed.clientId,
        organizationId: seed.organizationId,
      });
      expect(existing.clientId).toBe(seed.clientId);

      // Drain any create-time pinned frame the previous test block might have
      // left in-flight for THIS agent (defensive — a fresh seed should be quiet).
      await new Promise((r) => setTimeout(r, 100));

      let receivedPinnedAfterPatch = false;
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; agentId?: string };
          if (msg.type === "agent:pinned" && msg.agentId === existing.uuid) {
            receivedPinnedAfterPatch = true;
          }
        } catch {
          // ignore
        }
      });

      // Touch only displayName — no clientId transition, should stay silent.
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/agents/${existing.uuid}`,
        headers: { authorization: `Bearer ${seed.token}` },
        payload: { displayName: "Renamed" },
      });
      expect(res.statusCode).toBe(200);

      await new Promise((r) => setTimeout(r, 200));
      expect(receivedPinnedAfterPatch).toBe(false);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);
});
