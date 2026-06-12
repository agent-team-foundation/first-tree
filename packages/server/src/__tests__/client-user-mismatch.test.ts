import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { clients } from "../db/schema/clients.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { createTestAdmin, createTestApp } from "./helpers.js";

/**
 * A clients row is owned by exactly one user, and there is NO server-side
 * ownership transfer: the old POST /clients/:clientId/claim was removed
 * because a clientId is org-visible (agent list) and must not double as a
 * transfer capability — with only-JWT auth it let any authenticated user
 * knock another user's machine offline. Machine handover now rotates the
 * LOCAL client identity (`login --override`) and registers a fresh clientId.
 *
 * What remains server-side is the WS handshake refusal: a JWT for a
 * different user cannot register an already-owned clientId
 * (CLIENT_USER_MISMATCH, close 4403) — never a silent overwrite.
 */
describe("Client ownership — WS mismatch refusal, no transfer endpoint", () => {
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

  async function seed(suffix: string) {
    const orgId = await resolveDefaultOrgId(app.db);
    const alice = await createTestAdmin(app, { username: `mismatch-a-${suffix}-${crypto.randomUUID().slice(0, 6)}` });
    const bob = await createTestAdmin(app, { username: `mismatch-b-${suffix}-${crypto.randomUUID().slice(0, 6)}` });

    const clientId = `cli-mismatch-${suffix}-${crypto.randomUUID().slice(0, 6)}`;
    await app.db
      .insert(clients)
      .values({ id: clientId, userId: alice.userId, organizationId: orgId, status: "connected" });

    return { orgId, alice, bob, clientId };
  }

  it("POST /clients/:clientId/claim no longer exists (ownership transfer removed)", async () => {
    const s = await seed("gone");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${s.clientId}/claim`,
      headers: { authorization: `Bearer ${s.bob.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);

    // Owner untouched.
    const [row] = await app.db.select({ userId: clients.userId }).from(clients).where(eq(clients.id, s.clientId));
    expect(row?.userId).toBe(s.alice.userId);
  });

  it("WS handshake: a JWT for a non-owner refuses register with code CLIENT_USER_MISMATCH and closes 4403", async () => {
    const s = await seed("ws");

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
});
