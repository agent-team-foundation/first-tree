import { EventEmitter } from "node:events";
import type { ClientPausedReason, SessionEvent } from "@first-tree/shared";
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

type BindRetryRecord = {
  attempts: number;
  nextAllowedAt: number;
  lastReason: string | null;
};

type ClientConnectionPrivate = {
  ws: FakeWebSocket | null;
  closing: boolean;
  registered: boolean;
  pausedReason: ClientPausedReason | null;
  authRefreshTimer: ReturnType<typeof setTimeout> | null;
  desiredBindings: Map<string, { agentId: string; runtimeType: string; runtimeVersion?: string }>;
  boundAgents: Map<string, BoundAgent>;
  bindRetryRecords: Map<string, BindRetryRecord>;
  pendingBinds: Map<string, PendingBind>;
  openWebSocket(): Promise<void>;
  handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void;
  sendBind(agentId: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent>;
  rebindAgents(): void;
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
    clientId: "client_more_coverage",
    getAccessToken: async () => makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function parseSent(socket: FakeWebSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

async function openRegisteredConnection(
  connection: ClientConnectionInstance,
  capabilities: Record<string, boolean> = {},
): Promise<FakeWebSocket> {
  const internal = priv(connection);
  const openPromise = internal.openWebSocket();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("missing fake socket");
  socket.emitOpen();
  await flushMicrotasks();
  socket.emitMessage({ type: "auth:ok" });
  socket.emitMessage({
    type: "server:welcome",
    serverCommandVersion: "1.0.0",
    serverTimeMs: Date.now(),
    capabilities,
  });
  socket.emitMessage({ type: "client:registered" });
  await openPromise;
  return socket;
}

async function bindAgent(
  connection: ClientConnectionInstance,
  socket: FakeWebSocket,
  agentId = "agent-1",
): Promise<BoundAgent> {
  const bindPromise = priv(connection).sendBind(agentId, "codex");
  const bindFrame = parseSent(socket, socket.sent.length - 1);
  socket.emitMessage({
    type: "agent:bound",
    ref: bindFrame.ref,
    agentId,
    displayName: "Agent One",
    agentType: "agent",
    runtimeSessionToken: `runtime-token-${agentId}`,
  });
  return bindPromise;
}

function sessionEvent(message: string): SessionEvent {
  return { kind: "error", payload: { source: "runtime", message } };
}

describe("ClientConnection — additional branch coverage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("ws");
    vi.resetModules();
  });

  it("swallows malformed and unknown frames without settling pending confirmations", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, {
      wsInboxAckConfirm: true,
      wsSessionEventConfirm: true,
    });
    await bindAgent(connection, socket);

    const delivered: unknown[] = [];
    const commands: unknown[] = [];
    const pins: unknown[] = [];
    const runtimeAuthStarts: unknown[] = [];
    connection.on("inbox:deliver", (agentId, frame) => delivered.push({ agentId, frame }));
    connection.on("session:command", (command) => commands.push(command));
    connection.on("agent:pinned", (message) => pins.push(message));
    connection.on("runtime-auth:start", (command) => runtimeAuthStarts.push(command));

    const eventPromise = connection.reportSessionEventConfirmed("agent-1", "chat-1", sessionEvent("pending"));
    const eventFrame = parseSent(socket, socket.sent.length - 1);
    const ackPromise = connection.sendInboxAck(101);
    const ackFrame = parseSent(socket, socket.sent.length - 1);
    const recoverPromise = connection.sendInboxRecover("agent-1", "chat-1");
    const recoverFrame = parseSent(socket, socket.sent.length - 1);

    socket.emitMessage("{not json");
    socket.emitMessage({ type: "unknown:frame", arbitrary: true });
    socket.emitMessage({ type: "agent:pinned", agentId: 42 });
    socket.emitMessage({ type: "runtime-auth:start", provider: "not-a-provider", ref: "bad" });
    socket.emitMessage({ type: "session:suspend", agentId: "agent-1" });
    socket.emitMessage({ type: "session:reconcile:result", agentId: "agent-1", staleChatIds: "chat-1" });
    socket.emitMessage({ type: "session:event:accepted", ref: eventFrame.ref, agentId: "agent-1" });
    socket.emitMessage({
      type: "session:event:accepted",
      ref: eventFrame.ref,
      agentId: "agent-1",
      chatId: "other-chat",
    });
    socket.emitMessage({ type: "inbox:ack:accepted", entryId: 101, ref: "wrong-ref", disposition: "acked" });
    socket.emitMessage({
      type: "inbox:recover:accepted",
      ref: recoverFrame.ref,
      agentId: "agent-1",
      chatId: "other-chat",
      resetCount: 1,
    });
    socket.emitMessage({ type: "inbox:deliver", entryId: "bad", message: { not: "valid" } });

    expect(delivered).toEqual([]);
    expect(commands).toEqual([]);
    expect(pins).toEqual([]);
    expect(runtimeAuthStarts).toEqual([]);

    socket.emitMessage({
      type: "session:event:accepted",
      ref: eventFrame.ref,
      agentId: "agent-1",
      chatId: "chat-1",
    });
    socket.emitMessage({
      type: "inbox:ack:accepted",
      entryId: 101,
      ref: ackFrame.ref,
      disposition: "acked",
    });
    socket.emitMessage({
      type: "inbox:recover:accepted",
      ref: recoverFrame.ref,
      agentId: "agent-1",
      chatId: "chat-1",
      resetCount: 2,
    });

    await expect(eventPromise).resolves.toBeUndefined();
    await expect(ackPromise).resolves.toBeUndefined();
    await expect(recoverPromise).resolves.toBeUndefined();
  });

  it("times out confirmed session events and keeps later rejection frames from double-settling", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, { wsSessionEventConfirm: true });
    await bindAgent(connection, socket);

    const pending = connection.reportSessionEventConfirmed("agent-1", "chat-timeout", sessionEvent("timeout"));
    const frame = parseSent(socket, socket.sent.length - 1);
    const rejection = expect(pending).rejects.toThrow("session:event rejected (timeout)");

    await vi.advanceTimersByTimeAsync(3_000);
    socket.emitMessage({
      type: "session:event:rejected",
      ref: frame.ref,
      agentId: "agent-1",
      chatId: "chat-timeout",
      reason: "late_rejection",
    });

    await rejection;
  });

  it("rejects agent-scoped recoveries and session events when a rebind is rejected or skipped", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, {
      wsInboxAckConfirm: true,
      wsSessionEventConfirm: true,
    });
    await bindAgent(connection, socket);

    const recovering = connection.sendInboxRecover("agent-1", "chat-recover");
    const reporting = connection.reportSessionEventConfirmed("agent-1", "chat-report", sessionEvent("reporting"));
    const rebindPromise = internal.sendBind("agent-1", "codex");
    const rebindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bind:rejected",
      ref: rebindFrame.ref,
      reason: "wrong_client",
    });

    await expect(rebindPromise).rejects.toThrow("wrong_client");
    await expect(recovering).rejects.toThrow("agent_bind_rejected:wrong_client");
    await expect(reporting).rejects.toThrow("agent_bind_rejected:wrong_client");

    const skippedRecover = connection.sendInboxRecover("agent-1", "chat-skipped-recover");
    const skippedEvent = connection.reportSessionEventConfirmed(
      "agent-1",
      "chat-skipped-event",
      sessionEvent("skipped"),
    );
    internal.desiredBindings.set("agent-1", { agentId: "agent-1", runtimeType: "codex" });
    internal.bindRetryRecords.set("agent-1", {
      attempts: 2,
      nextAllowedAt: Date.now() + 60_000,
      lastReason: "bind_wrong_client",
    });
    internal.rebindAgents();

    await expect(skippedRecover).rejects.toThrow("agent_rebind_skipped");
    await expect(skippedEvent).rejects.toThrow("agent_rebind_skipped");
  });

  it("handles auth and proactive refresh edges without source changes", async () => {
    const pausedError = new Error("refresh token revoked");
    pausedError.name = "AuthRefreshFailedError";
    let tokenCalls = 0;
    const pausedConnection = await makeConnection({
      getAccessToken: async () => {
        tokenCalls += 1;
        if (tokenCalls === 1) return makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        throw pausedError;
      },
    });
    const pausedSocket = await openRegisteredConnection(pausedConnection);
    const paused: ClientPausedReason[] = [];
    pausedConnection.on("auth:paused", (reason) => paused.push(reason));

    await priv(pausedConnection).runProactiveAuthRefresh();

    expect(pausedConnection.isPaused()).toBe(true);
    expect(paused).toEqual(["auth_refresh_failed"]);
    expect(pausedSocket.closeCalls).toEqual([]);

    let genericCalls = 0;
    const genericConnection = await makeConnection({
      getAccessToken: async () => {
        genericCalls += 1;
        if (genericCalls === 1) return makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        throw "plain proactive failure";
      },
    });
    const genericSocket = await openRegisteredConnection(genericConnection);

    await priv(genericConnection).runProactiveAuthRefresh();

    expect(genericSocket.closeCalls.at(-1)).toEqual({ code: 1000, reason: "proactive auth refresh" });
  });

  it("skips proactive timers for malformed, no-exp, and near-expiry tokens", async () => {
    for (const token of ["not-a-jwt", makeJwt({ sub: "user-1" }), makeJwt({ exp: Math.floor(Date.now() / 1000) })]) {
      const connection = await makeConnection({ getAccessToken: async () => token });
      await openRegisteredConnection(connection);

      expect(priv(connection).authRefreshTimer).toBeNull();
      priv(connection).clearTimers();
    }
  });

  it("continues registration when update metadata throws and surfaces socket errors", async () => {
    const connection = await makeConnection({
      getLastUpdateAttempt: () => {
        throw "metadata read failed";
      },
    });
    const errors: string[] = [];
    connection.on("error", (err) => errors.push(err.message));

    const socket = await openRegisteredConnection(connection);
    const registerFrame = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((msg) => {
        return msg.type === "client:register";
      });
    expect(registerFrame).toMatchObject({ type: "client:register", clientId: "client_more_coverage" });
    expect(registerFrame).not.toHaveProperty("lastUpdateAttempt");

    socket.emit("error", new Error("socket broke"));

    expect(errors).toEqual(["socket broke"]);
  });

  it("rejects pending binds on error frames and terminates connecting sockets during disconnect", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection);

    const bindPromise = priv(connection).sendBind("agent-error", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({ type: "error", ref: bindFrame.ref, message: "bind failed remotely" });
    await expect(bindPromise).rejects.toThrow("bind failed remotely");

    const unhandledErrors: string[] = [];
    connection.on("error", (err) => unhandledErrors.push(err.message));
    socket.emitMessage({ type: "error", message: "unscoped server error" });
    expect(unhandledErrors).toEqual(["unscoped server error"]);

    const connectingConnection = await makeConnection();
    const connectingSocket = new FakeWebSocket("ws://ws.test/api/v1/agent/ws/client");
    priv(connectingConnection).ws = connectingSocket;
    await connectingConnection.disconnect();

    expect(connectingSocket.terminate).toHaveBeenCalledOnce();
  });
});
