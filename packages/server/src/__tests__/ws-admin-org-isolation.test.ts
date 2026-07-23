import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { createOrganization, resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * S0 — Admin WebSocket cross-org isolation.
 *
 * The admin WS broadcaster requires a top-level `organizationId` on every
 * envelope and only routes the envelope to admin sockets attached to that
 * org. This test exercises the broadcaster seam directly so the contract
 * stays under test even as concrete frame types come and go.
 *
 *   1. An envelope with `organizationId = orgA` reaches org A's admin
 *      socket and never org B's.
 *   2. An envelope missing `organizationId` is dropped — pre-S0 behaviour
 *      silently fanned such payloads out to every connected admin socket.
 */
describe("Admin WS — cross-org isolation (S0)", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signAdminJwt(userId: string): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: userId, type: "access" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  async function seedAdmin(organizationId: string, suffix: string) {
    const userId = uuidv7();
    const memberId = uuidv7();
    const agent = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `iso-admin-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        passwordHash: "x",
        displayName: `Iso Admin ${suffix}`,
      });
      const created = await createAgent(tx as unknown as typeof app.db, {
        name: `iso-admin-agent-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: `Iso Admin ${suffix}`,
        source: "admin-api",
        managerId: memberId,
        organizationId,
      });
      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId,
        agentId: created.uuid,
        role: "admin",
      });
      return created;
    });
    const token = await signAdminJwt(userId);
    return { userId, memberId, agent, token, organizationId };
  }

  function openAdminSocket(token: string, organizationId: string): Promise<WebSocket> {
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
            // ignore non-JSON
          }
        };
        ws.on("message", onMessage);
      });
      ws.once("error", reject);
    });
  }

  function collectMessages(
    ws: WebSocket,
    durationMs: number,
  ): Promise<Array<{ type?: string } & Record<string, unknown>>> {
    return new Promise((resolve) => {
      const msgs: Array<{ type?: string } & Record<string, unknown>> = [];
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          msgs.push(JSON.parse(raw.toString()));
        } catch {
          // ignore non-JSON
        }
      };
      ws.on("message", onMessage);
      setTimeout(() => {
        ws.off("message", onMessage);
        resolve(msgs);
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

  it("routes an envelope tagged with orgA only to org A's admin socket", async () => {
    const orgAId = await resolveDefaultOrgId(app.db);
    const orgB = await createOrganization(app.db, {
      name: `org-b-${crypto.randomUUID().slice(0, 6)}`,
      displayName: "Iso Org B",
    });

    const adminA = await seedAdmin(orgAId, "a");
    const adminB = await seedAdmin(orgB.id, "b");

    const wsA = await openAdminSocket(adminA.token, adminA.organizationId);
    const wsB = await openAdminSocket(adminB.token, adminB.organizationId);

    try {
      const msgsAPromise = collectMessages(wsA, 1000);
      const msgsBPromise = collectMessages(wsB, 1000);

      const { broadcastToAdmins } = await import("../services/admin-broadcast.js");
      broadcastToAdmins({
        type: "iso:probe",
        organizationId: orgAId,
        marker: "Isolation test — org A only",
      });

      const [receivedA, receivedB] = await Promise.all([msgsAPromise, msgsBPromise]);

      const probesA = receivedA.filter((m) => m.type === "iso:probe");
      const probesB = receivedB.filter((m) => m.type === "iso:probe");

      expect(probesA).toHaveLength(1);
      expect(probesA[0]).toMatchObject({ type: "iso:probe", organizationId: orgAId });
      expect(probesB).toHaveLength(0);
    } finally {
      wsA.close();
      wsB.close();
      await Promise.all([
        new Promise<void>((r) => wsA.once("close", () => r())),
        new Promise<void>((r) => wsB.once("close", () => r())),
      ]);
    }
  }, 15000);

  it("drops broadcasts that lack a top-level organizationId", async () => {
    // Directly exercise the broadcaster seam. The ws-admin route installs a
    // strict filter that requires `organizationId` at the top level; payloads
    // without it must be no-ops (the pre-S0 behavior was a fan-out-to-everyone).
    const orgAId = await resolveDefaultOrgId(app.db);
    const adminA = await seedAdmin(orgAId, "drop");
    const wsA = await openAdminSocket(adminA.token, adminA.organizationId);

    try {
      const { broadcastToAdmins } = await import("../services/admin-broadcast.js");
      const collected = collectMessages(wsA, 500);
      broadcastToAdmins({ type: "iso:probe", data: { stray: true } });
      const msgs = await collected;
      expect(msgs.filter((m) => m.type === "iso:probe")).toHaveLength(0);
    } finally {
      wsA.close();
      await new Promise<void>((r) => wsA.once("close", () => r()));
    }
  }, 10000);
});
