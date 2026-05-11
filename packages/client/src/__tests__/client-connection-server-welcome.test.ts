import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection, type ServerWelcome } from "../client-connection.js";

describe("ClientConnection — server:welcome dispatch", () => {
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

  it("emits 'server:welcome' with isReconnect=false on first connect", async () => {
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          ws.send(
            JSON.stringify({
              type: "server:welcome",
              serverCommandVersion: "0.9.2",
              serverTimeMs: 1_700_000_000_000,
            }),
          );
          return;
        }
        if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_test0001",
      getAccessToken: async () => "test-token",
    });

    const received: ServerWelcome[] = [];
    connection.on("server:welcome", (w) => received.push(w));

    // Register listener BEFORE connect to avoid missing the first welcome frame.
    const connectPromise = connection.connect();
    await connectPromise;
    // Welcome frame arrives between auth:ok and client:registered — but the
    // connect promise resolves on client:registered, so the welcome has
    // already been dispatched synchronously by then.
    await connection.disconnect();

    expect(received).toHaveLength(1);
    expect(received[0]?.frame.serverCommandVersion).toBe("0.9.2");
    expect(received[0]?.isReconnect).toBe(false);
  });

  it("ignores malformed welcome frames without crashing", async () => {
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          ws.send(JSON.stringify({ type: "server:welcome", serverCommandVersion: "", serverTimeMs: -5 }));
          return;
        }
        if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_test0002",
      getAccessToken: async () => "test-token",
    });

    const received: ServerWelcome[] = [];
    connection.on("server:welcome", (w) => received.push(w));

    await connection.connect();
    await new Promise((r) => setTimeout(r, 20));
    await connection.disconnect();

    expect(received).toHaveLength(0);
  });
});
