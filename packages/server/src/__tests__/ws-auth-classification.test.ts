import { WS_AUTH_FRAME_TIMEOUT_MS } from "@first-tree/shared";
import { context as otelContext, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { users } from "../db/schema/users.js";
import * as clientService from "../services/client.js";
import { createTestAdmin, createTestApp } from "./helpers.js";

describe("WS auth handshake classification", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const contextManager = new AsyncHooksContextManager();
  let app: FastifyInstance;
  let wsUrl: string;
  let adminUserId: string;
  let adminMemberId: string;
  let adminOrgId: string;
  let adminRole: string;
  const jwtSecret = process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest";

  async function signJwt(
    opts: { sub?: string; secret?: string; type?: string; expiresInSeconds?: number } = {},
  ): Promise<string> {
    const secret = new TextEncoder().encode(opts.secret ?? jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: opts.sub ?? adminUserId,
      memberId: adminMemberId,
      organizationId: adminOrgId,
      role: adminRole,
      type: opts.type ?? "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.expiresInSeconds ?? 300))
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

  function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for close (${timeoutMs}ms)`)), timeoutMs);
      ws.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  async function connectionSpanAttrs(timeoutMs = 1000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const span = exporter.getFinishedSpans().find((s) => s.name === "ws.connection");
      if (span) return span.attributes;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("expected finished ws.connection span");
  }

  async function openAndSendAuth(token: string, frames: unknown[] = []): Promise<WebSocket> {
    const ws = new WebSocket(wsUrl);
    ws.on("message", (raw) => {
      try {
        frames.push(JSON.parse(raw.toString()));
      } catch {
        // ignore
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "auth", token }));
    return ws;
  }

  beforeAll(async () => {
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("test server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}/api/v1/agent/ws/client`;
  });

  beforeEach(async () => {
    exporter.reset();
    const admin = await createTestAdmin(app, { username: `ws-auth-${crypto.randomUUID().slice(0, 8)}` });
    adminUserId = admin.userId;
    adminMemberId = admin.memberId;
    adminOrgId = admin.organizationId;
    adminRole = "admin";
  });

  afterAll(async () => {
    await app.close();
    await provider.shutdown();
    trace.disable();
    otelContext.disable();
    contextManager.disable();
  });

  it("auth frame timeout emits auth:retryable and closes 1013", async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const frame = await waitForFrame(
      ws,
      (m) => (m as { type?: string }).type === "auth:retryable",
      WS_AUTH_FRAME_TIMEOUT_MS + 2000,
    );
    const closeCode = await waitForClose(ws);

    expect(frame).toMatchObject({ type: "auth:retryable", code: "auth_timeout" });
    expect(closeCode).toBe(1013);
    await expect(connectionSpanAttrs()).resolves.toMatchObject({
      "auth.ws.phase": "auth_frame_timeout",
      "auth.ws.outcome": "retryable",
      "auth.ws.code": "auth_timeout",
      "auth.ws.retryable": true,
      "auth.ws.close_code": 1013,
    });
  });

  it("expired JWT emits auth:expired and closes 4401", async () => {
    const token = await signJwt({ expiresInSeconds: -60 });
    const ws = await openAndSendAuth(token);

    const frame = await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:expired");
    const closeCode = await waitForClose(ws);

    expect(frame).toEqual({ type: "auth:expired" });
    expect(closeCode).toBe(4401);
    await expect(connectionSpanAttrs()).resolves.toMatchObject({
      "auth.ws.phase": "jwt_verify",
      "auth.ws.outcome": "expired",
      "auth.ws.code": "jwt_expired",
      "auth.ws.retryable": true,
      "auth.ws.close_code": 4401,
      "auth.ws.untrusted.sub": adminUserId,
      "auth.ws.untrusted.type": "access",
    });
  });

  it("invalid signature emits auth:rejected invalid_token", async () => {
    const token = await signJwt({ secret: "wrong-test-secret" });
    const ws = await openAndSendAuth(token);

    const frame = await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:rejected");
    const closeCode = await waitForClose(ws);

    expect(frame).toMatchObject({ type: "auth:rejected", code: "invalid_token" });
    expect(closeCode).toBe(4401);
    await expect(connectionSpanAttrs()).resolves.toMatchObject({
      "auth.ws.phase": "jwt_verify",
      "auth.ws.outcome": "rejected",
      "auth.ws.code": "invalid_token",
      "auth.ws.retryable": false,
      "auth.ws.close_code": 4401,
    });
    expect(typeof (await connectionSpanAttrs())["auth.ws.error_class"]).toBe("string");
  });

  it("missing user emits auth:rejected user_not_found", async () => {
    const token = await signJwt({ sub: `missing-${crypto.randomUUID()}` });
    const ws = await openAndSendAuth(token);

    const frame = await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:rejected");
    const closeCode = await waitForClose(ws);

    expect(frame).toMatchObject({ type: "auth:rejected", code: "user_not_found" });
    expect(closeCode).toBe(4401);
  });

  it("suspended user emits auth:rejected user_suspended", async () => {
    await app.db.update(users).set({ status: "suspended" }).where(eq(users.id, adminUserId));
    const token = await signJwt();
    const ws = await openAndSendAuth(token);

    const frame = await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:rejected");
    const closeCode = await waitForClose(ws);

    expect(frame).toMatchObject({ type: "auth:rejected", code: "user_suspended" });
    expect(closeCode).toBe(4401);
  });

  it("DB error during auth lookup emits auth:retryable and closes 1013", async () => {
    const token = await signJwt();
    const selectSpy = vi.spyOn(app.db, "select").mockImplementation(() => {
      throw new Error("database unavailable");
    });

    try {
      const ws = await openAndSendAuth(token);
      const frame = await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:retryable");
      const closeCode = await waitForClose(ws);

      expect(frame).toMatchObject({ type: "auth:retryable", code: "auth_backend_unavailable" });
      expect(closeCode).toBe(1013);
      await expect(connectionSpanAttrs()).resolves.toMatchObject({
        "auth.ws.phase": "user_lookup",
        "auth.ws.outcome": "retryable",
        "auth.ws.code": "auth_backend_unavailable",
        "auth.ws.retryable": true,
        "auth.ws.close_code": 1013,
        "auth.ws.error_class": "Error",
      });
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("post-auth welcome failure is retryable and never maps to auth:rejected", async () => {
    const token = await signJwt();
    const frames: unknown[] = [];
    const originalCommandVersion = app.commandVersion;
    app.commandVersion = () => {
      throw new Error("version unavailable");
    };

    try {
      const ws = await openAndSendAuth(token, frames);
      const retryable = await waitForFrame(ws, (m) => (m as { type?: string }).type === "auth:retryable");
      const closeCode = await waitForClose(ws);

      expect(frames).toContainEqual({ type: "auth:ok" });
      expect(retryable).toMatchObject({ type: "auth:retryable", code: "handshake_internal_error" });
      expect(frames.some((frame) => (frame as { type?: string }).type === "auth:rejected")).toBe(false);
      expect(closeCode).toBe(1011);
      await expect(connectionSpanAttrs()).resolves.toMatchObject({
        "user.id": adminUserId,
        "auth.ws.phase": "post_auth_welcome",
        "auth.ws.outcome": "retryable",
        "auth.ws.code": "handshake_internal_error",
        "auth.ws.retryable": true,
        "auth.ws.close_code": 1011,
        "auth.ws.error_class": "Error",
      });
    } finally {
      app.commandVersion = originalCommandVersion;
    }
  });

  it("client register rejection records client_register phase before closing 4403", async () => {
    const token = await signJwt();
    const registerSpy = vi.spyOn(clientService, "registerClient").mockRejectedValue(new Error("register unavailable"));

    try {
      const ws = await openAndSendAuth(token);
      await waitForFrame(ws, (m) => (m as { type?: string }).type === "server:welcome");

      ws.send(
        JSON.stringify({
          type: "client:register",
          clientId: `client-${crypto.randomUUID()}`,
        }),
      );

      const rejected = await waitForFrame(ws, (m) => (m as { type?: string }).type === "client:register:rejected");
      const closeCode = await waitForClose(ws);

      expect(rejected).toMatchObject({
        type: "client:register:rejected",
        message: "register unavailable",
      });
      expect(closeCode).toBe(4403);
      await expect(connectionSpanAttrs()).resolves.toMatchObject({
        "user.id": adminUserId,
        "auth.ws.phase": "client_register",
        "auth.ws.outcome": "rejected",
        "auth.ws.code": "client_register_failed",
        "auth.ws.retryable": false,
        "auth.ws.close_code": 4403,
        "auth.ws.error_class": "Error",
      });
    } finally {
      registerSpy.mockRestore();
    }
  });
});
