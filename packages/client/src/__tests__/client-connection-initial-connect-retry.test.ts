import { createServer, type Server as HttpServer } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../client-connection.js";

/**
 * Regression: a transient DNS hiccup / server cold-start at process startup
 * used to propagate the openWebSocket reject through `connect()` and out to
 * the CLI, which then exited and let systemd's restart timer take over.
 * The live reconnect path already has exponential backoff — connect() should
 * use the same loop instead of leaning on the supervisor.
 */
describe("ClientConnection — initial connect retry", () => {
  let port = 0;

  beforeEach(async () => {
    // Allocate a free port without holding it bound, so the test below can
    // bind it when it wants to simulate the server coming up.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const addr = probe.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    port = addr.port;
    await new Promise<void>((r) => probe.close(() => r()));
  });

  it("keeps retrying until the server comes up", async () => {
    const url = `http://127.0.0.1:${port}`;

    const connection = new ClientConnection({
      serverUrl: url,
      clientId: "client_retry",
      getAccessToken: async () => "tok",
    });
    let errorCount = 0;
    connection.on("error", () => {
      errorCount++;
    });

    const connectPromise = connection.connect();

    let httpServer: HttpServer | null = null;
    let wss: WebSocketServer | null = null;
    try {
      // Bring the server up after a couple of failed attempts so we exercise
      // both "failure → backoff" and the eventual "success after retry"
      // transition. ~2.5s is enough for ≥2 retry attempts (1s, 2s backoff).
      setTimeout(() => {
        httpServer = createServer();
        wss = new WebSocketServer({ server: httpServer, path: "/api/v1/agent/ws/client" });
        wss.on("connection", (ws: WebSocket) => {
          ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw)) as { type: string };
            if (msg.type === "auth") {
              ws.send(JSON.stringify({ type: "auth:ok" }));
            } else if (msg.type === "client:register") {
              ws.send(JSON.stringify({ type: "client:registered" }));
            }
          });
        });
        httpServer.listen(port, "127.0.0.1");
      }, 2500);

      await connectPromise;
      expect(connection.isConnected).toBe(true);
      // At least one retry must have happened before the server came up.
      expect(errorCount).toBeGreaterThanOrEqual(1);
    } finally {
      await connection.disconnect();
      if (wss) await new Promise<void>((r) => (wss as WebSocketServer).close(() => r()));
      if (httpServer) await new Promise<void>((r) => (httpServer as HttpServer).close(() => r()));
    }
  }, 15_000);

  it("disconnect() during the initial-connect backoff exits promptly", async () => {
    const url = `http://127.0.0.1:${port}`;

    const connection = new ClientConnection({
      serverUrl: url,
      clientId: "client_retry_abort",
      getAccessToken: async () => "tok",
    });
    connection.on("error", () => {});

    const connectPromise = connection.connect();

    // Let one attempt fail so we're sitting in the backoff sleep, then ask
    // for disconnect. The abort signal should cut the sleep short and the
    // next loop iteration sees closing=true → throws.
    await new Promise<void>((r) => setTimeout(r, 200));
    const t0 = Date.now();
    const disconnectPromise = connection.disconnect();

    await expect(connectPromise).rejects.toBeDefined();
    await disconnectPromise;
    // Should NOT have waited the full 1s backoff; allow generous slack but
    // still well below the schedule.
    expect(Date.now() - t0).toBeLessThan(700);
  }, 10_000);
});
