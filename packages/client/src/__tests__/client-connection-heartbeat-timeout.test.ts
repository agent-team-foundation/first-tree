import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../client-connection.js";

/**
 * Regression: if the OS suspends/resumes (or any silent middlebox drops the
 * TCP half) the WebSocket can stay `readyState === OPEN` forever while no
 * frames actually flow. The silence watchdog inside startHeartbeat must
 * terminate such a socket so the close handler drives a reconnect; without
 * it, the client appears alive but never delivers another inbox push and
 * the operator has to restart the service by hand.
 */
describe("ClientConnection — heartbeat silence watchdog", () => {
  let httpServer: HttpServer;
  let wss: WebSocketServer;
  let serverUrl: string;

  beforeEach(async () => {
    httpServer = createServer();
    // autoPong:false means the server stops replying to ws.ping() while still
    // accepting the connection. Combined with not sending any application
    // frames after `client:registered`, this is the cleanest model of a
    // wedged peer the client can reach in a unit test.
    wss = new WebSocketServer({ server: httpServer, path: "/api/v1/agent/ws/client", autoPong: false });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server address");
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("terminates a wedged socket after the silence timeout and reconnects", async () => {
    let connectionCount = 0;
    const setupSocket = (ws: WebSocket) => {
      connectionCount++;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
        } else if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
        // heartbeats: deliberately don't reply, combined with autoPong:false
        // above this is a fully-silent peer post-handshake.
      });
    };
    wss.on("connection", setupSocket);

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_silent",
      getAccessToken: async () => "tok",
      // Tight cadence so the test budget stays sub-2s. 50/150 means a missed
      // pong trips the watchdog on the 4th tick (~200ms after handshake).
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 150,
    });
    connection.on("error", () => {});

    await connection.connect();
    expect(connection.isConnected).toBe(true);
    expect(connectionCount).toBe(1);

    // Watchdog trip (~200ms) + reconnect base delay (1s) + second handshake
    // (~50ms) → wait 1800ms with comfortable slack.
    await new Promise<void>((r) => setTimeout(r, 1800));

    expect(connectionCount).toBeGreaterThanOrEqual(2);

    await connection.disconnect();
  });
});
