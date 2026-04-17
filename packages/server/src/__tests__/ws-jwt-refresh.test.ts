import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTestApp } from "./helpers.js";

/**
 * Unified-user-token T3 (proposal W3): when the member access JWT expires
 * mid-session the server pushes `auth:expired` before closing the socket
 * (code 4401). The client can then reconnect with a fresh JWT and resume
 * binding without session state leaking between cycles.
 */
describe("WS auth expiry — server push auth:expired + reconnect with fresh JWT", () => {
  let app: FastifyInstance;
  let wsUrl: string;
  let adminUserId: string;
  let adminMemberId: string;
  let adminOrgId: string;
  let adminRole: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signJwt(expSecondsFromNow: number): Promise<string> {
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
      .setExpirationTime(now + expSecondsFromNow)
      .sign(secret);
  }

  function waitForFrame(ws: WebSocket, matcher: (msg: unknown) => boolean, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (matcher(msg)) {
            clearTimeout(timer);
            ws.off("message", onMessage);
            resolve(msg);
          }
        } catch {
          // skip non-JSON frames
        }
      };
      ws.on("message", onMessage);
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
  });

  // setup.ts truncates tables between tests, so the admin must be re-seeded
  // in beforeEach (not beforeAll) to survive WS connection attempts.
  beforeEach(async () => {
    const { createTestAdmin } = await import("./helpers.js");
    const admin = await createTestAdmin(app, { username: `jwt-ref-${crypto.randomUUID().slice(0, 8)}` });
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
    await app?.close();
  });

  it("sends auth:expired and closes 4401 when JWT exp is reached", async () => {
    const shortToken = await signJwt(2); // 2 seconds

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "auth", token: shortToken }));
    await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok");

    const expiredFrame = (await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:expired", 6000)) as {
      type: string;
    };
    expect(expiredFrame.type).toBe("auth:expired");

    const closeCode = await new Promise<number>((resolve) => {
      ws.once("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(4401);
  }, 15000);

  it("accepts a fresh JWT on a new connection after auth:expired", async () => {
    const freshToken = await signJwt(60);

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token: freshToken }));
    const okFrame = (await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:ok")) as { type: string };
    expect(okFrame.type).toBe("auth:ok");

    ws.close();
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });
  }, 10000);
});
