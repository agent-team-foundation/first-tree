import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import * as notificationService from "../services/notification.js";
import { createOrganization, resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * S0 — Admin WebSocket cross-org isolation.
 *
 * Before this slice the admin WS filter fell through a `!orgId` branch that
 * silently broadcast every payload without a top-level organizationId to every
 * connected admin socket regardless of org. Two pieces tighten the contract:
 *
 *   1. `notification` envelopes hoist `organizationId` to the top of the payload.
 *   2. `session_state_changes` NOTIFY payloads now carry `organizationId` so the
 *      forwarded `session:state` frame is org-scoped end-to-end.
 *
 * This test asserts that a notification created for org A only reaches the
 * admin socket authenticated as org A — and never org B.
 */
describe("Admin WS — cross-org isolation (S0)", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signAdminJwt(userId: string, memberId: string, organizationId: string, role: string): Promise<string> {
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

  async function seedAdmin(organizationId: string, suffix: string) {
    const userId = uuidv7();
    const memberId = uuidv7();
    const agent = await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `iso-admin-${suffix}-${crypto.randomUUID().slice(0, 6)}`,
        email: `${userId}@noreply.local`,
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
    const token = await signAdminJwt(userId, memberId, organizationId, "admin");
    return { userId, memberId, agent, token };
  }

  function openAdminSocket(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
      ws.once("open", () => {
        const onMessage = (raw: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(raw.toString()) as { type?: string };
            if (msg.type === "admin:connected") {
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
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/ws/admin`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("routes a notification for org A only to org A's admin socket", async () => {
    const orgAId = await resolveDefaultOrgId(app.db);
    const orgB = await createOrganization(app.db, {
      name: `org-b-${crypto.randomUUID().slice(0, 6)}`,
      displayName: "Iso Org B",
    });

    const adminA = await seedAdmin(orgAId, "a");
    const adminB = await seedAdmin(orgB.id, "b");

    const wsA = await openAdminSocket(adminA.token);
    const wsB = await openAdminSocket(adminB.token);

    try {
      // Start collectors first so the listeners are attached before the
      // broadcast fires, then kick the notification and await both windows.
      const msgsAPromise = collectMessages(wsA, 1000);
      const msgsBPromise = collectMessages(wsB, 1000);

      await notificationService.createNotification(app.db, {
        organizationId: orgAId,
        type: "agent_error",
        severity: "high",
        message: "Isolation test — org A only",
      });

      const [receivedA, receivedB] = await Promise.all([msgsAPromise, msgsBPromise]);

      const notesA = receivedA.filter((m) => m.type === "notification");
      const notesB = receivedB.filter((m) => m.type === "notification");

      expect(notesA).toHaveLength(1);
      expect(notesA[0]).toMatchObject({ type: "notification", organizationId: orgAId });
      expect(notesB).toHaveLength(0);
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
    const wsA = await openAdminSocket(adminA.token);

    try {
      const { broadcastToAdmins } = await import("../services/admin-broadcast.js");
      const collected = collectMessages(wsA, 500);
      broadcastToAdmins({ type: "notification", data: { stray: true } });
      const msgs = await collected;
      expect(msgs.filter((m) => m.type === "notification")).toHaveLength(0);
    } finally {
      wsA.close();
      await new Promise<void>((r) => wsA.once("close", () => r()));
    }
  }, 10000);
});
