import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../client-connection.js";

/**
 * Task 4 (Bug 2): `auth:rejected` / `AuthRefreshFailedError` no longer flips
 * the connection into a permanent `closing=true` state — instead the
 * connection enters paused mode (events `auth:paused` + `auth:fatal`) and
 * stops attempting reconnects. The consumer (CLI) is expected to drive
 * `clearPaused()` when fresh credentials arrive.
 */
describe("ClientConnection — auth paused mode (Bug 2)", () => {
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

  it("AuthRefreshFailedError enters paused mode, does not loop reconnects", async () => {
    let socketCount = 0;
    wss.on("connection", () => {
      socketCount++;
    });

    class AuthRefreshFailedError extends Error {
      constructor() {
        super("Refresh token rejected by server.");
        this.name = "AuthRefreshFailedError";
      }
    }

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_refresh",
      getAccessToken: async () => {
        throw new AuthRefreshFailedError();
      },
    });

    const events: string[] = [];
    const pausedReasons: string[] = [];
    connection.on("auth:paused", (reason) => {
      events.push("auth:paused");
      pausedReasons.push(reason);
    });
    connection.on("auth:fatal", () => events.push("auth:fatal"));
    connection.on("reconnecting", () => events.push("reconnecting"));
    connection.on("error", () => {});

    await expect(connection.connect()).rejects.toThrow(/Refresh token/);
    expect(connection.isPaused()).toBe(true);
    expect(connection.getPausedReason()).toBe("auth_refresh_failed");
    expect(events).toContain("auth:paused");
    expect(events).toContain("auth:fatal");
    expect(events).not.toContain("reconnecting");
    expect(pausedReasons).toEqual(["auth_refresh_failed"]);

    // Give any racing reconnect timer one tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(socketCount).toBeLessThanOrEqual(1);

    await connection.disconnect();
  }, 10_000);

  it("server-side auth:rejected enters paused mode and stops reconnecting", async () => {
    // Server accepts the WS handshake, takes the auth frame, then rejects.
    let attempts = 0;
    wss.on("connection", (ws: WebSocket) => {
      attempts++;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:rejected" }));
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_rejected",
      getAccessToken: async () => "tok",
    });

    const events: string[] = [];
    connection.on("auth:paused", (reason) => events.push(`paused:${reason}`));
    connection.on("auth:fatal", () => events.push("fatal"));
    connection.on("reconnecting", () => events.push("reconnecting"));
    connection.on("error", () => {});

    await expect(connection.connect()).rejects.toThrow();
    expect(connection.isPaused()).toBe(true);
    expect(connection.getPausedReason()).toBe("auth_rejected");

    await new Promise((resolve) => setTimeout(resolve, 300));
    // First attempt may legitimately be retried once before paused mode
    // kicked in; assert we capped well under the pre-fix 1Hz storm.
    expect(attempts).toBeLessThanOrEqual(2);
    expect(events).toContain("paused:auth_rejected");

    await connection.disconnect();
  }, 10_000);

  it("clearPaused emits auth:resumed and re-arms reconnect", async () => {
    class AuthRefreshFailedError extends Error {
      constructor() {
        super("Refresh token rejected.");
        this.name = "AuthRefreshFailedError";
      }
    }

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_clearpaused",
      getAccessToken: async () => {
        throw new AuthRefreshFailedError();
      },
    });

    connection.on("error", () => {});
    await expect(connection.connect()).rejects.toThrow();
    expect(connection.isPaused()).toBe(true);

    const resumes: string[] = [];
    connection.on("auth:resumed", (prev) => resumes.push(prev));

    connection.clearPaused();
    expect(connection.isPaused()).toBe(false);
    expect(resumes).toEqual(["auth_refresh_failed"]);

    await connection.disconnect();
  }, 10_000);
});
