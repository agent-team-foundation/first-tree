import { AGENT_BIND_REJECT_REASONS } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { users } from "../db/schema/users.js";
import * as activityService from "../services/activity.js";
import { createAgent } from "../services/agent.js";
import * as agentRuntimeSessionService from "../services/agent-runtime-session.js";
import * as clientService from "../services/client.js";
import * as connectionManager from "../services/connection-manager.js";
import * as inboxService from "../services/inbox.js";
import * as notificationService from "../services/notification.js";
import * as presenceService from "../services/presence.js";
import * as sessionEventService from "../services/session-event.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, createTestApp, seedClient } from "./helpers.js";

describe("Agent client WS edge protocol coverage", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signJwt(payload: Record<string, unknown>): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  async function signJwtWithoutExpiry(payload: Record<string, unknown>): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt().sign(secret);
  }

  async function signAccess(userId: string, memberId: string, organizationId?: string): Promise<string> {
    return signJwt({
      sub: userId,
      memberId,
      ...(organizationId ? { organizationId } : {}),
      role: "admin",
      type: "access",
    });
  }

  function waitForFrame(ws: WebSocket, match: (message: unknown) => boolean, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const message = JSON.parse(raw.toString());
          if (!match(message)) return;
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(message);
        } catch {
          // Ignore non-JSON frames.
        }
      };
      ws.on("message", onMessage);
    });
  }

  function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<number> {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for close (${timeoutMs}ms)`)), timeoutMs);
      ws.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  async function openSocket(): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return ws;
  }

  async function openSocketAt(url: string): Promise<WebSocket> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return ws;
  }

  async function closeSocket(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 500);
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
  }

  async function openAuthenticatedSocket(token: string): Promise<WebSocket> {
    const ws = await openSocket();
    ws.send(JSON.stringify({ type: "auth", token }));
    await waitForFrame(ws, (message) => (message as { type?: string }).type === "auth:ok");
    return ws;
  }

  async function openRegisteredSocket(seed: {
    userId: string;
    memberId: string;
    organizationId: string;
    clientId: string;
  }): Promise<WebSocket> {
    const ws = await openAuthenticatedSocket(await signAccess(seed.userId, seed.memberId, seed.organizationId));
    ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId, hostname: "edge-host", os: "linux" }));
    await waitForFrame(ws, (message) => (message as { type?: string }).type === "client:registered");
    return ws;
  }

  async function openRegisteredSocketAt(
    url: string,
    seed: {
      userId: string;
      memberId: string;
      organizationId: string;
      clientId: string;
    },
  ): Promise<WebSocket> {
    const ws = await openSocketAt(url);
    ws.send(JSON.stringify({ type: "auth", token: await signAccess(seed.userId, seed.memberId, seed.organizationId) }));
    await waitForFrame(ws, (message) => (message as { type?: string }).type === "auth:ok");
    ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId, hostname: "edge-host", os: "linux" }));
    await waitForFrame(ws, (message) => (message as { type?: string }).type === "client:registered");
    return ws;
  }

  async function bindAgent(
    ws: WebSocket,
    agentId: string,
    ref: string,
    runtimeType = "claude-code",
  ): Promise<{ type?: string; ref?: string; reason?: string; agentId?: string; runtimeSessionToken?: string }> {
    ws.send(JSON.stringify({ type: "agent:bind", agentId, ref, runtimeType, runtimeVersion: "edge-test" }));
    return (await waitForFrame(ws, (message) => {
      const type = (message as { type?: string }).type;
      return type === "agent:bound" || type === "agent:bind:rejected";
    })) as { type?: string; ref?: string; reason?: string; agentId?: string; runtimeSessionToken?: string };
  }

  async function createPinnedAgent(seed: {
    memberId: string;
    organizationId: string;
    clientId: string;
    suffix: string;
  }): Promise<Awaited<ReturnType<typeof createAgent>>> {
    return createAgent(app.db, {
      name: `ws-edge-agent-${seed.suffix}-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "WS Edge Agent",
      source: "admin-api",
      managerId: seed.memberId,
      clientId: seed.clientId,
      organizationId: seed.organizationId,
      runtimeProvider: "claude-code",
    });
  }

  async function createUnboundAgent(seed: {
    memberId: string;
    organizationId: string;
    suffix: string;
  }): Promise<Awaited<ReturnType<typeof createAgent>>> {
    return createAgent(app.db, {
      name: `ws-edge-unbound-${seed.suffix}-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "WS Edge Unbound Agent",
      source: "admin-api",
      managerId: seed.memberId,
      organizationId: seed.organizationId,
      runtimeProvider: "claude-code",
    });
  }

  async function createPinnedAgentFor(
    targetApp: FastifyInstance,
    seed: {
      memberId: string;
      organizationId: string;
      clientId: string;
      suffix: string;
    },
  ): Promise<Awaited<ReturnType<typeof createAgent>>> {
    return createAgent(targetApp.db, {
      name: `ws-edge-agent-${seed.suffix}-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "WS Edge Agent",
      source: "admin-api",
      managerId: seed.memberId,
      clientId: seed.clientId,
      organizationId: seed.organizationId,
      runtimeProvider: "claude-code",
    });
  }

  function inboxEntry(id: number, inboxId: string, chatId: string) {
    return {
      id,
      inboxId,
      messageId: `msg-${id}`,
      chatId,
      status: "delivered",
      retryCount: 0,
      createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
      ackedAt: null,
      message: null,
    };
  }

  async function withInboxCappedApp(
    inbox: { maxInFlightPerAgent: number; maxInFlightPerAgentChat: number },
    fn: (targetApp: FastifyInstance, targetWsUrl: string) => Promise<void>,
  ): Promise<void> {
    const targetApp = await createTestApp({ inbox });
    await targetApp.listen({ port: 0, host: "127.0.0.1" });
    const address = targetApp.server.address();
    if (!address || typeof address === "string") throw new Error("test server has no address");
    try {
      await fn(targetApp, `ws://127.0.0.1:${address.port}/api/v1/agent/ws/client`);
    } finally {
      await targetApp.close();
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${address.port}/api/v1/agent/ws/client`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    { name: "invalid JSON", raw: "{" },
    { name: "invalid envelope", raw: "[]" },
    { name: "first frame is not auth", raw: JSON.stringify({ type: "heartbeat" }) },
    { name: "auth frame is missing token", raw: JSON.stringify({ type: "auth" }) },
  ])("rejects pre-auth $name", async ({ raw }) => {
    const ws = await openSocket();
    ws.send(raw);

    const frame = await waitForFrame(ws, (message) => (message as { type?: string }).type === "auth:rejected");
    const closeCode = await waitForClose(ws);

    expect(frame).toMatchObject({ type: "auth:rejected", code: "invalid_auth_frame" });
    expect(closeCode).toBe(4401);
  });

  it.each([
    { name: "wrong token type", payload: { sub: "placeholder", type: "refresh" }, code: "wrong_token_type" },
    { name: "missing token type", payload: { sub: "placeholder" }, code: "invalid_claims" },
    { name: "missing subject", payload: { type: "access" }, code: "invalid_claims" },
  ])("rejects $name claims", async ({ payload, code }) => {
    const admin = await createTestAdmin(app, { username: `ws-claims-${crypto.randomUUID().slice(0, 8)}` });
    const tokenPayload = { ...payload, sub: payload.sub === "placeholder" ? admin.userId : payload.sub };
    const ws = await openSocket();
    ws.send(JSON.stringify({ type: "auth", token: await signJwt(tokenPayload) }));

    const frame = await waitForFrame(ws, (message) => (message as { type?: string }).type === "auth:rejected");
    const closeCode = await waitForClose(ws);

    expect(frame).toMatchObject({ type: "auth:rejected", code });
    expect(closeCode).toBe(4401);
  });

  it("reports expired access tokens with an auth:expired frame", async () => {
    const admin = await createTestAdmin(app, { username: `ws-expired-${crypto.randomUUID().slice(0, 8)}` });
    const token = await new SignJWT({ sub: admin.userId, type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(jwtSecret));
    const ws = await openSocket();
    ws.send(JSON.stringify({ type: "auth", token }));

    const frame = await waitForFrame(ws, (message) => (message as { type?: string }).type === "auth:expired");
    const closeCode = await waitForClose(ws);

    expect(frame).toMatchObject({ type: "auth:expired" });
    expect(closeCode).toBe(4401);
  });

  it("maps jose claim validation failures to invalid_claims during auth", async () => {
    const admin = await createTestAdmin(app, { username: `ws-nbf-${crypto.randomUUID().slice(0, 8)}` });
    const token = await new SignJWT({ sub: admin.userId, type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setNotBefore("1h")
      .setExpirationTime("2h")
      .sign(new TextEncoder().encode(jwtSecret));
    const ws = await openSocket();
    ws.send(JSON.stringify({ type: "auth", token }));

    const frame = await waitForFrame(ws, (message) => (message as { type?: string }).type === "auth:rejected");
    const closeCode = await waitForClose(ws);

    expect(frame).toMatchObject({ type: "auth:rejected", code: "invalid_claims" });
    expect(closeCode).toBe(4401);
  });

  it("accepts access tokens without exp and rejects inactive or missing users", async () => {
    const active = await createTestAdmin(app, { username: `ws-no-exp-${crypto.randomUUID().slice(0, 8)}` });
    const activeWs = await openSocket();
    activeWs.send(
      JSON.stringify({ type: "auth", token: await signJwtWithoutExpiry({ sub: active.userId, type: "access" }) }),
    );
    await expect(
      waitForFrame(activeWs, (message) => (message as { type?: string }).type === "auth:ok"),
    ).resolves.toMatchObject({ type: "auth:ok" });
    await closeSocket(activeWs);

    const missingWs = await openSocket();
    missingWs.send(JSON.stringify({ type: "auth", token: await signJwt({ sub: uuidv7(), type: "access" }) }));
    await expect(
      waitForFrame(missingWs, (message) => (message as { type?: string }).type === "auth:rejected"),
    ).resolves.toMatchObject({ type: "auth:rejected", code: "user_not_found" });
    expect(await waitForClose(missingWs)).toBe(4401);

    const suspended = await createTestAdmin(app, { username: `ws-suspended-${crypto.randomUUID().slice(0, 8)}` });
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, suspended.userId));
    const suspendedWs = await openSocket();
    suspendedWs.send(JSON.stringify({ type: "auth", token: await signJwt({ sub: suspended.userId, type: "access" }) }));
    await expect(
      waitForFrame(suspendedWs, (message) => (message as { type?: string }).type === "auth:rejected"),
    ).resolves.toMatchObject({ type: "auth:rejected", code: "user_suspended" });
    expect(await waitForClose(suspendedWs)).toBe(4401);
  }, 15000);

  it("reports malformed post-auth frames and acknowledges heartbeat before registration", async () => {
    const seed = await createAdminContext(app, { username: `ws-post-auth-${crypto.randomUUID().slice(0, 8)}` });
    const ws = await openAuthenticatedSocket(await signAccess(seed.userId, seed.memberId, seed.organizationId));

    try {
      ws.send("{");
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Invalid JSON"),
      ).resolves.toMatchObject({
        type: "error",
        message: "Invalid JSON",
      });

      ws.send("[]");
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Invalid message format"),
      ).resolves.toMatchObject({
        type: "error",
        message: "Invalid message format",
      });

      ws.send(
        JSON.stringify({
          type: "agent:bind",
          agentId: uuidv7(),
          ref: "bind-before-register",
          runtimeType: "claude-code",
        }),
      );
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Must register client first"),
      ).resolves.toMatchObject({
        type: "error",
        ref: "bind-before-register",
        message: "Must register client first",
      });

      ws.send(JSON.stringify({ type: "heartbeat" }));
      await expect(
        waitForFrame(ws, (message) => (message as { type?: string }).type === "heartbeat:ack"),
      ).resolves.toEqual({
        type: "heartbeat:ack",
      });
    } finally {
      await closeSocket(ws);
    }
  });

  it("rejects client registration when the user has no active membership or the client id is unavailable", async () => {
    const userId = uuidv7();
    await app.db.insert(users).values({
      id: userId,
      username: `ws-no-member-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash: "x",
      displayName: "No Membership",
    });
    const noMembershipWs = await openAuthenticatedSocket(await signJwt({ sub: userId, type: "access" }));
    noMembershipWs.send(
      JSON.stringify({ type: "client:register", clientId: `cli-no-member-${crypto.randomUUID().slice(0, 6)}` }),
    );

    await expect(
      waitForFrame(noMembershipWs, (message) => (message as { type?: string }).type === "client:register:rejected"),
    ).resolves.toMatchObject({
      type: "client:register:rejected",
      message: "User has no active organization membership",
    });
    expect(await waitForClose(noMembershipWs)).toBe(4403);

    const owner = await createAdminContext(app, { username: `ws-reg-owner-${crypto.randomUUID().slice(0, 8)}` });
    const other = await createAdminContext(app, { username: `ws-reg-other-${crypto.randomUUID().slice(0, 8)}` });
    const mismatchedClientId = `cli-mismatch-${crypto.randomUUID().slice(0, 6)}`;
    await app.db.insert(clients).values({
      id: mismatchedClientId,
      userId: other.userId,
      organizationId: other.organizationId,
      status: "connected",
    });

    const mismatchWs = await openAuthenticatedSocket(
      await signAccess(owner.userId, owner.memberId, owner.organizationId),
    );
    mismatchWs.send(JSON.stringify({ type: "client:register", clientId: mismatchedClientId }));
    await expect(
      waitForFrame(mismatchWs, (message) => (message as { type?: string }).type === "client:register:rejected"),
    ).resolves.toMatchObject({
      type: "client:register:rejected",
      code: "CLIENT_USER_MISMATCH",
    });
    expect(await waitForClose(mismatchWs)).toBe(4403);

    const retiredClientId = `cli-retired-${crypto.randomUUID().slice(0, 6)}`;
    await app.db.insert(clients).values({
      id: retiredClientId,
      userId: owner.userId,
      organizationId: owner.organizationId,
      status: "disconnected",
      retiredAt: new Date(),
    });
    const retiredWs = await openAuthenticatedSocket(
      await signAccess(owner.userId, owner.memberId, owner.organizationId),
    );
    retiredWs.send(JSON.stringify({ type: "client:register", clientId: retiredClientId }));
    await expect(
      waitForFrame(retiredWs, (message) => (message as { type?: string }).type === "client:register:rejected"),
    ).resolves.toMatchObject({
      type: "client:register:rejected",
      code: "CLIENT_RETIRED",
    });
    expect(await waitForClose(retiredWs)).toBe(4403);
  }, 15000);

  it("keeps client registration accepted when pinned-agent backfill fails", async () => {
    const seed = await createAdminContext(app, { username: `ws-reg-backfill-${crypto.randomUUID().slice(0, 8)}` });
    const backfillSpy = vi
      .spyOn(clientService, "listActiveAgentsPinnedToClient")
      .mockRejectedValueOnce(new Error("backfill failed"));
    const ws = await openAuthenticatedSocket(await signAccess(seed.userId, seed.memberId, seed.organizationId));

    try {
      ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId }));
      await expect(
        waitForFrame(ws, (message) => (message as { type?: string }).type === "client:registered"),
      ).resolves.toMatchObject({ type: "client:registered", clientId: seed.clientId });
      await vi.waitFor(() => expect(backfillSpy).toHaveBeenCalledWith(app.db, seed.clientId));
    } finally {
      await closeSocket(ws);
      backfillSpy.mockRestore();
    }
  });

  it("skips pinned-agent backfill frames that fail wire schema validation", async () => {
    const seed = await createAdminContext(app, {
      username: `ws-reg-invalid-backfill-${crypto.randomUUID().slice(0, 8)}`,
    });
    const backfillSpy = vi.spyOn(clientService, "listActiveAgentsPinnedToClient").mockResolvedValueOnce([
      {
        uuid: uuidv7(),
        name: "invalid-runtime",
        displayName: "Invalid Runtime",
        type: "agent",
        status: "active",
        managerId: seed.memberId,
        createdAt: new Date(),
        runtimeProvider: "not-a-runtime",
      },
    ] as never);
    const ws = await openAuthenticatedSocket(await signAccess(seed.userId, seed.memberId, seed.organizationId));

    try {
      ws.send(JSON.stringify({ type: "client:register", clientId: seed.clientId }));
      await expect(
        waitForFrame(ws, (message) => (message as { type?: string }).type === "client:registered"),
      ).resolves.toMatchObject({ type: "client:registered", clientId: seed.clientId });
      await vi.waitFor(() => expect(backfillSpy).toHaveBeenCalledWith(app.db, seed.clientId));
    } finally {
      await closeSocket(ws);
      backfillSpy.mockRestore();
    }
  });

  it("covers agent bind rejection paths", async () => {
    const seed = await createAdminContext(app, { username: `ws-bind-${crypto.randomUUID().slice(0, 8)}` });
    const other = await createAdminContext(app, { username: `ws-bind-other-${crypto.randomUUID().slice(0, 8)}` });
    const suspended = await createPinnedAgent({ ...seed, suffix: "suspended" });
    const otherOwnerAgent = await createPinnedAgent({ ...other, suffix: "other-owner" });
    const otherClientId = await seedClient(app, seed.userId, seed.organizationId);
    const wrongClientAgent = await createAgent(app.db, {
      name: `ws-edge-wrong-client-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Wrong Client Agent",
      source: "admin-api",
      managerId: seed.memberId,
      clientId: otherClientId,
      organizationId: seed.organizationId,
      runtimeProvider: "claude-code",
    });
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, suspended.uuid));
    const ws = await openRegisteredSocket(seed);

    try {
      await expect(bindAgent(ws, uuidv7(), "bind-unknown")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        ref: "bind-unknown",
        reason: AGENT_BIND_REJECT_REASONS.UNKNOWN_AGENT,
      });
      await expect(bindAgent(ws, suspended.uuid, "bind-suspended")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        ref: "bind-suspended",
        reason: AGENT_BIND_REJECT_REASONS.AGENT_SUSPENDED,
      });
      await expect(bindAgent(ws, otherOwnerAgent.uuid, "bind-not-owned")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        ref: "bind-not-owned",
        reason: AGENT_BIND_REJECT_REASONS.NOT_OWNED,
      });
      await expect(bindAgent(ws, wrongClientAgent.uuid, "bind-wrong-client")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        ref: "bind-wrong-client",
        reason: AGENT_BIND_REJECT_REASONS.WRONG_CLIENT,
      });
    } finally {
      await closeSocket(ws);
    }

    const retiredSeed = await createAdminContext(app, {
      username: `ws-bind-retired-${crypto.randomUUID().slice(0, 8)}`,
    });
    const retiredAgent = await createPinnedAgent({ ...retiredSeed, suffix: "retired-client" });
    const retiredWs = await openRegisteredSocket(retiredSeed);
    try {
      await app.db.update(clients).set({ retiredAt: new Date() }).where(eq(clients.id, retiredSeed.clientId));
      await expect(bindAgent(retiredWs, retiredAgent.uuid, "bind-retired")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        ref: "bind-retired",
        reason: AGENT_BIND_REJECT_REASONS.WRONG_CLIENT,
      });
    } finally {
      await closeSocket(retiredWs);
    }
  }, 20000);

  it("rejects agent bind when the registered client ownership drifts before bind", async () => {
    const seed = await createAdminContext(app, { username: `ws-bind-drift-${crypto.randomUUID().slice(0, 8)}` });
    const other = await createAdminContext(app, { username: `ws-bind-drift-other-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createPinnedAgent({ ...seed, suffix: "ownership-drift" });
    const ws = await openRegisteredSocket(seed);

    try {
      await app.db.update(clients).set({ userId: other.userId }).where(eq(clients.id, seed.clientId));
      await expect(bindAgent(ws, agent.uuid, "bind-client-owner-drift")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        ref: "bind-client-owner-drift",
        reason: AGENT_BIND_REJECT_REASONS.NOT_OWNED,
      });
    } finally {
      await closeSocket(ws);
    }
  });

  it("claims an unbound agent, rejects malformed bind payloads, and unbinds cleanly", async () => {
    const seed = await createAdminContext(app, { username: `ws-bind-ok-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createUnboundAgent({ ...seed, suffix: "claim" });
    const ws = await openRegisteredSocket(seed);

    try {
      ws.send(JSON.stringify({ type: "agent:unbind", agentId: agent.uuid }));
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Agent not bound"),
      ).resolves.toMatchObject({ type: "error", message: "Agent not bound" });

      ws.send(JSON.stringify({ type: "agent:bind", agentId: agent.uuid, ref: "bind-malformed" }));
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string }).type === "error" &&
            typeof (message as { message?: unknown }).message === "string",
        ),
      ).resolves.toMatchObject({ type: "error" });

      await expect(bindAgent(ws, agent.uuid, "bind-claim")).resolves.toMatchObject({
        type: "agent:bound",
        ref: "bind-claim",
        agentId: agent.uuid,
      });
      const [claimed] = await app.db
        .select({ clientId: agents.clientId })
        .from(agents)
        .where(eq(agents.uuid, agent.uuid))
        .limit(1);
      expect(claimed?.clientId).toBe(seed.clientId);

      ws.send(JSON.stringify({ type: "agent:unbind", agentId: agent.uuid }));
      await expect(
        waitForFrame(ws, (message) => (message as { type?: string }).type === "agent:unbound"),
      ).resolves.toMatchObject({
        type: "agent:unbound",
        agentId: agent.uuid,
      });
    } finally {
      await closeSocket(ws);
    }
  }, 15000);

  it("reuses a presented runtime session token on same-client rebind", async () => {
    const seed = await createAdminContext(app, { username: `ws-bind-reuse-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createPinnedAgent({ ...seed, suffix: "reuse" });
    const ws = await openRegisteredSocket(seed);

    try {
      const first = await bindAgent(ws, agent.uuid, "bind-reuse-first");
      expect(first.type).toBe("agent:bound");
      expect(first.runtimeSessionToken).toEqual(expect.any(String));

      ws.send(
        JSON.stringify({
          type: "agent:bind",
          agentId: agent.uuid,
          ref: "bind-reuse-second",
          runtimeType: "claude-code",
          runtimeVersion: "edge-test",
          currentRuntimeSessionToken: first.runtimeSessionToken,
        }),
      );
      const second = (await waitForFrame(
        ws,
        (message) =>
          (message as { type?: string; ref?: string }).type === "agent:bound" &&
          (message as { ref?: string }).ref === "bind-reuse-second",
      )) as { type?: string; ref?: string; agentId?: string; runtimeSessionToken?: string };

      expect(second).toMatchObject({
        type: "agent:bound",
        ref: "bind-reuse-second",
        agentId: agent.uuid,
      });
      expect(second).not.toHaveProperty("runtimeSessionToken");
    } finally {
      await closeSocket(ws);
    }
  }, 15000);

  it("rejects bind when runtime session or presence publication fails", async () => {
    const runtimeSeed = await createAdminContext(app, {
      username: `ws-bind-runtime-${crypto.randomUUID().slice(0, 8)}`,
    });
    const runtimeAgent = await createPinnedAgent({ ...runtimeSeed, suffix: "runtime-fail" });
    const runtimeWs = await openRegisteredSocket(runtimeSeed);
    const runtimeSpy = vi
      .spyOn(agentRuntimeSessionService, "bindAgentRuntimeSession")
      .mockRejectedValueOnce(new Error("runtime claim failed"));
    try {
      await expect(bindAgent(runtimeWs, runtimeAgent.uuid, "bind-runtime-fail")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        reason: AGENT_BIND_REJECT_REASONS.WRONG_CLIENT,
      });
      expect(runtimeSpy).toHaveBeenCalled();
    } finally {
      await closeSocket(runtimeWs);
      runtimeSpy.mockRestore();
    }

    const presenceSeed = await createAdminContext(app, {
      username: `ws-bind-presence-${crypto.randomUUID().slice(0, 8)}`,
    });
    const presenceAgent = await createPinnedAgent({ ...presenceSeed, suffix: "presence-fail" });
    const presenceWs = await openRegisteredSocket(presenceSeed);
    const reusedRuntimeSpy = vi.spyOn(agentRuntimeSessionService, "bindAgentRuntimeSession").mockResolvedValueOnce({
      token: "reused-runtime-token",
      reused: true,
    });
    const revokeSpy = vi
      .spyOn(agentRuntimeSessionService, "revokeAgentRuntimeSessionIfTokenMatches")
      .mockResolvedValueOnce(true);
    const presenceSpy = vi.spyOn(presenceService, "bindAgentIfActiveClient").mockResolvedValueOnce(false);
    try {
      await expect(bindAgent(presenceWs, presenceAgent.uuid, "bind-presence-fail")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        reason: AGENT_BIND_REJECT_REASONS.WRONG_CLIENT,
      });
      expect(reusedRuntimeSpy).toHaveBeenCalled();
      expect(presenceSpy).toHaveBeenCalled();
      expect(revokeSpy).not.toHaveBeenCalled();
    } finally {
      await closeSocket(presenceWs);
      reusedRuntimeSpy.mockRestore();
      revokeSpy.mockRestore();
      presenceSpy.mockRestore();
    }
  }, 15000);

  it("rejects bind when the active client socket changes during binding", async () => {
    const seed = await createAdminContext(app, {
      username: `ws-bind-active-drift-${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await createPinnedAgent({ ...seed, suffix: "active-drift" });
    const ws = await openRegisteredSocket(seed);
    const activeSpy = vi.spyOn(connectionManager, "isActiveClientConnection");
    const reusedRuntimeSpy = vi.spyOn(agentRuntimeSessionService, "bindAgentRuntimeSession").mockResolvedValueOnce({
      token: "reused-runtime-token",
      reused: true,
    });
    const revokeSpy = vi
      .spyOn(agentRuntimeSessionService, "revokeAgentRuntimeSessionIfTokenMatches")
      .mockResolvedValueOnce(true);

    try {
      activeSpy.mockReturnValueOnce(false);
      await expect(bindAgent(ws, agent.uuid, "bind-active-drift-before-session")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        ref: "bind-active-drift-before-session",
        reason: AGENT_BIND_REJECT_REASONS.WRONG_CLIENT,
      });

      activeSpy.mockReturnValueOnce(true).mockReturnValueOnce(false);
      await expect(bindAgent(ws, agent.uuid, "bind-active-drift-after-presence")).resolves.toMatchObject({
        type: "agent:bind:rejected",
        ref: "bind-active-drift-after-presence",
        reason: AGENT_BIND_REJECT_REASONS.WRONG_CLIENT,
      });
      expect(reusedRuntimeSpy).toHaveBeenCalledTimes(1);
      expect(revokeSpy).not.toHaveBeenCalled();
    } finally {
      await closeSocket(ws);
      activeSpy.mockRestore();
      reusedRuntimeSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  }, 15000);

  it("logs bind recovery reset outcomes and ignores stale unbinds after route drift", async () => {
    const seed = await createAdminContext(app, { username: `ws-bind-reset-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createPinnedAgent({ ...seed, suffix: "reset" });
    const ws = await openRegisteredSocket(seed);
    const resetSpy = vi.spyOn(inboxService, "resetDeliveredForInboxes").mockResolvedValueOnce(1);

    try {
      await expect(bindAgent(ws, agent.uuid, "bind-reset-count")).resolves.toMatchObject({
        type: "agent:bound",
        ref: "bind-reset-count",
        agentId: agent.uuid,
      });
      expect(resetSpy).toHaveBeenCalledWith(app.db, [agent.inboxId]);

      const otherClientId = await seedClient(app, seed.userId, seed.organizationId);
      await app.db.update(agents).set({ clientId: otherClientId }).where(eq(agents.uuid, agent.uuid));
      ws.send(JSON.stringify({ type: "agent:unbind", agentId: agent.uuid }));
      await expect(
        waitForFrame(ws, (message) => (message as { type?: string }).type === "agent:unbound"),
      ).resolves.toMatchObject({ type: "agent:unbound", agentId: agent.uuid });
    } finally {
      await closeSocket(ws);
      resetSpy.mockRestore();
    }

    const errorSeed = await createAdminContext(app, {
      username: `ws-bind-reset-error-${crypto.randomUUID().slice(0, 8)}`,
    });
    const errorAgent = await createPinnedAgent({ ...errorSeed, suffix: "reset-error" });
    const errorWs = await openRegisteredSocket(errorSeed);
    const resetErrorSpy = vi
      .spyOn(inboxService, "resetDeliveredForInboxes")
      .mockRejectedValueOnce(new Error("reset failed"));
    try {
      await expect(bindAgent(errorWs, errorAgent.uuid, "bind-reset-error")).resolves.toMatchObject({
        type: "agent:bound",
        ref: "bind-reset-error",
        agentId: errorAgent.uuid,
      });
      expect(resetErrorSpy).toHaveBeenCalledWith(app.db, [errorAgent.inboxId]);
    } finally {
      await closeSocket(errorWs);
      resetErrorSpy.mockRestore();
    }
  }, 20000);

  it("self-validates inbox delivery frames and clears in-flight entries after ack", async () => {
    const seed = await createAdminContext(app, {
      username: `ws-inbox-deliver-invalid-${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await createPinnedAgent({ ...seed, suffix: "invalid-deliver" });
    const entryId = 444_000_001;
    const claimSpy = vi
      .spyOn(inboxService, "claimBacklogForPushFair")
      .mockResolvedValueOnce([
        {
          id: entryId,
          inboxId: agent.inboxId,
          messageId: "msg-invalid-deliver",
          chatId: "chat-invalid-deliver",
          status: "delivered",
          retryCount: 0,
          createdAt: new Date().toISOString(),
          deliveredAt: new Date().toISOString(),
          ackedAt: null,
          message: null,
        },
      ] as never)
      .mockResolvedValue([]);
    const ackSpy = vi.spyOn(inboxService, "ackEntryByIdForBoundAgents").mockResolvedValueOnce({
      ok: true,
      throughEntry: { id: entryId, inboxId: agent.inboxId, chatId: "chat-invalid-deliver" },
      disposition: "acked",
      ackedCount: 1,
      ackedEntryIds: [entryId],
    } as never);
    const ws = await openRegisteredSocket(seed);

    try {
      await expect(bindAgent(ws, agent.uuid, "bind-invalid-deliver")).resolves.toMatchObject({
        type: "agent:bound",
        agentId: agent.uuid,
      });
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; entryId?: number }).type === "inbox:deliver" &&
            (message as { entryId?: number }).entryId === entryId,
        ),
      ).resolves.toMatchObject({
        type: "inbox:deliver",
        entryId,
        inboxId: agent.inboxId,
        message: null,
      });

      ws.send(JSON.stringify({ type: "inbox:ack", entryId, ref: "ack-invalid-deliver" }));
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "inbox:ack:accepted" &&
            (message as { ref?: string }).ref === "ack-invalid-deliver",
        ),
      ).resolves.toMatchObject({
        type: "inbox:ack:accepted",
        entryId,
        ref: "ack-invalid-deliver",
        disposition: "acked",
        ackedCount: 1,
      });
      expect(claimSpy).toHaveBeenCalled();
      expect(ackSpy).toHaveBeenCalledWith(app.db, entryId, [agent.inboxId]);
    } finally {
      await closeSocket(ws);
      claimSpy.mockRestore();
      ackSpy.mockRestore();
    }
  }, 15000);

  it("keeps bind successful when the post-bind inbox backlog claim fails", async () => {
    const seed = await createAdminContext(app, {
      username: `ws-inbox-claim-fail-${crypto.randomUUID().slice(0, 8)}`,
    });
    const agent = await createPinnedAgent({ ...seed, suffix: "claim-fail" });
    const claimSpy = vi
      .spyOn(inboxService, "claimBacklogForPushFair")
      .mockRejectedValueOnce(new Error("claim backlog failed"));
    const ws = await openRegisteredSocket(seed);

    try {
      await expect(bindAgent(ws, agent.uuid, "bind-claim-fail")).resolves.toMatchObject({
        type: "agent:bound",
        agentId: agent.uuid,
      });
      await vi.waitFor(() => expect(claimSpy).toHaveBeenCalled());
    } finally {
      await closeSocket(ws);
      claimSpy.mockRestore();
    }
  }, 15000);

  it("leaves inbox backlog pending when the global in-flight cap is full", async () => {
    await withInboxCappedApp({ maxInFlightPerAgent: 1, maxInFlightPerAgentChat: 1 }, async (targetApp, targetWsUrl) => {
      const seed = await createAdminContext(targetApp, {
        username: `ws-global-cap-${crypto.randomUUID().slice(0, 8)}`,
      });
      const agent = await createPinnedAgentFor(targetApp, { ...seed, suffix: "global-cap" });
      const warnSpy = vi.spyOn(targetApp.log, "warn");
      const claimSpy = vi
        .spyOn(inboxService, "claimBacklogForPushFair")
        .mockResolvedValueOnce([inboxEntry(555_000_001, agent.inboxId, "chat-global-cap")] as never)
        .mockResolvedValue([]);
      const ws = await openRegisteredSocketAt(targetWsUrl, seed);

      try {
        await expect(bindAgent(ws, agent.uuid, "bind-global-cap")).resolves.toMatchObject({
          type: "agent:bound",
          agentId: agent.uuid,
        });
        await expect(
          waitForFrame(
            ws,
            (message) =>
              (message as { type?: string; entryId?: number }).type === "inbox:deliver" &&
              (message as { entryId?: number }).entryId === 555_000_001,
          ),
        ).resolves.toMatchObject({ type: "inbox:deliver", entryId: 555_000_001 });

        await targetApp.notifier.notify(agent.inboxId, "msg-global-cap");
        await vi.waitFor(() =>
          expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: agent.uuid, inboxId: agent.inboxId, globalCap: 1 }),
            "inbox push: global in-flight fuse reached, leaving backlog pending",
          ),
        );
        expect(claimSpy).toHaveBeenCalledTimes(1);
      } finally {
        await closeSocket(ws);
        warnSpy.mockRestore();
        claimSpy.mockRestore();
      }
    });
  }, 20000);

  it("leaves recovery backlog pending when the requested chat is already at its per-chat cap", async () => {
    await withInboxCappedApp({ maxInFlightPerAgent: 2, maxInFlightPerAgentChat: 1 }, async (targetApp, targetWsUrl) => {
      const seed = await createAdminContext(targetApp, {
        username: `ws-chat-cap-${crypto.randomUUID().slice(0, 8)}`,
      });
      const agent = await createPinnedAgentFor(targetApp, { ...seed, suffix: "chat-cap" });
      const debugSpy = vi.spyOn(targetApp.log, "debug");
      const claimSpy = vi
        .spyOn(inboxService, "claimBacklogForPushFair")
        .mockResolvedValueOnce([inboxEntry(555_000_002, agent.inboxId, "chat-per-cap")] as never)
        .mockResolvedValue([]);
      const recoverSpy = vi.spyOn(inboxService, "recoverUnackedForScope").mockResolvedValueOnce({
        resetCount: 0,
        resetEntryIds: [],
      } as never);
      const ws = await openRegisteredSocketAt(targetWsUrl, seed);

      try {
        await expect(bindAgent(ws, agent.uuid, "bind-chat-cap")).resolves.toMatchObject({
          type: "agent:bound",
          agentId: agent.uuid,
        });
        await waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; entryId?: number }).type === "inbox:deliver" &&
            (message as { entryId?: number }).entryId === 555_000_002,
        );

        ws.send(
          JSON.stringify({
            type: "inbox:recover",
            ref: "recover-chat-cap",
            agentId: agent.uuid,
            chatId: "chat-per-cap",
          }),
        );
        await expect(
          waitForFrame(
            ws,
            (message) =>
              (message as { type?: string; ref?: string }).type === "inbox:recover:accepted" &&
              (message as { ref?: string }).ref === "recover-chat-cap",
          ),
        ).resolves.toMatchObject({ type: "inbox:recover:accepted", ref: "recover-chat-cap", resetCount: 0 });

        await vi.waitFor(() =>
          expect(debugSpy).toHaveBeenCalledWith(
            expect.objectContaining({
              agentId: agent.uuid,
              inboxId: agent.inboxId,
              chatId: "chat-per-cap",
              chatCap: 1,
            }),
            "inbox push: recovery chat at per-chat cap, leaving backlog pending",
          ),
        );
        expect(claimSpy).toHaveBeenCalledTimes(1);
        expect(recoverSpy).toHaveBeenCalledWith(targetApp.db, { inboxId: agent.inboxId, chatId: "chat-per-cap" });
      } finally {
        await closeSocket(ws);
        debugSpy.mockRestore();
        claimSpy.mockRestore();
        recoverSpy.mockRestore();
      }
    });
  }, 20000);

  it("handles bound session, runtime, inbox, recover, and heartbeat edge frames", async () => {
    const seed = await createAdminContext(app, { username: `ws-bound-edges-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createPinnedAgent({ ...seed, suffix: "bound-edges" });
    const ws = await openRegisteredSocket(seed);

    try {
      await expect(bindAgent(ws, agent.uuid, "bind-bound-edges")).resolves.toMatchObject({ type: "agent:bound" });

      ws.send(
        JSON.stringify({ type: "session:state", agentId: agent.uuid, chatId: "chat-state-invalid", state: "evicted" }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { message?: string }).message ===
            "Unsupported session state from client; client upgrade required",
        ),
      ).resolves.toMatchObject({
        type: "error",
        message: "Unsupported session state from client; client upgrade required",
      });

      const stateSpy = vi
        .spyOn(activityService, "upsertSessionState")
        .mockRejectedValueOnce(new Error("state persist failed"));
      ws.send(
        JSON.stringify({ type: "session:state", agentId: agent.uuid, chatId: "chat-state-fail", state: "active" }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { message?: string }).message === "Failed to persist session state: state persist failed",
        ),
      ).resolves.toMatchObject({
        type: "error",
        message: "Failed to persist session state: state persist failed",
      });
      expect(stateSpy).toHaveBeenCalled();

      stateSpy.mockRejectedValueOnce("state string failure" as never);
      ws.send(
        JSON.stringify({
          type: "session:state",
          agentId: agent.uuid,
          chatId: "chat-state-string-fail",
          state: "active",
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { message?: string }).message === "Failed to persist session state: state string failure",
        ),
      ).resolves.toMatchObject({
        type: "error",
        message: "Failed to persist session state: state string failure",
      });

      ws.send(JSON.stringify({ type: "session:runtime", agentId: agent.uuid, runtimeState: "working" }));
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Malformed session:runtime frame"),
      ).resolves.toMatchObject({ type: "error", message: "Malformed session:runtime frame" });

      const runtimeSpy = vi
        .spyOn(activityService, "setSessionRuntime")
        .mockRejectedValueOnce(new Error("runtime persist failed"));
      ws.send(
        JSON.stringify({
          type: "session:runtime",
          agentId: agent.uuid,
          chatId: "chat-runtime-fail",
          runtimeState: "working",
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { message?: string }).message === "Failed to persist session runtime: runtime persist failed",
        ),
      ).resolves.toMatchObject({
        type: "error",
        message: "Failed to persist session runtime: runtime persist failed",
      });
      expect(runtimeSpy).toHaveBeenCalled();

      runtimeSpy.mockRejectedValueOnce("runtime string failure" as never);
      ws.send(
        JSON.stringify({
          type: "session:runtime",
          agentId: agent.uuid,
          chatId: "chat-runtime-string-fail",
          runtimeState: "working",
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { message?: string }).message === "Failed to persist session runtime: runtime string failure",
        ),
      ).resolves.toMatchObject({
        type: "error",
        message: "Failed to persist session runtime: runtime string failure",
      });

      ws.send(
        JSON.stringify({
          type: "session:runtime",
          agentId: uuidv7(),
          chatId: "chat-runtime-unbound",
          runtimeState: "working",
        }),
      );
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Agent not bound"),
      ).resolves.toMatchObject({ type: "error", message: "Agent not bound" });

      ws.send(JSON.stringify({ type: "session:reconcile", agentId: agent.uuid }));
      await expect(
        waitForFrame(
          ws,
          (message) => (message as { message?: string }).message === "Malformed session:reconcile frame",
        ),
      ).resolves.toMatchObject({ type: "error", message: "Malformed session:reconcile frame" });

      ws.send(JSON.stringify({ type: "session:reconcile", agentId: agent.uuid, chatIds: [] }));
      await expect(
        waitForFrame(ws, (message) => (message as { type?: string }).type === "session:reconcile:result"),
      ).resolves.toMatchObject({
        type: "session:reconcile:result",
        agentId: agent.uuid,
        staleChatIds: [],
      });

      ws.send(JSON.stringify({ type: "session:reconcile", agentId: uuidv7(), chatIds: ["chat-reconcile-unbound"] }));
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Agent not bound"),
      ).resolves.toMatchObject({ type: "error", message: "Agent not bound" });

      const notifySpy = vi.spyOn(notificationService, "notifyAgentEvent").mockResolvedValue(undefined);
      const resolvedSpy = vi.spyOn(notificationService, "markAgentFaultsResolved").mockResolvedValue(undefined);
      ws.send(JSON.stringify({ type: "runtime:state", agentId: agent.uuid, runtimeState: "error" }));
      ws.send(JSON.stringify({ type: "runtime:state", agentId: agent.uuid, runtimeState: "blocked" }));
      ws.send(JSON.stringify({ type: "runtime:state", agentId: agent.uuid, runtimeState: "idle" }));
      ws.send(JSON.stringify({ type: "runtime:state", agentId: agent.uuid, runtimeState: "working" }));
      ws.send(JSON.stringify({ type: "heartbeat" }));
      await expect(
        waitForFrame(ws, (message) => (message as { type?: string }).type === "heartbeat:ack"),
      ).resolves.toEqual({
        type: "heartbeat:ack",
      });
      expect(notifySpy).toHaveBeenCalledWith(app.db, agent.uuid, "agent_error", "high");
      expect(notifySpy).toHaveBeenCalledWith(app.db, agent.uuid, "agent_blocked", "medium");
      expect(resolvedSpy).toHaveBeenCalledWith(app.db, agent.uuid);

      const runtimeStateSpy = vi
        .spyOn(presenceService, "setRuntimeState")
        .mockRejectedValueOnce("runtime state failed" as never);
      ws.send(JSON.stringify({ type: "runtime:state", agentId: agent.uuid, runtimeState: "idle" }));
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Internal error"),
      ).resolves.toMatchObject({ type: "error", message: "Internal error" });
      expect(runtimeStateSpy).toHaveBeenCalled();

      ws.send(JSON.stringify({ type: "runtime:state", agentId: uuidv7(), runtimeState: "idle" }));
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Agent not bound"),
      ).resolves.toMatchObject({ type: "error", message: "Agent not bound" });

      ws.send(
        JSON.stringify({
          type: "session:event",
          ref: "event-unbound",
          agentId: uuidv7(),
          chatId: "chat-event",
          event: { kind: "thinking", payload: {} },
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "session:event:rejected" &&
            (message as { ref?: string }).ref === "event-unbound",
        ),
      ).resolves.toMatchObject({ type: "session:event:rejected", ref: "event-unbound", reason: "agent_not_bound" });

      ws.send(
        JSON.stringify({
          type: "session:event",
          ref: "event-malformed",
          agentId: agent.uuid,
          chatId: "chat-event",
          event: { kind: "unknown", payload: {} },
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "session:event:rejected" &&
            (message as { ref?: string }).ref === "event-malformed",
        ),
      ).resolves.toMatchObject({
        type: "session:event:rejected",
        ref: "event-malformed",
        agentId: agent.uuid,
        chatId: "chat-event",
        reason: "malformed",
      });

      ws.send(
        JSON.stringify({
          type: "session:event",
          ref: "event-malformed-no-chat",
          agentId: agent.uuid,
          chatId: 123,
          event: { kind: "unknown", payload: {} },
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "session:event:rejected" &&
            (message as { ref?: string }).ref === "event-malformed-no-chat",
        ),
      ).resolves.toMatchObject({
        type: "session:event:rejected",
        ref: "event-malformed-no-chat",
        agentId: agent.uuid,
        reason: "malformed",
      });

      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: agent.uuid,
          chatId: "chat-event",
          event: { kind: "unknown", payload: {} },
        }),
      );
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Malformed session:event frame"),
      ).resolves.toMatchObject({ type: "error", message: "Malformed session:event frame" });

      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: uuidv7(),
          chatId: "chat-event",
          event: { kind: "thinking", payload: {} },
        }),
      );
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Agent not bound"),
      ).resolves.toMatchObject({ type: "error", message: "Agent not bound" });

      const eventSpy = vi
        .spyOn(sessionEventService, "appendEvent")
        .mockRejectedValueOnce(new Error("event persist failed"));
      ws.send(
        JSON.stringify({
          type: "session:event",
          ref: "event-persist-fail",
          agentId: agent.uuid,
          chatId: "chat-event",
          event: { kind: "error", payload: { source: "runtime", message: "boom" } },
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "session:event:rejected" &&
            (message as { ref?: string }).ref === "event-persist-fail",
        ),
      ).resolves.toMatchObject({
        type: "session:event:rejected",
        ref: "event-persist-fail",
        reason: "persist_failed",
      });
      expect(eventSpy).toHaveBeenCalled();

      const eventNoRefSpy = vi
        .spyOn(sessionEventService, "appendEvent")
        .mockRejectedValueOnce(new Error("event persist failed without ref"));
      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: agent.uuid,
          chatId: "chat-event",
          event: { kind: "error", payload: { source: "runtime", message: "boom" } },
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            typeof (message as { message?: unknown }).message === "string" &&
            (message as { message: string }).message.includes("event persist failed without ref"),
        ),
      ).resolves.toMatchObject({
        type: "error",
        message: "Failed to persist session event: event persist failed without ref",
      });
      expect(eventNoRefSpy).toHaveBeenCalled();

      eventNoRefSpy.mockRejectedValueOnce("event string failure" as never);
      ws.send(
        JSON.stringify({
          type: "session:event",
          agentId: agent.uuid,
          chatId: "chat-event",
          event: { kind: "error", payload: { source: "runtime", message: "boom" } },
        }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { message?: string }).message === "Failed to persist session event: event string failure",
        ),
      ).resolves.toMatchObject({
        type: "error",
        message: "Failed to persist session event: event string failure",
      });

      ws.send(JSON.stringify({ type: "inbox:ack", entryId: -1, ref: "ack-malformed" }));
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Malformed inbox:ack frame"),
      ).resolves.toMatchObject({ type: "error", message: "Malformed inbox:ack frame" });

      const ackThrowSpy = vi
        .spyOn(inboxService, "ackEntryByIdForBoundAgents")
        .mockRejectedValueOnce(new Error("ack db failed"));
      ws.send(JSON.stringify({ type: "inbox:ack", entryId: 888_888_888, ref: "ack-throws" }));
      await vi.waitFor(() => expect(ackThrowSpy).toHaveBeenCalledWith(app.db, 888_888_888, [agent.inboxId]));

      const ackOwnerFallbackSpy = vi.spyOn(inboxService, "ackEntryByIdForBoundAgents").mockResolvedValueOnce({
        ok: true,
        throughEntry: { id: 777_777_777, inboxId: "foreign-inbox", chatId: "foreign-chat" },
        disposition: "acked",
        ackedCount: 1,
        ackedEntryIds: [777_777_777],
      } as never);
      ws.send(JSON.stringify({ type: "inbox:ack", entryId: 777_777_777, ref: "ack-owner-fallback" }));
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "inbox:ack:accepted" &&
            (message as { ref?: string }).ref === "ack-owner-fallback",
        ),
      ).resolves.toMatchObject({
        type: "inbox:ack:accepted",
        entryId: 777_777_777,
        ref: "ack-owner-fallback",
        disposition: "acked",
      });
      expect(ackOwnerFallbackSpy).toHaveBeenCalledWith(app.db, 777_777_777, [agent.inboxId]);

      ws.send(JSON.stringify({ type: "inbox:ack", entryId: 999_999_999, ref: "ack-missing" }));
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "inbox:ack:rejected" &&
            (message as { ref?: string }).ref === "ack-missing",
        ),
      ).resolves.toMatchObject({ type: "inbox:ack:rejected", entryId: 999_999_999, ref: "ack-missing" });

      ws.send(JSON.stringify({ type: "inbox:recover", ref: "recover-malformed", agentId: agent.uuid }));
      await expect(
        waitForFrame(ws, (message) => (message as { message?: string }).message === "Malformed inbox:recover frame"),
      ).resolves.toMatchObject({ type: "error", message: "Malformed inbox:recover frame" });

      ws.send(
        JSON.stringify({ type: "inbox:recover", ref: "recover-unbound", agentId: uuidv7(), chatId: "chat-recover" }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "inbox:recover:rejected" &&
            (message as { ref?: string }).ref === "recover-unbound",
        ),
      ).resolves.toMatchObject({ type: "inbox:recover:rejected", ref: "recover-unbound", reason: "agent_not_bound" });

      ws.send(
        JSON.stringify({ type: "inbox:recover", ref: "recover-ok", agentId: agent.uuid, chatId: "chat-recover" }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "inbox:recover:accepted" &&
            (message as { ref?: string }).ref === "recover-ok",
        ),
      ).resolves.toMatchObject({
        type: "inbox:recover:accepted",
        ref: "recover-ok",
        agentId: agent.uuid,
        chatId: "chat-recover",
        resetCount: 0,
      });

      const recoverSpy = vi
        .spyOn(inboxService, "recoverUnackedForScope")
        .mockRejectedValueOnce(new Error("recover failed"));
      ws.send(
        JSON.stringify({ type: "inbox:recover", ref: "recover-fail", agentId: agent.uuid, chatId: "chat-recover" }),
      );
      await expect(
        waitForFrame(
          ws,
          (message) =>
            (message as { type?: string; ref?: string }).type === "inbox:recover:rejected" &&
            (message as { ref?: string }).ref === "recover-fail",
        ),
      ).resolves.toMatchObject({ type: "inbox:recover:rejected", ref: "recover-fail", reason: "recover_failed" });
      expect(recoverSpy).toHaveBeenCalled();
    } finally {
      await closeSocket(ws);
    }
  }, 30000);
});
