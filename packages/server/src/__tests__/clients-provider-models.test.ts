import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { clients } from "../db/schema/clients.js";
import * as clientService from "../services/client.js";
import {
  removeClientConnection,
  resolveClientReply,
  setClientConnection,
  setClientReplyTimeoutMsForTests,
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

  afterEach(() => {
    setClientReplyTimeoutMsForTests(null);
  });

  async function markClientOnInstance(app: ReturnType<typeof getApp>, clientId: string, instanceId: string) {
    await app.db.update(clients).set({ status: "connected", instanceId }).where(eq(clients.id, clientId));
  }

  it("forwards provider-models:list and returns the daemon catalog", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, app.config.instanceId);
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

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

  it("fans the reverse command to the DB-authoritative instance when remote", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, "replica-other");

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
      targetInstanceId: "replica-other",
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
    await storeModelCatalogRpcResult(app.db, admin.clientId, ref, catalog);
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref)).toMatchObject(catalog);
    expect(resolveClientReply(admin.clientId, ref, catalog)).toBe(true);

    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject(catalog);
    notifyCommand.mockRestore();
  });

  it("does not deliver on a stale local socket after instance takeover", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    // DB says another replica owns the connection, but this process still has a socket.
    await markClientOnInstance(app, admin.clientId, "replica-other");
    const staleWs = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, staleWs as unknown as WebSocket);

    const notifyCommand = vi.spyOn(app.notifier, "notifyDaemonClientCommand").mockResolvedValue();
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      await vi.waitFor(() => {
        expect(notifyCommand).toHaveBeenCalled();
      });
      expect(staleWs.send).not.toHaveBeenCalled();
      expect(notifyCommand.mock.calls[0]?.[0]).toMatchObject({
        targetInstanceId: "replica-other",
        clientId: admin.clientId,
      });

      const ref = notifyCommand.mock.calls[0]?.[0]?.ref;
      if (!ref) throw new Error("expected ref");
      const catalog = {
        provider: "cursor" as const,
        models: [{ id: "auto", label: "Auto" }],
        defaultModelId: "auto",
        fetchedAt: new Date().toISOString(),
        source: "provider-cli" as const,
        error: null,
      };
      expect(resolveClientReply(admin.clientId, ref, catalog)).toBe(true);
      const res = await pending;
      expect(res.statusCode).toBe(200);
    } finally {
      notifyCommand.mockRestore();
      removeClientConnection(admin.clientId, staleWs as unknown as WebSocket);
    }
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

  it("returns a stored catalog when the result wake is lost", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });
    await markClientOnInstance(app, admin.clientId, app.config.instanceId);
    setClientReplyTimeoutMsForTests(80);

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    try {
      const pending = app.inject({
        method: "GET",
        url: `/api/v1/clients/${admin.clientId}/providers/cursor/models`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalled();
      });
      const frame = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      const catalog = {
        provider: "cursor" as const,
        models: [{ id: "auto", label: "Auto", isDefault: true }],
        defaultModelId: "auto",
        fetchedAt: new Date().toISOString(),
        source: "provider-cli" as const,
        error: null,
      };
      // Durable store arrives, but no resolveClientReply / result NOTIFY (lost wake).
      await storeModelCatalogRpcResult(app.db, admin.clientId, frame.ref, catalog);

      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject(catalog);
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("stores concurrent refs without clobbering sibling metadata", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `pm-${crypto.randomUUID().slice(0, 6)}` });

    const detectedAt = new Date().toISOString();
    await clientService.updateClientCapabilities(app.db, admin.clientId, {
      cursor: { state: "ok", available: true, detectedAt, sdkVersion: "1.0.0" },
    });

    const ref1 = crypto.randomUUID();
    const ref2 = crypto.randomUUID();
    const cat1 = {
      provider: "cursor" as const,
      models: [{ id: "auto", label: "Auto" }],
      defaultModelId: "auto",
      fetchedAt: new Date().toISOString(),
      source: "provider-cli" as const,
      error: null,
    };
    const cat2 = {
      provider: "kimi-code" as const,
      models: [{ id: "k3", label: "K3" }],
      defaultModelId: "k3",
      fetchedAt: new Date().toISOString(),
      source: "provider-config" as const,
      error: null,
    };

    await Promise.all([
      storeModelCatalogRpcResult(app.db, admin.clientId, ref1, cat1),
      storeModelCatalogRpcResult(app.db, admin.clientId, ref2, cat2),
    ]);

    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref1)).toMatchObject(cat1);
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref2)).toMatchObject(cat2);

    await clientService.updateClientCapabilities(app.db, admin.clientId, {
      cursor: { state: "ok", available: true, detectedAt, sdkVersion: "1.0.1" },
      "kimi-code": { state: "ok", available: true, detectedAt },
    });

    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref1)).toMatchObject(cat1);
    expect(await readModelCatalogRpcResult(app.db, admin.clientId, ref2)).toMatchObject(cat2);

    const row = await clientService.getClient(app.db, admin.clientId);
    expect(clientService.extractCapabilities(row?.metadata)).toMatchObject({
      cursor: { available: true, sdkVersion: "1.0.1" },
      "kimi-code": { available: true },
    });
  });
});
