import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../client-connection.js";

describe("ClientConnection — auth handshake classification", () => {
  let httpServer: HttpServer;
  let wss: WebSocketServer;
  let serverUrl: string;

  beforeEach(async () => {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer, path: "/api/v1/agent/ws/client" });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server address");
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("auth:retryable reconnects with backoff and does not enter paused mode", async () => {
    let attempts = 0;
    const openTimes: number[] = [];
    wss.on("connection", (ws: WebSocket) => {
      const attempt = ++attempts;
      openTimes.push(Date.now());
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth" && attempt === 1) {
          ws.send(
            JSON.stringify({
              type: "auth:retryable",
              code: "auth_backend_unavailable",
              retryAfterMs: 1200,
              message: "database unavailable",
            }),
          );
          return;
        }
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_retryable_auth",
      getAccessToken: async () => "tok",
    });

    const paused: string[] = [];
    connection.on("auth:paused", (reason) => paused.push(reason));
    connection.on("error", () => {});

    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await connection.connect();
    } finally {
      randomSpy.mockRestore();
    }

    expect(connection.isConnected).toBe(true);
    expect(connection.isPaused()).toBe(false);
    expect(paused).toEqual([]);
    expect(attempts).toBe(2);
    expect((openTimes[1] ?? 0) - (openTimes[0] ?? 0)).toBeGreaterThanOrEqual(1150);

    await connection.disconnect();
  }, 10_000);

  it("close-before-ready 1013 reconnects and does not enter paused mode", async () => {
    let attempts = 0;
    wss.on("connection", (ws: WebSocket) => {
      const attempt = ++attempts;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register" && attempt === 1) {
          ws.close(1013, "try again later");
          return;
        }
        if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_retryable_1013",
      getAccessToken: async () => "tok",
    });

    const paused: string[] = [];
    connection.on("auth:paused", (reason) => paused.push(reason));
    connection.on("error", () => {});

    await connection.connect();

    expect(connection.isConnected).toBe(true);
    expect(connection.isPaused()).toBe(false);
    expect(paused).toEqual([]);
    expect(attempts).toBe(2);

    await connection.disconnect();
  }, 10_000);
});
