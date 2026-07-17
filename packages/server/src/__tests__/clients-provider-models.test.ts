import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { clients } from "../db/schema/clients.js";
import {
  removeClientConnection,
  resolveClientReply,
  setClientConnection,
  waitForClientReply,
} from "../services/connection-manager.js";
import { readModelCatalogRpcResult, storeModelCatalogRpcResult } from "../services/provider-models-rpc.js";
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

  it("fans the reverse command across replicas when the socket is remote", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await app.db
      .update(clients)
      .set({ status: "connected", instanceId: "replica-other" })
      .where(eq(clients.id, admin.clientId));

    const notifyCommand = vi.spyOn(app.notifier, "notifyDaemonClientCommand").mockResolvedValue();

    const pending = app.inject({
      method: "GET",
      url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    await vi.waitFor(() => {
      expect(notifyCommand).toHaveBeenCalled();
    });
    const command = notifyCommand.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      type: "provider-models:list",
      clientId: admin.clientId,
      provider: "cursor",
    });
    expect(typeof command?.ref).toBe("string");
    const ref = command?.ref;
    if (!ref) throw new Error("expected notifyDaemonClientCommand ref");

    const catalog = {
      provider: "cursor" as const,
      models: [{ id: "auto", label: "Auto", isDefault: true }],
      defaultModelId: "auto",
      fetchedAt: new Date().toISOString(),
      source: "provider-cli" as const,
      error: null,
    };
    // Simulate the socket-owning replica: durable store + local miss + result wake.
    await storeModelCatalogRpcResult(app.db, admin.clientId, ref, catalog);
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref)).toMatchObject(catalog);
    // Direct resolve mirrors what onDaemonClientCommandResult does after read.
    expect(resolveClientReply(admin.clientId, ref, catalog)).toBe(true);

    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject(catalog);
    notifyCommand.mockRestore();
  });

  it("resolves a remote waiter from metadata after a result wake", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    const ref = crypto.randomUUID();
    const catalog = {
      provider: "kimi-code" as const,
      models: [{ id: "gemini-3-pro-preview", label: "Gemini 3 Pro", isDefault: true }],
      defaultModelId: "gemini-3-pro-preview",
      fetchedAt: new Date().toISOString(),
      source: "provider-config" as const,
      error: null,
    };

    const replyPromise = waitForClientReply(admin.clientId, ref);
    await storeModelCatalogRpcResult(app.db, admin.clientId, ref, catalog);
    await app.notifier.notifyDaemonClientCommandResult({ clientId: admin.clientId, ref });

    await expect(replyPromise).resolves.toMatchObject(catalog);
  });
});
