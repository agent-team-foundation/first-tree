import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTestAdmin, createTestApp } from "./helpers.js";

/**
 * End-to-end wire check: the server must send `server:welcome` right after
 * `auth:ok` so clients can detect version drift on connect / reconnect.
 */
describe("WS server:welcome — wire-additive frame after auth:ok", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  let adminUserId: string;
  let adminMemberId: string;
  let adminOrgId: string;
  let adminRole: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signJwt(): Promise<string> {
    const secret = new TextEncoder().encode(jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: adminUserId,
      memberId: adminMemberId,
      organizationId: adminOrgId,
      role: adminRole,
      type: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
  });

  beforeEach(async () => {
    const admin = await createTestAdmin(app, { username: `welcome-${crypto.randomUUID().slice(0, 8)}` });
    adminUserId = admin.userId;
    adminMemberId = admin.memberId;
    const { members } = await import("../db/schema/members.js");
    const { eq } = await import("drizzle-orm");
    const [member] = await app.db.select().from(members).where(eq(members.id, adminMemberId)).limit(1);
    if (!member) throw new Error("member row missing after setup");
    adminOrgId = member.organizationId;
    adminRole = member.role;
  });

  afterAll(async () => {
    await app.close();
  });

  it("sends server:welcome immediately after auth:ok", async () => {
    const token = await signJwt();
    const ws = new WebSocket(wsUrl);
    const frames: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test timeout")), 5000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        frames.push(msg);
        // Stop once we have at least auth:ok + server:welcome.
        if (frames.length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    ws.close();

    expect(frames[0]).toEqual({ type: "auth:ok" });
    const welcome = frames[1] as {
      type: string;
      serverCommandVersion: string;
      serverTimeMs: number;
      capabilities?: { wsInboxDeliver?: boolean; wsInboxAckConfirm?: boolean };
    };
    expect(welcome.type).toBe("server:welcome");
    expect(typeof welcome.serverCommandVersion).toBe("string");
    expect(welcome.serverCommandVersion.length).toBeGreaterThan(0);
    expect(typeof welcome.serverTimeMs).toBe("number");
    expect(welcome.serverTimeMs).toBeGreaterThan(0);
    expect(welcome.capabilities?.wsInboxDeliver).toBe(true);
    expect(welcome.capabilities?.wsInboxAckConfirm).toBe(true);
  });
});
