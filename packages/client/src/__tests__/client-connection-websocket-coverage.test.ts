import { EventEmitter } from "node:events";
import type { SessionEvent } from "@first-tree/shared";
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
  boundAgents: Map<string, BoundAgent>;
  bindRetryRecords: Map<string, { attempts: number; nextAllowedAt: number; lastReason: string | null }>;
  closing: boolean;
  pausedReason: "auth_rejected" | "auth_refresh_failed" | null;
  nextReconnectMinDelayMs: number;
  desiredBindings: Map<string, { agentId: string; runtimeType: string; runtimeVersion?: string }>;
  pendingBinds: Map<string, PendingBind>;
  handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void;
  openWebSocket(): Promise<void>;
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

  it("covers closed-socket public send helpers and disconnect cleanup paths", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const disconnected: string[] = [];
    connection.on("disconnected", () => disconnected.push("disconnected"));

    expect(connection.agents.size).toBe(0);
    connection.clearPaused();
    connection.sendInboxAck(123);
    await expect(connection.bindAgent("agent-closed", "codex")).rejects.toThrow("Client not connected");
    await expect(connection.unbindAgent("agent-closed")).resolves.toBeUndefined();
    connection.reportSessionState("agent-closed", "chat-1", "active");
    connection.reportRuntimeState("agent-closed", "idle");
    connection.reportSessionRuntime("agent-closed", "chat-1", "working");
    const event = {
      kind: "tool_call",
      payload: { args: {}, name: "bash", status: "ok", toolUseId: "tool-1", resultPreview: "ok" },
    } satisfies SessionEvent;
    connection.reportSessionEvent("agent-closed", "chat-1", event);
    connection.sendSessionReconcile("agent-closed", ["chat-1"]);

    const pending = internal.sendBind("agent-pending", "codex").catch((error: Error) => error.message);
    internal.ws = new FakeWebSocket("ws://pending");
    internal.ws.readyState = FakeWebSocket.CONNECTING;
    await connection.disconnect();

    await expect(pending).resolves.toBe("Client disconnected");
    expect(internal.ws).toBeNull();
    expect(disconnected).toEqual(["disconnected"]);
  });

  it("covers open-socket public send helpers and event sanitization", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = new FakeWebSocket("ws://open");
    socket.readyState = FakeWebSocket.OPEN;
    internal.ws = socket;

    await connection.unbindAgent("agent-open");
    connection.reportSessionState("agent-open", "chat-1", "active");
    connection.reportRuntimeState("agent-open", "working");
    connection.reportSessionRuntime("agent-open", "chat-1", "blocked");
    connection.sendInboxAck(321);
    connection.sendSessionReconcile("agent-open", ["chat-1", "chat-2"]);
    connection.reportSessionEvent("agent-open", "chat-1", {
      kind: "tool_call",
      payload: {
        args: {},
        name: "download",
        resultPreview: "zip\u0000\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD",
        status: "ok",
        toolUseId: "tool-1",
      },
    });

    expect(socket.sent.map((raw) => JSON.parse(raw) as { type: string }).map((frame) => frame.type)).toEqual([
      "agent:unbind",
      "session:state",
      "runtime:state",
      "session:runtime",
      "inbox:ack",
      "session:reconcile",
      "session:event",
    ]);
    const eventFrame = JSON.parse(socket.sent.at(-1) ?? "{}") as { event?: SessionEvent };
    expect(eventFrame.event?.payload).toMatchObject({
      resultPreview: "[binary content, 9 chars elided]",
      status: "ok",
      toolUseId: "tool-1",
    });
  });

  it("covers direct message dispatch branches for binds, commands, pinned agents, and inbox delivery", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const seen: string[] = [];
    connection.on("agent:bound", (agent) => seen.push(`bound:${agent.displayName}:${agent.agentType}`));
    connection.on("agent:bind:rejected", (reason, agentId) => seen.push(`rejected:${agentId}:${reason}`));
    connection.on("agent:pinned", (message) => seen.push(`pinned:${message.agentId}`));
    connection.on("agent:unbound", (agentId) => seen.push(`unbound:${agentId}`));
    connection.on("session:command", (command) =>
      seen.push(`command:${command.type}:${command.agentId}:${command.chatId}`),
    );
    connection.on("session:reconcile:result", (result) =>
      seen.push(`reconcile:${result.agentId}:${result.staleChatIds.join("+")}`),
    );
    connection.on("inbox:deliver", (inboxId, frame) => seen.push(`deliver:${inboxId}:${frame.entryId}`));
    connection.on("error", (error) => seen.push(`error:${error.message}`));
    connection.on("resilience.bind.disabled", (payload) =>
      seen.push(`disabled:${payload.agentId}:${payload.reasonCode}`),
    );

    const boundPromise = internal.sendBind("agent-bound", "codex");
    const boundRef = [...internal.pendingBinds.keys()][0];
    internal.handleMessage({ type: "agent:bound", agentId: "agent-bound", ref: boundRef, displayName: null });
    const bound = await boundPromise;
    expect(bound.displayName).toBe("agent-bound");
    expect(bound.agentType).toBe("agent");

    internal.handleMessage({ type: "agent:unbound", agentId: "agent-bound" });
    internal.boundAgents.set("agent-force", { ...bound, agentId: "agent-force", displayName: "Force" });
    internal.handleMessage({ type: "agent:force_disconnect", agentId: "agent-force" });
    internal.handleMessage({ type: "session:suspend", agentId: "agent-a", chatId: "chat-1" });
    internal.handleMessage({ type: "session:terminate", agentId: "agent-a", chatId: "chat-2" });
    internal.handleMessage({
      type: "session:reconcile:result",
      agentId: "agent-a",
      staleChatIds: ["chat-3", "chat-4"],
    });
    internal.handleMessage({
      type: "agent:pinned",
      agentId: "agent-pinned",
      name: "atlas",
      displayName: "Atlas",
      agentType: "agent",
      runtimeProvider: "codex",
    });
    internal.handleMessage({ type: "agent:pinned", agentId: "bad" });

    const rejectedPromise = internal.sendBind("agent-rejected", "codex").catch((error: Error) => error.message);
    const rejectedRef = [...internal.pendingBinds.keys()].at(-1);
    internal.handleMessage({ type: "agent:bind:rejected", ref: rejectedRef, reason: "unknown_agent" });
    await expect(rejectedPromise).resolves.toBe("agent:bind rejected (unknown_agent)");
    expect(internal.bindRetryRecords.get("agent-rejected")?.nextAllowedAt).toBe(Number.MAX_SAFE_INTEGER);

    const pendingError = internal.sendBind("agent-error", "codex").catch((error: Error) => error.message);
    const errorRef = [...internal.pendingBinds.keys()].at(-1);
    internal.handleMessage({ type: "error", ref: errorRef, message: "bind exploded" });
    await expect(pendingError).resolves.toBe("bind exploded");
    internal.handleMessage({ type: "error", message: "loose error" });

    internal.handleMessage({
      type: "inbox:deliver",
      entryId: 44,
      inboxId: "inbox-1",
      chatId: "chat-1",
      message: {
        id: "msg-1",
        chatId: "chat-1",
        senderId: "agent-human",
        format: "text",
        content: "hello",
        metadata: {},
        inReplyTo: null,
        source: null,
        createdAt: "2026-05-28T00:00:00.000Z",
        configVersion: 1,
        recipientMode: "full",
        precedingMessages: [],
      },
    });

    expect(seen).toEqual([
      "bound:agent-bound:agent",
      "unbound:agent-bound",
      "unbound:agent-force",
      "command:session:suspend:agent-a:chat-1",
      "command:session:terminate:agent-a:chat-2",
      "reconcile:agent-a:chat-3+chat-4",
      "pinned:agent-pinned",
      "disabled:agent-rejected:bind_unknown_agent",
      "rejected:agent-rejected:unknown_agent",
      "error:loose error",
      "deliver:inbox-1:44",
    ]);
  });

  it("covers reconnect jitter floor and successful timer-driven reopen", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const internal = priv(connection);
    const reconnecting: number[] = [];
    connection.on("reconnecting", (attempt) => reconnecting.push(attempt));
    internal.nextReconnectMinDelayMs = 5_000;
    internal.openWebSocket = vi.fn(async () => undefined);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    internal.scheduleReconnect();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(reconnecting).toEqual([1]);
    expect(internal.openWebSocket).toHaveBeenCalledOnce();
    expect(internal.nextReconnectMinDelayMs).toBe(0);
    randomSpy.mockRestore();
    internal.clearTimers();
  });
});
