import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection, ClientRetiredError } from "../client-connection.js";

describe("ClientConnection - client:register CLIENT_RETIRED", () => {
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

  it("rejects connect() with ClientRetiredError and does not reconnect", async () => {
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
              code: "CLIENT_RETIRED",
              message: 'Client "client_test" has been retired.',
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

    await expect(connection.connect()).rejects.toBeInstanceOf(ClientRetiredError);

    expect(events).not.toContain("reconnecting");
    expect(socketCount).toBe(1);
    expect(connection.isConnected).toBe(false);

    await connection.disconnect();
  }, 10_000);
});
