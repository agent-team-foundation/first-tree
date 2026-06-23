import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection, ClientOrgMismatchError } from "../client-connection.js";

/**
 * Behavior contract: when the server rejects `client:register` with
 * `code: "CLIENT_ORG_MISMATCH"`, the SDK must
 *   1. reject the `connect()` promise with a typed `ClientOrgMismatchError`
 *      (CLI pattern-matches on `instanceof` to show purge-first recovery),
 *   2. stop attempting to reconnect — a fresh connection with the same clientId
 *      would just re-trigger the same rejection forever.
 */
describe("ClientConnection — client:register CLIENT_ORG_MISMATCH", () => {
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

  it("rejects connect() with ClientOrgMismatchError and does not reconnect", async () => {
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
              code: "CLIENT_ORG_MISMATCH",
              message: 'Client "client_test" is bound to a different organization.',
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

    await expect(connection.connect()).rejects.toBeInstanceOf(ClientOrgMismatchError);

    // Register rejection at handshake time must never schedule a reconnect —
    // the same clientId would hit the same error on every retry.
    expect(events).not.toContain("reconnecting");
    expect(socketCount).toBe(1);
    expect(connection.isConnected).toBe(false);

    await connection.disconnect();
  }, 10_000);

  it("falls back to a generic Error when the reject frame has no code", async () => {
    wss.on("connection", (ws: WebSocket) => {
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
              message: "already claimed by a different user",
            }),
          );
          ws.close(4403, "register rejected");
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_test_2",
      getAccessToken: async () => "tok",
    });
    connection.on("error", () => {});

    // No CLIENT_ORG_MISMATCH code → callers see a generic Error (triggers the
    // default error branch in the CLI, not the purge-first branch).
    await expect(connection.connect()).rejects.toMatchObject({
      name: "Error",
    });
    await expect(connection.connect().catch((e) => e)).resolves.not.toBeInstanceOf(ClientOrgMismatchError);

    await connection.disconnect();
  }, 10_000);
});
