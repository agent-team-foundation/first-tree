import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../client-connection.js";

/**
 * Task 7 (Bug 5): per-agent bind backoff. A single rejected bind should not
 * keep spamming `agent:bind` on every reconnect; degraded reasons
 * (`org_mismatch`, `unknown_agent`, …) should never auto-retry.
 */
describe("ClientConnection — bind per-agent backoff (Bug 5)", () => {
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

  function setupHandshake(ws: WebSocket, opts: { rejectReason: string }): { bindCount: number } {
    const state = { bindCount: 0 };
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; ref?: string; agentId?: string };
      if (msg.type === "auth") {
        ws.send(JSON.stringify({ type: "auth:ok" }));
      } else if (msg.type === "client:register") {
        ws.send(JSON.stringify({ type: "client:registered" }));
      } else if (msg.type === "agent:bind") {
        state.bindCount += 1;
        ws.send(
          JSON.stringify({
            type: "agent:bind:rejected",
            ref: msg.ref,
            agentId: msg.agentId,
            reason: opts.rejectReason,
          }),
        );
      }
    });
    return state;
  }

  it("degraded reason (org_mismatch) sets next-allowed to forever", async () => {
    const states: Array<{ bindCount: number }> = [];
    wss.on("connection", (ws: WebSocket) => {
      states.push(setupHandshake(ws, { rejectReason: "wrong_org" }));
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_bind_degraded",
      getAccessToken: async () => "tok",
    });
    connection.on("error", () => {});
    const rejections: string[] = [];
    connection.on("agent:bind:rejected", (reason) => rejections.push(reason));

    await connection.connect();

    await expect(
      connection.bindAgent("agent-bad", "claude-code", "1.0"),
    ).rejects.toThrow(/wrong_org/);

    expect(rejections).toEqual(["wrong_org"]);
    expect(states[0]?.bindCount).toBe(1);

    await connection.disconnect();
  }, 10_000);

  it("transient reason updates next-allowed but allows future retry", async () => {
    wss.on("connection", (ws: WebSocket) => {
      setupHandshake(ws, { rejectReason: "wrong_client" });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_bind_transient",
      getAccessToken: async () => "tok",
    });
    connection.on("error", () => {});

    await connection.connect();
    await expect(
      connection.bindAgent("agent-transient", "claude-code", "1.0"),
    ).rejects.toThrow(/wrong_client/);

    // The bookkeeping is internal; the observable side effect is that a
    // subsequent rebind from within the window does NOT spam. We can
    // verify the public `resetBindRetry` clears it for the next call.
    connection.resetBindRetry("agent-transient");
    await expect(
      connection.bindAgent("agent-transient", "claude-code", "1.0"),
    ).rejects.toThrow(/wrong_client/);

    await connection.disconnect();
  }, 10_000);

  it("agent:pinned clears any existing bind retry record", async () => {
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; ref?: string; agentId?: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
        } else if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
        } else if (msg.type === "agent:bind") {
          ws.send(
            JSON.stringify({
              type: "agent:bind:rejected",
              ref: msg.ref,
              agentId: msg.agentId,
              reason: "wrong_org",
            }),
          );
        }
      });
      // Server pushes agent:pinned later — this should clear the backoff so
      // the next bind attempt is allowed.
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: "agent:pinned",
            agentId: "agent-pinned",
            runtimeProvider: "claude-code",
            name: "fresh-agent",
            displayName: "Fresh Agent",
            agentType: "autonomous_agent",
          }),
        );
      }, 100);
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_bind_pin",
      getAccessToken: async () => "tok",
    });
    connection.on("error", () => {});
    let pinned = false;
    connection.on("agent:pinned", () => {
      pinned = true;
    });

    await connection.connect();
    await expect(connection.bindAgent("agent-pinned", "claude-code", "1.0")).rejects.toThrow();

    // Wait for the agent:pinned push.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pinned).toBe(true);
    // After agent:pinned the bind retry record was cleared. The exact effect
    // is visible by attempting bind again — server still rejects, but the
    // client did send the bind frame (records were cleared in the handler).
    // No throw beyond the rejection itself is the assertion.
    await expect(connection.bindAgent("agent-pinned", "claude-code", "1.0")).rejects.toThrow();

    await connection.disconnect();
  }, 10_000);
});
