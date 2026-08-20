import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { clients } from "../db/schema/clients.js";
import {
  clearPendingClientRepliesForTests,
  removeClientConnection,
  resolveClientReply,
  setClientConnection,
} from "../services/runtime/connection-manager.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("POST /clients/:clientId/runtime-install/start", () => {
  const getApp = useTestApp();

  afterEach(() => {
    clearPendingClientRepliesForTests();
  });

  async function markCapable(
    app: ReturnType<typeof getApp>,
    clientId: string,
    input: { instanceId?: string; lastSeenAt?: Date; status?: "connected" | "disconnected" } = {},
  ): Promise<void> {
    await app.db
      .update(clients)
      .set({
        status: input.status ?? "connected",
        instanceId: input.instanceId ?? app.config.instanceId,
        lastSeenAt: input.lastSeenAt ?? new Date(),
        metadata: { wireCapabilities: { runtimeInstallV1: true } },
      })
      .where(eq(clients.id, clientId));
  }

  it("lets the exact owner install an allowlisted runtime on the live selected Computer", async () => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `ri-own-${crypto.randomUUID().slice(0, 6)}` });
    await markCapable(app, owner.clientId);
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(owner.clientId, ws as unknown as WebSocket, { runtimeInstallV1: true });
    try {
      const pending = app.inject({
        method: "POST",
        url: `/api/v1/clients/${owner.clientId}/runtime-install/start`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { provider: "codex" },
      });

      await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(1));
      const command = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      expect(command).toMatchObject({ type: "runtime-install:start", provider: "codex" });
      for (const result of [
        {
          type: "runtime-install:result" as const,
          provider: "codex" as const,
          ref: command.ref,
          status: "accepted" as const,
        },
        {
          type: "runtime-install:result" as const,
          provider: "codex" as const,
          ref: command.ref,
          status: "in-progress" as const,
        },
        {
          type: "runtime-install:result" as const,
          provider: "codex" as const,
          ref: command.ref,
          status: "succeeded" as const,
          installedVersion: "0.140.0",
        },
      ]) {
        await app.notifier.notifyDaemonClientCommandResult({ clientId: owner.clientId, ref: command.ref, result });
      }

      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        provider: "codex",
        ref: command.ref,
        status: "succeeded",
        installedVersion: "0.140.0",
        progress: ["accepted", "in-progress"],
      });
    } finally {
      removeClientConnection(owner.clientId, ws as unknown as WebSocket);
    }
  });

  it("rejects owner mismatch and non-allowlisted input before delivery", async () => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `ri-owner-${crypto.randomUUID().slice(0, 6)}` });
    const other = await createAdminContext(app, { username: `ri-other-${crypto.randomUUID().slice(0, 6)}` });
    await markCapable(app, owner.clientId);
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(owner.clientId, ws as unknown as WebSocket, { runtimeInstallV1: true });
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${owner.clientId}/runtime-install/start`,
        headers: { authorization: `Bearer ${other.accessToken}` },
        payload: { provider: "codex" },
      });
      expect(unauthorized.statusCode).toBe(404);

      const disallowed = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${owner.clientId}/runtime-install/start`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { provider: "cursor", command: "npm install anything" },
      });
      expect(disallowed.statusCode).toBe(400);

      const arbitraryCommand = await app.inject({
        method: "POST",
        url: `/api/v1/clients/${owner.clientId}/runtime-install/start`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { provider: "codex", command: "npm install anything" },
      });
      expect(arbitraryCommand.statusCode).toBe(400);
      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      removeClientConnection(owner.clientId, ws as unknown as WebSocket);
    }
  });

  it.each([
    ["disconnected", "not connected", { status: "disconnected" as const }],
    ["stale", "stale", { lastSeenAt: new Date(0) }],
  ])("returns an explicit error for a %s Computer", async (_label, expectedMessage, clientState) => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `ri-live-${crypto.randomUUID().slice(0, 6)}` });
    await markCapable(app, owner.clientId, clientState);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/clients/${owner.clientId}/runtime-install/start`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { provider: "claude-code" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.toLowerCase()).toContain(expectedMessage);
  });

  it("surfaces a retryable daemon failure and permits a later request", async () => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `ri-fail-${crypto.randomUUID().slice(0, 6)}` });
    await markCapable(app, owner.clientId);
    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(owner.clientId, ws as unknown as WebSocket, { runtimeInstallV1: true });
    try {
      const request = () =>
        app.inject({
          method: "POST",
          url: `/api/v1/clients/${owner.clientId}/runtime-install/start`,
          headers: { authorization: `Bearer ${owner.accessToken}` },
          payload: { provider: "claude-code" },
        });
      const first = request();
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(1));
      const firstCommand = JSON.parse(String(ws.send.mock.calls[0]?.[0]));
      resolveClientReply(owner.clientId, firstCommand.ref, {
        type: "runtime-install:result",
        provider: "claude-code",
        ref: firstCommand.ref,
        status: "failed",
        reason: "npm registry unavailable",
        reasonCode: "network_error",
        retryable: true,
      });
      const failed = await first;
      expect(failed.statusCode).toBe(200);
      expect(failed.json()).toMatchObject({
        status: "failed",
        reasonCode: "network_error",
        retryable: true,
        progress: [],
      });

      const retry = request();
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
      const retryCommand = JSON.parse(String(ws.send.mock.calls[1]?.[0]));
      expect(retryCommand.ref).not.toBe(firstCommand.ref);
      resolveClientReply(owner.clientId, retryCommand.ref, {
        type: "runtime-install:result",
        provider: "claude-code",
        ref: retryCommand.ref,
        status: "succeeded",
        installedVersion: null,
      });
      expect((await retry).json()).toMatchObject({ status: "succeeded" });
    } finally {
      removeClientConnection(owner.clientId, ws as unknown as WebSocket);
    }
  });

  it("fans the command to the DB-authoritative remote replica", async () => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `ri-remote-${crypto.randomUUID().slice(0, 6)}` });
    await markCapable(app, owner.clientId, { instanceId: "remote-instance" });
    const notify = vi.spyOn(app.notifier, "notifyDaemonClientCommand").mockResolvedValue();
    try {
      const pending = app.inject({
        method: "POST",
        url: `/api/v1/clients/${owner.clientId}/runtime-install/start`,
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { provider: "codex" },
      });
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      const command = notify.mock.calls[0]?.[0];
      expect(command).toMatchObject({
        type: "runtime-install:start",
        clientId: owner.clientId,
        provider: "codex",
        targetInstanceId: "remote-instance",
      });
      if (!command) throw new Error("expected remote command");
      await app.notifier.notifyDaemonClientCommandResult({
        clientId: owner.clientId,
        ref: command.ref,
        result: {
          type: "runtime-install:result",
          provider: "codex",
          ref: command.ref,
          status: "in-progress",
        },
      });
      await app.notifier.notifyDaemonClientCommandResult({
        clientId: owner.clientId,
        ref: command.ref,
        result: {
          type: "runtime-install:result",
          provider: "codex",
          ref: command.ref,
          status: "accepted",
        },
      });
      await app.notifier.notifyDaemonClientCommandResult({
        clientId: owner.clientId,
        ref: command.ref,
        result: {
          type: "runtime-install:result",
          provider: "codex",
          ref: command.ref,
          status: "succeeded",
          installedVersion: null,
        },
      });
      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "succeeded", progress: ["accepted"] });
    } finally {
      notify.mockRestore();
    }
  });
});
