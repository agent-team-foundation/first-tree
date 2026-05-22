import { AGENT_BIND_REJECT_REASONS } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * Bind R-RUN under decouple-client-from-identity §4.3:
 *   - Same user across multiple organizations may bind agents from any of
 *     them on a single socket; org binding is no longer compared.
 *   - A manager whose membership flips to `inactive` cannot start new binds
 *     (existing binds keep running until unbind / socket close).
 */
describe("Agent WS — multi-org bind under one user", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signJwt(userId: string, memberId: string, orgId: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: userId, memberId, organizationId: orgId, role: "member", type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
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

  async function openClientSocket(token: string, clientId: string): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok");
    ws.send(JSON.stringify({ type: "client:register", clientId }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "client:registered");
    return ws;
  }

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
   * Seed: a single user with active memberships in two orgs (default + new),
   * plus one autonomous agent in each org pinned to a single shared client.
   * Returns everything the bind tests need to drive WS frames.
   */
  async function seedDualOrgUser(suffix: string) {
    const orgA = await resolveDefaultOrgId(app.db);
    const userId = uuidv7();
    const memberAId = uuidv7();
    const memberBId = uuidv7();
    const orgBId = `org-mo-${suffix}-${crypto.randomUUID().slice(0, 6)}`;
    const clientId = `cli-mo-${suffix}-${crypto.randomUUID().slice(0, 6)}`;

    const result = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `mo-user-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: "Multi Org User",
      });
      await tx.insert(organizations).values({ id: orgBId, name: `mo-org-${suffix}`, displayName: `MO Org ${suffix}` });

      const humanA = await createAgent(tx as unknown as typeof app.db, {
        name: `mo-human-a-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Human A",
        managerId: memberAId,
        organizationId: orgA,
      });
      const humanB = await createAgent(tx as unknown as typeof app.db, {
        name: `mo-human-b-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "Human B",
        managerId: memberBId,
        organizationId: orgBId,
      });

      await tx.insert(members).values([
        { id: memberAId, userId, organizationId: orgA, agentId: humanA.uuid, role: "member" },
        { id: memberBId, userId, organizationId: orgBId, agentId: humanB.uuid, role: "member" },
      ]);
      // organizationId on clients is now a vestigial placeholder — orgA fits.
      await tx.insert(clients).values({ id: clientId, userId, organizationId: orgA, status: "connected" });

      const agentA = await createAgent(tx as unknown as typeof app.db, {
        name: `mo-bot-a-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: "Bot A",
        managerId: memberAId,
        clientId,
        organizationId: orgA,
      });
      const agentB = await createAgent(tx as unknown as typeof app.db, {
        name: `mo-bot-b-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "autonomous_agent",
        displayName: "Bot B",
        managerId: memberBId,
        clientId,
        organizationId: orgBId,
      });
      return { userId, memberAId, memberBId, orgA, orgBId, clientId, agentA, agentB };
    });
    const token = await signJwt(result.userId, result.memberAId, result.orgA);
    return { ...result, token };
  }

  it("binds agents from two organizations on the same socket", async () => {
    const seed = await seedDualOrgUser("ok");
    const ws = await openClientSocket(seed.token, seed.clientId);
    try {
      // Bind agent in org A (the JWT's default org)
      ws.send(
        JSON.stringify({
          type: "agent:bind",
          agentId: seed.agentA.uuid,
          ref: "bind-a",
          runtimeType: "claude-code",
          runtimeVersion: "0.0.0",
        }),
      );
      const okA = (await waitForFrame(ws, (m) => {
        const t = (m as { type?: string }).type;
        return t === "agent:bound" || t === "agent:bind:rejected";
      })) as { type: string; agentId?: string };
      expect(okA.type).toBe("agent:bound");
      expect(okA.agentId).toBe(seed.agentA.uuid);

      // Bind agent in org B on the same socket — must succeed under the new
      // R-RUN (same user, manager.status=active, no org compare).
      ws.send(
        JSON.stringify({
          type: "agent:bind",
          agentId: seed.agentB.uuid,
          ref: "bind-b",
          runtimeType: "claude-code",
          runtimeVersion: "0.0.0",
        }),
      );
      const okB = (await waitForFrame(ws, (m) => {
        const t = (m as { type?: string }).type;
        return t === "agent:bound" || t === "agent:bind:rejected";
      })) as { type: string; agentId?: string };
      expect(okB.type).toBe("agent:bound");
      expect(okB.agentId).toBe(seed.agentB.uuid);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);

  it("rejects bind when the manager's membership is inactive", async () => {
    const seed = await seedDualOrgUser("inactive");
    // Flip the org-B membership to `left` (== inactive for R-RUN purposes)
    // before connecting — both bind paths (already-pin + first-bind) should
    // see the inactive member and refuse.
    await app.db.update(members).set({ status: "left" }).where(eq(members.id, seed.memberBId));

    const ws = await openClientSocket(seed.token, seed.clientId);
    try {
      ws.send(
        JSON.stringify({
          type: "agent:bind",
          agentId: seed.agentB.uuid,
          ref: "bind-inactive",
          runtimeType: "claude-code",
          runtimeVersion: "0.0.0",
        }),
      );
      const msg = (await waitForFrame(ws, (m) => (m as { type?: string }).type === "agent:bind:rejected")) as {
        ref: string;
        reason: string;
      };
      expect(msg.ref).toBe("bind-inactive");
      expect(msg.reason).toBe(AGENT_BIND_REJECT_REASONS.NOT_OWNED);

      // The agent stays pinned to the client (the row was already pinned at
      // seed time); only the bind/presence step is refused.
      const [row] = await app.db
        .select({ clientId: agents.clientId })
        .from(agents)
        .where(eq(agents.uuid, seed.agentB.uuid));
      expect(row?.clientId).toBe(seed.clientId);
    } finally {
      ws.close();
      await new Promise<void>((r) => ws.once("close", () => r()));
    }
  }, 15000);
});
