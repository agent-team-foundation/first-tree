import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection, ClientUserMismatchError } from "../client-connection.js";

/**
 * Behavior contract under decouple-client-from-identity §4.4 + §4.10.4:
 * when the server rejects `client:register` with
 * `code: "CLIENT_USER_MISMATCH"`, the SDK must
 *   1. reject the `connect()` promise with a typed `ClientUserMismatchError`
 *      (CLI pattern-matches on `instanceof` to show purge-first recovery),
 *   2. stop attempting to reconnect — the same clientId would hit the same
 *      rejection forever, so an auto-reconnect would devolve into a tight
 *      loop the operator can't see and would be a free attack surface
 *      against the server.
 */
describe("ClientConnection — client:register CLIENT_USER_MISMATCH", () => {
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

  it("rejects connect() with ClientUserMismatchError and does not reconnect", async () => {
    let socketCount = 0;
    wss.on("connection", (ws: WebSocket) => {
      socketCount++;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register") {
          ws.send(
            JSON.stringify({
              type: "client:register:rejected",
              code: "CLIENT_USER_MISMATCH",
              message: 'Client "client_test" is owned by a different user.',
            }),
          );
          ws.close(4403, "register rejected");
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_test",
      getAccessToken: async () => "tok",
    });

    const events: string[] = [];
    connection.on("reconnecting", () => events.push("reconnecting"));
    connection.on("error", () => {});

    await expect(connection.connect()).rejects.toBeInstanceOf(ClientUserMismatchError);

    // The承重 assertion: registry mismatch at handshake never schedules a
    // reconnect (cf. plan §4.10.4 / §B test suite).
    expect(events).not.toContain("reconnecting");
    expect(socketCount).toBe(1);
    expect(connection.isConnected).toBe(false);

    await connection.disconnect();
  }, 10_000);
});
