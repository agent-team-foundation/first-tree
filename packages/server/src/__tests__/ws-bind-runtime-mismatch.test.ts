import { AGENT_BIND_REJECT_REASONS } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * The bind handshake compares `bindRequest.runtimeType` against
 * `agents.runtime_provider`; a drift triggers
 * `agent:bind:rejected { reason: "runtime_provider_mismatch" }` so the
 * client repair path can re-fetch authoritative state and respawn the
 * right handler. This test pins that contract — without it, a regression
 * silently lets a claude-code client bind to a codex-pinned agent (or
 * vice versa) and we'd only notice at the first message.
 */
describe("Agent WS — runtime provider mismatch on bind", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signMemberJwt(userId: string, memberId: string, orgId: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: userId, memberId, organizationId: orgId, role: "admin", type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  async function seedCodexAgent(suffix: string) {
    const orgId = await resolveDefaultOrgId(app.db);
    const userId = uuidv7();
    const memberId = uuidv7();
    const clientId = `cli-rtmm-${suffix}-${crypto.randomUUID().slice(0, 6)}`;

    const agent = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `rtmm-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: "Mismatch Tester",
      });

      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `rtmm-human-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Mismatch Human",
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
      });

      await tx
        .insert(members)
        .values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role: "admin" });
      await tx.insert(clients).values({ id: clientId, userId, organizationId: orgId, status: "connected" });

      // The capability gate would normally block creating a codex agent
      // against a client that hasn't reported codex availability. We
      // bypass it with `force: true` because this test isn't about the
      // gate — it's about the bind-time mismatch detection.
      return createAgent(
        tx as unknown as typeof app.db,
        {
          name: `rtmm-codex-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
          type: "agent",
          displayName: "Codex Agent",
          source: "admin-api",
          managerId: memberId,
          clientId,
          organizationId: orgId,
          runtimeProvider: "codex",
        },
        { force: true },
      );
    });

    const token = await signMemberJwt(userId, memberId, orgId);
    return { agent, token, clientId };
  }

  // Like seedCodexAgent, but leaves the agent UNBOUND (clientId null) so the
  // WS first-bind claim path is exercised. The client is seeded + connected so
  // a bind attempt can be made from it.
  async function seedUnboundCodexAgent(suffix: string) {
    const orgId = await resolveDefaultOrgId(app.db);
    const userId = uuidv7();
    const memberId = uuidv7();
    const clientId = `cli-rtmm-unb-${suffix}-${crypto.randomUUID().slice(0, 6)}`;

    const agent = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `rtmm-unb-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: "Mismatch Tester",
      });

      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `rtmm-unb-human-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Mismatch Human",
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
      });

      await tx
        .insert(members)
        .values({ id: memberId, userId, organizationId: orgId, agentId: human.uuid, role: "admin" });
      await tx.insert(clients).values({ id: clientId, userId, organizationId: orgId, status: "connected" });

      // No clientId on the agent → unbound. The create-time capability gate
      // short-circuits (clientId null), so the codex agent is created freely.
      return createAgent(tx as unknown as typeof app.db, {
        name: `rtmm-unb-codex-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        displayName: "Codex Agent",
        source: "admin-api",
        managerId: memberId,
        organizationId: orgId,
        runtimeProvider: "codex",
      });
    });

    const token = await signMemberJwt(userId, memberId, orgId);
    return { agent, token, clientId };
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
          // ignore non-JSON frames
        }
      };
      ws.on("message", onMessage);
    });
  }

  async function openClientSocket(seed: { token: string; clientId: string }): Promise<WebSocket> {
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

  it("rejects bind when bindRequest.runtimeType differs from agents.runtime_provider", async () => {
    const seed = await seedCodexAgent("rej");
    const ws = await openClientSocket(seed);

    try {
      ws.send(
        JSON.stringify({
          type: "agent:bind",
          agentId: seed.agent.uuid,
          ref: "bind-mismatch",
          runtimeType: "claude-code", // <- agent is `codex` in DB
          runtimeVersion: "0.0.0",
        }),
      );

      const msg = (await waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:bind:rejected")) as {
        type: string;
        ref: string;
        reason: string;
      };

      expect(msg.ref).toBe("bind-mismatch");
      expect(msg.reason).toBe(AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH);

      // Confirm the agent did not transition to bound — DB stays
      // unbound, so a follow-up bind with the right runtime can succeed.
      const [row] = await app.db
        .select({ clientId: agents.clientId })
        .from(agents)
        .where(eq(agents.uuid, seed.agent.uuid))
        .limit(1);
      expect(row?.clientId).toBe(seed.clientId); // pinned, not yet "presence-bound" (presence is separate)
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("accepts bind once runtimeType matches the pinned runtime_provider", async () => {
    const seed = await seedCodexAgent("ok");
    const ws = await openClientSocket(seed);

    try {
      ws.send(
        JSON.stringify({
          type: "agent:bind",
          agentId: seed.agent.uuid,
          ref: "bind-match",
          runtimeType: "codex",
          runtimeVersion: "0.0.0",
        }),
      );

      const msg = (await waitForFrame(ws, (m) => {
        const t = (m as { type?: string }).type;
        return t === "agent:bound" || t === "agent:bind:rejected";
      })) as { type: string; ref: string; reason?: string };

      expect(msg.type).toBe("agent:bound");
      expect(msg.ref).toBe("bind-match");
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("does NOT claim an unbound agent when the first bind's runtimeType mismatches", async () => {
    const seed = await seedUnboundCodexAgent("noclaim");
    expect(seed.agent.clientId).toBeNull();
    const ws = await openClientSocket(seed);

    try {
      ws.send(
        JSON.stringify({
          type: "agent:bind",
          agentId: seed.agent.uuid,
          ref: "bind-firstbind-mismatch",
          runtimeType: "claude-code", // <- agent is `codex` in DB
          runtimeVersion: "0.0.0",
        }),
      );

      const msg = (await waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:bind:rejected")) as {
        ref: string;
        reason: string;
      };
      expect(msg.ref).toBe("bind-firstbind-mismatch");
      expect(msg.reason).toBe(AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH);

      // The mismatch must be checked BEFORE the first-bind claim: the agent
      // stays unbound so a correctly-running client can still bind it later.
      // With re-bind removed, a wrong first pin would be unrecoverable.
      const [row] = await app.db
        .select({ clientId: agents.clientId })
        .from(agents)
        .where(eq(agents.uuid, seed.agent.uuid))
        .limit(1);
      expect(row?.clientId).toBeNull();
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);
});
