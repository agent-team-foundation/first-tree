import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundAgent } from "../client-connection.js";

type ClientConnectionModule = typeof import("../client-connection.js");
type ClientConnectionInstance = InstanceType<ClientConnectionModule["ClientConnection"]>;
type ClientConnectionConfig = ConstructorParameters<ClientConnectionModule["ClientConnection"]>[0];

type PendingBind = {
  agentId: string;
  runtimeType: string;
  runtimeVersion?: string;
  resolve: (agent: BoundAgent) => void;
  reject: (err: Error) => void;
};

type ClientConnectionPrivate = {
  ws: FakeWebSocket | null;
  closing: boolean;
  pausedReason: "auth_rejected" | "auth_refresh_failed" | null;
  nextReconnectMinDelayMs: number;
  desiredBindings: Map<string, { agentId: string; runtimeType: string; runtimeVersion?: string }>;
  boundAgents: Map<string, BoundAgent>;
  pendingBinds: Map<string, PendingBind>;
  openWebSocket(): Promise<void>;
  handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void;
  sendBind(agentId: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent>;
  rebindAgents(): void;
  scheduleReconnect(): void;
  runProactiveAuthRefresh(): Promise<void>;
  clearTimers(): void;
};

type FakeWebSocketOptions = {
  headers?: Record<string, string>;
};

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly options?: FakeWebSocketOptions;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminate = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });
  ping = vi.fn();

  constructor(url: string, options?: FakeWebSocketOptions) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeCalls.push({ code, reason });
    this.emit("close", code ?? 1000);
  }

  removeAllListeners(eventName?: string | symbol): this {
    super.removeAllListeners(eventName);
    return this;
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  emitMessage(frame: string | Record<string, unknown>): void {
    this.emit("message", typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  emitPong(): void {
    this.emit("pong");
  }
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function priv(connection: ClientConnectionInstance): ClientConnectionPrivate {
  return connection as unknown as ClientConnectionPrivate;
}

async function loadClientConnection(): Promise<ClientConnectionModule> {
  vi.resetModules();
  FakeWebSocket.instances = [];
  vi.doMock("ws", () => ({ default: FakeWebSocket }));
  return import("../client-connection.js");
}

async function makeConnection(overrides: Partial<ClientConnectionConfig> = {}): Promise<ClientConnectionInstance> {
  const { ClientConnection } = await loadClientConnection();
  return new ClientConnection({
    serverUrl: "http://ws.test",
    clientId: "client_ws_coverage",
    getAccessToken: async () => makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ClientConnection — WebSocket edge coverage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("ws");
    vi.resetModules();
  });

  it("covers successful mocked open, malformed frames, pong, and user-agent headers", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection({ userAgent: "first-tree-test" });
    const internal = priv(connection);

    const openPromise = internal.openWebSocket();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing fake socket");

    expect(socket.url).toBe("ws://ws.test/api/v1/agent/ws/client");
    expect(socket.options).toEqual({ headers: { "User-Agent": "first-tree-test" } });

    socket.emitMessage("{bad json");
    socket.emitPong();
    socket.emitOpen();
    await flushMicrotasks();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({ type: "auth" });

    socket.emitMessage({ type: "client:registered" });
    await expect(openPromise).resolves.toBeUndefined();

    internal.clearTimers();
  });

  it("covers the connect timeout path and late settle guard", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const internal = priv(connection);

    const openPromise = internal.openWebSocket();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing fake socket");

    expect(socket.options).toBeUndefined();

    const rejection = expect(openPromise).rejects.toThrow("WebSocket connect timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(socket.terminate).toHaveBeenCalledOnce();

    socket.emitOpen();
    await flushMicrotasks();
    socket.emitMessage({ type: "client:registered" });

    internal.clearTimers();
  });

  it("covers auth failures during open, including rate-limit retry floors", async () => {
    const rateLimited = new Error("limited");
    rateLimited.name = "AuthRefreshRateLimitedError";
    const rateLimitedConnection = await makeConnection({
      getAccessToken: async () => {
        throw rateLimited;
      },
    });
    const rateLimitedPromise = priv(rateLimitedConnection).openWebSocket();
    const rateLimitedRejection = expect(rateLimitedPromise).rejects.toThrow("limited");
    const rateLimitedSocket = FakeWebSocket.instances[0];
    if (!rateLimitedSocket) throw new Error("missing fake socket");
    rateLimitedSocket.emitOpen();

    await rateLimitedRejection;
    expect(priv(rateLimitedConnection).nextReconnectMinDelayMs).toBe(30_000);
    expect(rateLimitedSocket.closeCalls.length).toBe(1);

    const plainConnection = await makeConnection({
      getAccessToken: async () => {
        throw "plain auth failure";
      },
    });
    const plainPromise = priv(plainConnection).openWebSocket();
    const plainRejection = expect(plainPromise).rejects.toThrow("plain auth failure");
    const plainSocket = FakeWebSocket.instances[0];
    if (!plainSocket) throw new Error("missing fake socket");
    plainSocket.emitOpen();

    await plainRejection;
    expect(plainSocket.closeCalls.length).toBe(1);
  });

  it("covers non-Error initial connect failures and paused-after-backoff exit", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const internal = priv(connection);
    const errors: string[] = [];
    internal.openWebSocket = vi.fn(async () => {
      throw "plain connect failure";
    });
    connection.on("error", (err) => errors.push(err.message));

    const connectPromise = connection.connect();
    const rejection = expect(connectPromise).rejects.toBe("plain connect failure");
    await flushMicrotasks();
    internal.pausedReason = "auth_rejected";
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
    expect(errors).toEqual(["plain connect failure"]);
  });

  it("covers non-Error rebind and reconnect catches", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const internal = priv(connection);
    const events: string[] = [];
    connection.on("agent:unbound", (agentId) => events.push(`unbound:${agentId}`));
    connection.on("error", (err) => {
      events.push(`error:${err.message}`);
      internal.closing = true;
    });

    internal.desiredBindings.set("agent_plain", { agentId: "agent_plain", runtimeType: "codex" });
    internal.sendBind = vi.fn(async () => {
      throw "plain rebind failure";
    });
    internal.rebindAgents();
    await flushMicrotasks();
    expect(events).toContain("unbound:agent_plain");

    internal.closing = false;
    internal.openWebSocket = vi.fn(async () => {
      throw "plain reconnect failure";
    });
    internal.scheduleReconnect();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(events).toContain("error:plain reconnect failure");

    internal.clearTimers();
  });

  it("emits force-disconnect reason on agent:unbound", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const events: Array<{ agentId: string; reason?: string }> = [];
    connection.on("agent:unbound", (agentId, reason) => events.push({ agentId, reason }));

    internal.boundAgents.set("agent-suspended", {
      agentId: "agent-suspended",
      displayName: "Suspended Agent",
      agentType: "agent",
      sdk: {} as BoundAgent["sdk"],
    });

    internal.handleMessage({
      type: "agent:force_disconnect",
      agentId: "agent-suspended",
      reason: "agent_suspended",
    });

    expect(events).toEqual([{ agentId: "agent-suspended", reason: "agent_suspended" }]);
    expect(internal.boundAgents.has("agent-suspended")).toBe(false);
  });

  it("covers proactive refresh rate-limit fallback without Retry-After", async () => {
    const rateLimited = new Error("limited");
    rateLimited.name = "AuthRefreshRateLimitedError";
    const connection = await makeConnection({
      getAccessToken: async () => {
        throw rateLimited;
      },
    });
    const internal = priv(connection);

    await internal.runProactiveAuthRefresh();

    expect(internal.nextReconnectMinDelayMs).toBe(30_000);
  });
});
