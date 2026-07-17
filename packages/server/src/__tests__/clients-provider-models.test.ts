import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  removeClientConnection,
  resolveClientReply,
  setClientConnection,
} from "../services/connection-manager.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * `GET /api/v1/clients/:clientId/providers/:provider/models` asks the connected
 * daemon for a host-local model catalog and waits for the correlated reply.
 */
describe("GET /clients/:clientId/providers/:provider/models", () => {
  const getApp = useTestApp();

  it("forwards provider-models:list and returns the daemon catalog", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      // Wait briefly for the reverse command to be sent, then resolve the waiter.
      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalled();
      });
      const frame = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      expect(frame).toMatchObject({ type: "provider-models:list", provider: "cursor" });
      expect(typeof frame.ref).toBe("string");

      const catalog = {
        provider: "cursor" as const,
        models: [{ id: "auto", label: "Auto", isDefault: true }],
        defaultModelId: "auto",
        fetchedAt: new Date().toISOString(),
        source: "provider-cli" as const,
        error: null,
      };
      expect(resolveClientReply(admin.clientId, frame.ref, catalog)).toBe(true);

      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject(catalog);
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("returns 503 when the daemon is not connected", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/clients/${admin.clientId}/providers/kimi-code/models`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(503);
  });
});
