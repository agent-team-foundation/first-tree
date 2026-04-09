import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

/**
 * Unit tests for ClientConnection — mock WebSocket, no real server.
 *
 * Focus:
 * - ref-based correlation for bind responses (P1-1)
 * - error responses matched to correct pending bind via ref (P1-3)
 * - pending binds rejected on WS close (P2-3)
 * - pending binds rejected on disconnect() (P2-4)
 * - reconnect triggers rebind for all boundAgents (P2-1)
 * - connect() fast-fails on early socket closure (P2-2)
 */

// -- Mock WebSocket --

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  terminate() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  removeAllListeners() {
    super.removeAllListeners();
    return this;
  }

  receiveMessage(msg: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }
}

// Track the latest mock WS instance
let latestMockWs: MockWebSocket;

vi.mock("ws", () => {
  // Must use Reflect.construct to return a custom object from `new WebSocket(url)`
  // while satisfying biome's no-constructor-return rule.
  function createMockWs() {
    const instance = new MockWebSocket();
    latestMockWs = instance;
    setTimeout(() => {
      if (instance.readyState === MockWebSocket.CONNECTING) {
        instance.simulateOpen();
      }
    }, 0);
    return instance;
  }
  const MockWS = new Proxy(createMockWs, {
    construct: () => createMockWs() as object,
  });
  Object.assign(MockWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  return { default: MockWS, __esModule: true };
});

// Must import AFTER vi.mock
const { ClientConnection } = await import("../client-connection.js");

/** Parse a sent message by index. Throws if missing. */
function parseSent(ws: MockWebSocket, idx: number): Record<string, string> {
  const raw = ws.sent[idx];
  if (!raw) throw new Error(`No message at index ${idx}`);
  return JSON.parse(raw) as Record<string, string>;
}

function createConn() {
  return new ClientConnection({ serverUrl: "http://localhost:9999" });
}

/** Connect and register (simulates full server handshake). */
async function connectAndRegister(conn: ReturnType<typeof createConn>) {
  const connectPromise = conn.connect();
  await vi.waitFor(() => {
    expect(latestMockWs.sent.length).toBeGreaterThanOrEqual(1);
  });
  latestMockWs.receiveMessage({ type: "client:registered", clientId: conn.clientId });
  await connectPromise;
  return latestMockWs;
}

describe("ClientConnection: ref-based bind correlation", () => {
  it("bindAgent sends ref in the request", async () => {
    const conn = createConn();
    const ws = await connectAndRegister(conn);

    const bindPromise = conn.bindAgent("aghub_test123", "claude-code");

    await vi.waitFor(() => {
      expect(ws.sent.length).toBeGreaterThanOrEqual(2);
    });

    const bindMsg = parseSent(ws, 1);
    expect(bindMsg.type).toBe("agent:bind");
    expect(bindMsg.ref).toBeDefined();
    expect(typeof bindMsg.ref).toBe("string");
    expect(bindMsg.token).toBe("aghub_test123");

    ws.receiveMessage({
      type: "agent:bound",
      ref: bindMsg.ref,
      agentId: "agent-uuid-1",
      displayName: "Test Agent",
      agentType: "autonomous_agent",
    });

    const bound = await bindPromise;
    expect(bound.agentId).toBe("agent-uuid-1");
    expect(bound.token).toBe("aghub_test123");

    await conn.disconnect();
  });

  it("matches out-of-order responses correctly via ref", async () => {
    const conn = createConn();
    const ws = await connectAndRegister(conn);

    const bind1 = conn.bindAgent("aghub_token_A", "type-a");
    const bind2 = conn.bindAgent("aghub_token_B", "type-b");

    await vi.waitFor(() => {
      expect(ws.sent.length).toBeGreaterThanOrEqual(3);
    });

    const msg1 = parseSent(ws, 1);
    const msg2 = parseSent(ws, 2);

    // Respond in REVERSE order
    ws.receiveMessage({ type: "agent:bound", ref: msg2.ref, agentId: "agent-B", agentType: "type-b" });
    ws.receiveMessage({ type: "agent:bound", ref: msg1.ref, agentId: "agent-A", agentType: "type-a" });

    const [result1, result2] = await Promise.all([bind1, bind2]);

    expect(result1.agentId).toBe("agent-A");
    expect(result1.token).toBe("aghub_token_A");
    expect(result2.agentId).toBe("agent-B");
    expect(result2.token).toBe("aghub_token_B");

    await conn.disconnect();
  });
});

describe("ClientConnection: error response matched via ref", () => {
  it("rejects the correct pending bind when error carries ref", async () => {
    const conn = createConn();
    const ws = await connectAndRegister(conn);

    const bind1 = conn.bindAgent("aghub_good", "type-a");
    const bind2 = conn.bindAgent("aghub_bad", "type-b");

    await vi.waitFor(() => {
      expect(ws.sent.length).toBeGreaterThanOrEqual(3);
    });

    const msg1 = parseSent(ws, 1);
    const msg2 = parseSent(ws, 2);

    ws.receiveMessage({ type: "error", ref: msg2.ref, message: "Invalid token" });
    ws.receiveMessage({ type: "agent:bound", ref: msg1.ref, agentId: "agent-good" });

    const result1 = await bind1;
    expect(result1.agentId).toBe("agent-good");
    expect(result1.token).toBe("aghub_good");

    await expect(bind2).rejects.toThrow("Invalid token");

    await conn.disconnect();
  });
});

describe("ClientConnection: pending binds rejected on WS close", () => {
  it("rejects all pending binds when WebSocket closes", async () => {
    const conn = createConn();
    await connectAndRegister(conn);

    const bind1 = conn.bindAgent("aghub_t1", "type-a");
    const bind2 = conn.bindAgent("aghub_t2", "type-b");

    await vi.waitFor(() => {
      expect(latestMockWs.sent.length).toBeGreaterThanOrEqual(3);
    });

    // Simulate WS drop — disconnect first to prevent reconnect timer leak
    await conn.disconnect();

    await expect(bind1).rejects.toThrow("Client disconnected");
    await expect(bind2).rejects.toThrow("Client disconnected");
  });
});

describe("ClientConnection: pending binds rejected on disconnect()", () => {
  it("rejects all pending binds when disconnect() is called", async () => {
    const conn = createConn();
    await connectAndRegister(conn);

    const bind1 = conn.bindAgent("aghub_d1", "type-a");

    await vi.waitFor(() => {
      expect(latestMockWs.sent.length).toBeGreaterThanOrEqual(2);
    });

    await conn.disconnect();

    await expect(bind1).rejects.toThrow("Client disconnected");
  });
});

describe("ClientConnection: reconnect triggers rebind", () => {
  it("re-sends agent:bind for all boundAgents after reconnection", async () => {
    const conn = createConn();
    const ws1 = await connectAndRegister(conn);

    // Bind an agent
    const bindPromise = conn.bindAgent("aghub_recon", "claude-code");

    await vi.waitFor(() => {
      expect(ws1.sent.length).toBeGreaterThanOrEqual(2);
    });

    const bindMsg = parseSent(ws1, 1);
    ws1.receiveMessage({
      type: "agent:bound",
      ref: bindMsg.ref,
      agentId: "agent-recon-1",
      agentType: "claude-code",
    });
    await bindPromise;
    expect(conn.agents.size).toBe(1);

    // Simulate WS drop — triggers reconnect
    ws1.readyState = MockWebSocket.CLOSED;
    ws1.emit("close");

    // Wait for reconnect timer (1s) to create a new WS
    await vi.waitFor(
      () => {
        expect(latestMockWs).not.toBe(ws1);
      },
      { timeout: 5000 },
    );

    const ws2 = latestMockWs;

    // Wait for ws2 to open and send client:register
    await vi.waitFor(() => {
      expect(ws2.sent.length).toBeGreaterThanOrEqual(1);
    });

    const registerMsg = parseSent(ws2, 0);
    expect(registerMsg.type).toBe("client:register");
    expect(registerMsg.clientId).toBe(conn.clientId);

    // Server responds with client:registered — triggers rebind
    ws2.receiveMessage({ type: "client:registered", clientId: conn.clientId });

    // rebindAgents runs synchronously within handleMessage
    expect(ws2.sent.length).toBeGreaterThanOrEqual(2);

    const rebindMsg = parseSent(ws2, 1);
    expect(rebindMsg.type).toBe("agent:bind");
    expect(rebindMsg.token).toBe("aghub_recon");
    expect(rebindMsg.ref).toBeDefined();

    // Complete the rebind handshake before disconnecting
    ws2.receiveMessage({
      type: "agent:bound",
      ref: rebindMsg.ref,
      agentId: "agent-recon-1",
      agentType: "claude-code",
    });

    await conn.disconnect();
  });
});

describe("ClientConnection: connect() fast-fail", () => {
  it("rejects if WS closes before registration", async () => {
    const conn = createConn();

    const connectPromise = conn.connect();

    await vi.waitFor(() => {
      expect(latestMockWs).toBeDefined();
    });

    // Close before auto-open fires
    latestMockWs.readyState = MockWebSocket.CLOSED;
    latestMockWs.emit("close");

    await expect(connectPromise).rejects.toThrow("WebSocket closed before registration");
  });
});
