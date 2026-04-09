import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("WebSocket single-connection constraint", () => {
  const appPromise = createTestApp();
  let addr: string;

  beforeAll(async () => {
    const app = await appPromise;
    addr = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => (await appPromise).close());

  /** Open a WS and return it once open. */
  function connectWs(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const url = `${addr.replace(/^http/, "ws")}/api/v1/agent/ws/inbox`;
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  /** Wait for a WS close event and return its code. */
  function waitForClose(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => {
      ws.on("close", (code) => resolve(code));
    });
  }

  it("allows first WebSocket connection", async () => {
    const app = await appPromise;
    const { token } = await createTestAgent(app, { name: `ws-a1-${crypto.randomUUID().slice(0, 6)}` });
    const ws = await connectWs(token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("rejects second WebSocket connection with 4009", async () => {
    const app = await appPromise;
    const { token } = await createTestAgent(app, { name: `ws-a2-${crypto.randomUUID().slice(0, 6)}` });

    // First connection
    const first = await connectWs(token);
    expect(first.readyState).toBe(WebSocket.OPEN);

    // Second connection — it opens first (HTTP upgrade completes),
    // then the handler detects duplicate and closes with 4009
    const second = await connectWs(token);
    const closeCode = await waitForClose(second);
    expect(closeCode).toBe(4009);

    first.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("allows reconnection after first WS is closed", async () => {
    const app = await appPromise;
    const { token } = await createTestAgent(app, { name: `ws-a3-${crypto.randomUUID().slice(0, 6)}` });

    // First connection
    const first = await connectWs(token);
    expect(first.readyState).toBe(WebSocket.OPEN);

    // Close first connection and wait for close event propagation
    first.close();
    await new Promise((r) => setTimeout(r, 300));

    // Second connection should succeed
    const second = await connectWs(token);
    expect(second.readyState).toBe(WebSocket.OPEN);
    second.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("rejects unauthenticated WebSocket with HTTP 401", async () => {
    const url = `${addr.replace(/^http/, "ws")}/api/v1/agent/ws/inbox`;
    const ws = new WebSocket(url, {
      headers: { Authorization: "Bearer invalid-token" },
    });

    const error = await new Promise<{ message: string }>((resolve) => {
      ws.on("error", (err) => resolve(err));
    });

    // ws client throws an error for non-101 HTTP upgrade response
    expect(error.message).toContain("401");
  });
});
