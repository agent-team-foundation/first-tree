import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { broadcastToAdmins } from "../services/admin-broadcast.js";
import { createAgent } from "../services/agent.js";
import { createOrganization } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp, seedClient } from "./helpers.js";

/**
 * pulse:tick must include only the agents each recipient is allowed to see
 * via REST. Otherwise an org member can enumerate private agents managed by
 * peers and infer their activity over time, even though the REST activity
 * API filters by agent visibility.
 */
describe("Admin WS — pulse:tick visibility filtering", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signJwt(userId: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: userId, type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  async function seedMember(organizationId: string, suffix: string) {
    const userId = uuidv7();
    const memberId = uuidv7();
    const agent = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `pv-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: `PV ${suffix}`,
      });
      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `pv-human-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: `PV Human ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        organizationId,
      });
      await tx.insert(members).values({ id: memberId, userId, organizationId, agentId: human.uuid, role: "member" });
      return human;
    });
    const clientId = await seedClient(app, userId, organizationId);
    return { userId, memberId, humanAgent: agent, clientId, organizationId, token: await signJwt(userId) };
  }

  function openSocket(token: string, organizationId: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}/${encodeURIComponent(organizationId)}/ws/`);
      ws.once("open", () => {
        const onMessage = (raw: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(raw.toString()) as { type?: string; protocolVersion?: number; nonce?: string };
            if (msg.type === "server:hello" && msg.protocolVersion === 1 && typeof msg.nonce === "string") {
              ws.send(
                JSON.stringify({
                  type: "auth",
                  protocolVersion: msg.protocolVersion,
                  nonce: msg.nonce,
                  token,
                }),
              );
              return;
            }
            if (msg.type === "auth:ok") {
              ws.off("message", onMessage);
              resolve(ws);
            }
          } catch {
            // ignore
          }
        };
        ws.on("message", onMessage);
      });
      ws.once("error", reject);
    });
  }

  function collectPulseTick(ws: WebSocket, durationMs: number): Promise<Array<{ agents?: Record<string, unknown> }>> {
    return new Promise((resolve) => {
      const out: Array<{ agents?: Record<string, unknown> }> = [];
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; agents?: Record<string, unknown> };
          if (msg.type === "pulse:tick") out.push(msg);
        } catch {
          // ignore
        }
      };
      ws.on("message", onMessage);
      setTimeout(() => {
        ws.off("message", onMessage);
        resolve(out);
      }, durationMs);
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/orgs`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("filters per-recipient: private agent appears only in its manager's pulse frame", async () => {
    const org = await createOrganization(app.db, {
      name: `pv-org-${crypto.randomUUID().slice(0, 6)}`,
      displayName: "PV Org",
    });

    const owner = await seedMember(org.id, "owner");
    const peer = await seedMember(org.id, "peer");

    // One organization-visible agent (both should see) and one private to `owner` (only owner should see).
    const orgAgent = await createAgent(app.db, {
      name: `pv-org-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      visibility: "organization",
      managerId: owner.memberId,
      clientId: owner.clientId,
      organizationId: org.id,
    });
    const privateAgent = await createAgent(app.db, {
      name: `pv-priv-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      visibility: "private",
      managerId: owner.memberId,
      clientId: owner.clientId,
      organizationId: org.id,
    });

    const wsOwner = await openSocket(owner.token, owner.organizationId);
    const wsPeer = await openSocket(peer.token, peer.organizationId);

    try {
      const ownerCollect = collectPulseTick(wsOwner, 500);
      const peerCollect = collectPulseTick(wsPeer, 500);

      // Inject a single pulse frame carrying both agents.
      broadcastToAdmins({
        type: "pulse:tick",
        organizationId: org.id,
        agents: {
          [orgAgent.uuid]: [{ workingCount: 1, errorMask: false }],
          [privateAgent.uuid]: [{ workingCount: 2, errorMask: true }],
        },
      });

      const [ownerFrames, peerFrames] = await Promise.all([ownerCollect, peerCollect]);

      expect(ownerFrames).toHaveLength(1);
      expect(peerFrames).toHaveLength(1);

      const ownerAgents = Object.keys(ownerFrames[0]?.agents ?? {});
      const peerAgents = Object.keys(peerFrames[0]?.agents ?? {});

      expect(ownerAgents.sort()).toEqual([orgAgent.uuid, privateAgent.uuid].sort());
      expect(peerAgents).toEqual([orgAgent.uuid]);
      expect(peerAgents).not.toContain(privateAgent.uuid);
    } finally {
      wsOwner.close();
      wsPeer.close();
      await Promise.all([
        new Promise<void>((r) => wsOwner.once("close", () => r())),
        new Promise<void>((r) => wsPeer.once("close", () => r())),
      ]);
    }
  }, 15000);
});
