import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../client-connection.js";

/**
 * Regression: the proactive auth refresh path must call `getAccessToken`
 * with a `minValidityMs` past the lead window BEFORE closing the socket —
 * not after, via the reconnect's open handler. The "refresh-then-close"
 * order collapses the per-cycle disconnect window from "≥1s base reconnect
 * delay + a /auth/refresh round-trip" down to "just a TCP/WS handshake",
 * because the reconnect's open handler reads the freshly-cached token from
 * disk and skips a second HTTP refresh.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("ClientConnection — proactive refresh order", () => {
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

  it("calls getAccessToken with minValidity past the lead window before triggering the close", async () => {
    // Token expires 62s from now → proactive timer (exp - 60s lead) fires
    // ~2s after handshake. Long enough for the test to set up but short
    // enough to keep wall-clock budget reasonable. Anything ≤60s would make
    // scheduleProactiveAuthRefresh's `if (delay <= 0) return` skip the
    // schedule entirely, which is itself the documented short-token path.
    const shortLived = makeJwt({ exp: Math.floor(Date.now() / 1000) + 62 });

    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });

    const tokenCalls: Array<{ minValidityMs?: number; at: number }> = [];
    let firstCloseAt: number | null = null;

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_proactive",
      getAccessToken: async (opts) => {
        tokenCalls.push({ minValidityMs: opts?.minValidityMs, at: Date.now() });
        return shortLived;
      },
    });
    connection.on("error", () => {});
    connection.on("disconnected", () => {
      if (firstCloseAt === null) firstCloseAt = Date.now();
    });

    await connection.connect();
    expect(connection.isConnected).toBe(true);
    // After initial handshake the open handler made one getAccessToken call.
    expect(tokenCalls.length).toBe(1);

    // Wait for the proactive refresh to fire. Polling tokenCalls is more
    // direct than waiting on a "connected" event — we want to observe the
    // ORDER of (refresh-call, close) regardless of whether the reconnect
    // succeeds.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("proactive refresh did not fire within 4s")), 4000);
      const check = (): void => {
        if (tokenCalls.length >= 2) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });

    const proactiveCall = tokenCalls[1];
    if (!proactiveCall) throw new Error("missing proactive call");
    // The whole point of the change: proactive must request a token still
    // valid past the lead window so ensureFreshAccessToken treats the
    // cached one as stale and rotates it.
    expect(proactiveCall.minValidityMs).toBeGreaterThanOrEqual(65_000);
    // And it must land BEFORE the close (the regression: the original
    // implementation only triggered ws.close, with the refresh happening
    // only inside the reconnect's open handler).
    if (firstCloseAt !== null) {
      expect(proactiveCall.at).toBeLessThanOrEqual(firstCloseAt);
    }

    await connection.disconnect();
  }, 10_000);
});
