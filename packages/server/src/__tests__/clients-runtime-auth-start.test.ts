import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { clients } from "../db/schema/clients.js";
import { createAgent } from "../services/agent.js";
import { removeClientConnection, setClientConnection } from "../services/connection-manager.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * `POST /api/v1/clients/:clientId/runtime-auth/start` forwards a
 * `runtime-auth:start` reverse command to the owner's connected daemon (the
 * "Connect <provider>" onboarding action). Delivery mirrors the session-command
 * precedent: fire-and-forget over the live WS, 503 if the daemon is offline.
 */
describe("POST /clients/:clientId/runtime-auth/start", () => {
  const getApp = useTestApp();

  it("forwards a runtime-auth:start frame to the connected daemon and returns a ref", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `ra-${crypto.randomUUID().slice(0, 6)}` });
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${admin.clientId}/runtime-auth/start`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { provider: "codex" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.started).toBe(true);
      expect(typeof body.ref).toBe("string");
      expect(ws.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      expect(frame).toMatchObject({ type: "runtime-auth:start", provider: "codex", ref: body.ref });
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("passes an explicit method through to the daemon frame", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `ra-${crypto.randomUUID().slice(0, 6)}` });
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${admin.clientId}/runtime-auth/start`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { provider: "claude-code", method: "browser" },
      });
      expect(res.statusCode).toBe(200);
      const frame = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      expect(frame).toMatchObject({ type: "runtime-auth:start", provider: "claude-code", method: "browser" });
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("returns 503 when the daemon is not connected", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `ra-${crypto.randomUUID().slice(0, 6)}` });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${admin.clientId}/runtime-auth/start`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { provider: "codex" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("rejects an unknown provider with 400", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `ra-${crypto.randomUUID().slice(0, 6)}` });
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${admin.clientId}/runtime-auth/start`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { provider: "not-a-runtime" },
      });
      expect(res.statusCode).toBe(400);
      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("rejects an unsupported Connect target (claude-code-tui) with 400, sending no frame", async () => {
    // claude-code-tui is a real runtime, but its credentials come from the
    // claude-code login — it is never a separate Connect target, so the route
    // must reject it rather than return started:true for a no-op.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `ra-${crypto.randomUUID().slice(0, 6)}` });
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${admin.clientId}/runtime-auth/start`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { provider: "claude-code-tui" },
      });
      expect(res.statusCode).toBe(400);
      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("forbids starting runtime-auth on a client the caller does not own", async () => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `ra-own-${crypto.randomUUID().slice(0, 6)}` });
    const other = await createAdminContext(app, { username: `ra-oth-${crypto.randomUUID().slice(0, 6)}` });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${owner.clientId}/runtime-auth/start`,
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { provider: "codex" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("disconnects and retires caller-owned clients through the client routes", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `ra-client-${crypto.randomUUID().slice(0, 6)}` });
    await createAgent(app.db, {
      name: `ra-client-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Client Route Agent",
      managerId: admin.memberId,
      clientId: admin.clientId,
      organizationId: admin.organizationId,
    });
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const disconnect = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${admin.clientId}/disconnect`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(disconnect.statusCode).toBe(200);
      expect(disconnect.json()).toEqual({ disconnected: true, agentIds: [] });

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/v1/clients/${admin.clientId}`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(deleted.statusCode).toBe(204);

      const [row] = await app.db
        .select({ status: clients.status, retiredAt: clients.retiredAt })
        .from(clients)
        .where(eq(clients.id, admin.clientId));
      expect(row?.status).toBe("disconnected");
      expect(row?.retiredAt).toBeInstanceOf(Date);
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });
});
