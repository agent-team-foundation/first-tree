import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as clientConnectionModule from "../client-connection.js";
import { type BoundAgent, ClientConnection } from "../client-connection.js";

type CoverageHelpers = {
  waitWithAbort(ms: number, signal: AbortSignal): Promise<void>;
  decodeJwtExp(token: string): number | null;
};

type PendingBind = {
  agentId: string;
  runtimeType: string;
  runtimeVersion?: string;
  resolve: (agent: BoundAgent) => void;
  reject: (err: Error) => void;
};

type FakeSocket = {
  readyState: number;
  sent: Array<Record<string, unknown>>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
};

type ClientConnectionPrivate = {
  ws: FakeSocket | null;
  registered: boolean;
  closing: boolean;
  pausedReason: "auth_rejected" | "auth_refresh_failed" | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  authRefreshTimer: ReturnType<typeof setTimeout> | null;
  wsConnectTimer: ReturnType<typeof setTimeout> | null;
  nextReconnectMinDelayMs: number;
  boundAgents: Map<string, BoundAgent>;
  desiredBindings: Map<string, { agentId: string; runtimeType: string; runtimeVersion?: string }>;
  pendingBinds: Map<string, PendingBind>;
  bindRetryRecords: Map<string, { attempts: number; nextAllowedAt: number; lastReason: string | null }>;
  pendingImageWrites: Set<Promise<void>>;
  handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void;
  rebindAgents(): void;
  enterPausedMode(reason: "auth_rejected" | "auth_refresh_failed", error: Error): void;
  scheduleReconnect(): void;
  startHeartbeat(): void;
  stopHeartbeat(): void;
  clearTimers(): void;
  rejectAllPendingBinds(reason: string): void;
  scheduleProactiveAuthRefresh(token: string): void;
  runProactiveAuthRefresh(): Promise<void>;
  openWebSocket(): Promise<void>;
};

const helpers = (clientConnectionModule as unknown as { __coverage: CoverageHelpers }).__coverage;

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function makeConnection(overrides: Partial<ConstructorParameters<typeof ClientConnection>[0]> = {}): ClientConnection {
  return new ClientConnection({
    serverUrl: "http://127.0.0.1:1",
    clientId: "client_edge",
    getAccessToken: async () => makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  });
}

function priv(connection: ClientConnection): ClientConnectionPrivate {
  return connection as unknown as ClientConnectionPrivate;
}

function attachOpenSocket(connection: ClientConnection): FakeSocket {
  const socket: FakeSocket = {
    readyState: WebSocket.OPEN,
    sent: [],
    send: vi.fn((raw: string) => {
      socket.sent.push(JSON.parse(raw) as Record<string, unknown>);
    }),
    close: vi.fn(() => {
      socket.readyState = WebSocket.CLOSED;
    }),
    terminate: vi.fn(() => {
      socket.readyState = WebSocket.CLOSED;
    }),
    ping: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  const internal = priv(connection);
  internal.ws = socket;
  internal.registered = true;
  return socket;
}

function makeInboxFrame(entryId: number): Record<string, unknown> {
  return {
    type: "inbox:deliver",
    entryId,
    inboxId: "agent_a",
    chatId: "chat_a",
    message: {
      id: `msg_${entryId}`,
      chatId: "chat_a",
      senderId: "user_a",
      format: "text",
      content: "hello",
      metadata: {},
      inReplyTo: null,
      source: "web",
      createdAt: new Date().toISOString(),
      configVersion: 1,
      recipientMode: "full",
      precedingMessages: [],
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ClientConnection — edge coverage", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.FIRST_TREE_CLIENT_ID;
  });

  it("covers JWT helper and constructor fallback edges", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(helpers.waitWithAbort(10_000, aborted.signal)).resolves.toBeUndefined();

    expect(helpers.decodeJwtExp("not-a-jwt")).toBeNull();
    expect(helpers.decodeJwtExp("header..sig")).toBeNull();
    expect(helpers.decodeJwtExp(`header.${Buffer.from("{bad").toString("base64url")}.sig`)).toBeNull();
    expect(helpers.decodeJwtExp(makeJwt({ exp: "not-number" }))).toBeNull();
    expect(helpers.decodeJwtExp(makeJwt({ exp: 123 }))).toBe(123);
    expect(helpers.decodeJwtExp(makeJwt({ exp: 456 }))).toBe(456);

    process.env.FIRST_TREE_CLIENT_ID = "client_from_env";
    expect(makeConnection({ clientId: undefined }).clientId).toBe("client_from_env");
    delete process.env.FIRST_TREE_CLIENT_ID;
    expect(makeConnection({ clientId: undefined }).clientId).toMatch(/^client_/);
  });

  it("covers public send/report methods on open and closed sockets", async () => {
    const connection = makeConnection();
    const internal = priv(connection);

    connection.sendInboxAck(1);
    internal.ws = {
      readyState: WebSocket.CLOSED,
      sent: [],
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      ping: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    connection.sendInboxAck(3);
    internal.ws = null;
    await expect(connection.bindAgent("agent_a", "codex")).rejects.toThrow("Client not connected");
    connection.reportSessionState("agent_a", "chat_a", "active");
    await connection.unbindAgent("agent_a");
    connection.reportRuntimeState("agent_a", "idle");
    connection.reportSessionRuntime("agent_a", "chat_a", "idle");
    connection.reportSessionEvent("agent_a", "chat_a", { kind: "message", payload: {} } as unknown as SessionEvent);
    connection.sendSessionReconcile("agent_a", ["chat_a"]);

    const socket = attachOpenSocket(connection);
    internal.boundAgents.set("agent_a", {
      agentId: "agent_a",
      displayName: "Agent A",
      agentType: "agent",
      sdk: {} as BoundAgent["sdk"],
    });

    expect(connection.agents.has("agent_a")).toBe(true);
    connection.sendInboxAck(2);
    connection.reportSessionState("agent_a", "chat_a", "suspended");
    connection.reportRuntimeState("agent_a", "working");
    connection.reportSessionRuntime("agent_a", "chat_a", "blocked");
    connection.reportSessionEvent("agent_a", "chat_a", {
      kind: "tool_call",
      payload: { resultPreview: `abc\u0000${"x".repeat(4)}` },
    } as unknown as SessionEvent);
    connection.sendSessionReconcile("agent_a", ["chat_a"]);
    await connection.unbindAgent("agent_a");

    expect(socket.sent.map((frame) => frame.type)).toEqual([
      "inbox:ack",
      "session:state",
      "runtime:state",
      "session:runtime",
      "session:event",
      "session:reconcile",
      "agent:unbind",
    ]);
    expect(internal.boundAgents.has("agent_a")).toBe(false);
  });

  it("covers auth/register, agent, session, image, inbox, and error frame handling", async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "ftt-client-edge-home-"));
    const oldHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = tmpHome;
    try {
      const updateAttempt = { status: "failed", targetVersion: "1.2.3", attemptedAt: new Date().toISOString() };
      const connection = makeConnection({
        getLastUpdateAttempt: () => updateAttempt as never,
        userAgent: "edge-agent",
      });
      const internal = priv(connection);
      const socket = attachOpenSocket(connection);
      const events: string[] = [];
      const delivered: number[] = [];
      const errors: string[] = [];

      connection.on("agent:bound", (agent) =>
        events.push(`bound:${agent.agentId}:${agent.displayName}:${agent.agentType}`),
      );
      connection.on("agent:unbound", (agentId) => events.push(`unbound:${agentId}`));
      connection.on("agent:pinned", (message) => events.push(`pinned:${message.agentId}`));
      connection.on("session:command", (command) =>
        events.push(`command:${command.type}:${command.agentId}:${command.chatId}`),
      );
      connection.on("session:reconcile:result", (result) =>
        events.push(`reconcile:${result.agentId}:${result.staleChatIds[0]}`),
      );
      connection.on("inbox:deliver", (_agentId, frame) => delivered.push(frame.entryId));
      connection.on("error", (err) => errors.push(err.message));

      internal.handleMessage({ type: "auth:ok" });
      expect(socket.sent.at(-1)).toMatchObject({
        type: "client:register",
        clientId: "client_edge",
        lastUpdateAttempt: updateAttempt,
      });

      const throwingUpdateConnection = makeConnection({
        getLastUpdateAttempt: () => {
          throw new Error("disk failed");
        },
      });
      const throwingSocket = attachOpenSocket(throwingUpdateConnection);
      priv(throwingUpdateConnection).handleMessage({ type: "auth:ok" });
      expect(throwingSocket.sent.at(-1)).toMatchObject({ type: "client:register", clientId: "client_edge" });

      const pendingAgent = new Promise<BoundAgent>((resolve, reject) => {
        internal.pendingBinds.set("ref-bound", { agentId: "agent_a", runtimeType: "codex", resolve, reject });
      });
      internal.handleMessage({ type: "agent:bound", ref: "ref-bound", agentId: "agent_a", displayName: null });
      await expect(pendingAgent).resolves.toMatchObject({
        agentId: "agent_a",
        displayName: "agent_a",
        agentType: "agent",
      });
      internal.handleMessage({ type: "agent:bound", agentId: "agent_no_ref" });

      internal.handleMessage({ type: "agent:pinned", agentId: "agent_a", name: "agent-a", runtime: "codex" });
      internal.handleMessage({ type: "agent:unbound", agentId: "agent_a" });
      internal.boundAgents.set("agent_force", {
        agentId: "agent_force",
        displayName: "Force",
        agentType: "agent",
        sdk: {} as BoundAgent["sdk"],
      });
      internal.handleMessage({ type: "agent:force_disconnect", agentId: "agent_force" });
      internal.handleMessage({ type: "session:suspend", agentId: "agent_a", chatId: "chat_a" });
      internal.handleMessage({ type: "session:terminate", agentId: "agent_a", chatId: "chat_b" });
      internal.handleMessage({ type: "session:reconcile:result", agentId: "agent_a", staleChatIds: ["chat_stale"] });
      internal.handleMessage({ type: "session:reconcile:result", agentId: "agent_a", staleChatIds: "bad" });

      internal.handleMessage({ type: "client:register:rejected", code: "OTHER" });
      internal.closing = false;
      internal.ws = socket;
      internal.registered = true;
      internal.boundAgents.set("agent_reconnect", {
        agentId: "agent_reconnect",
        displayName: "Reconnect",
        agentType: "agent",
        sdk: {} as BoundAgent["sdk"],
      });
      internal.handleMessage({ type: "client:registered" });

      internal.handleMessage({
        type: "image_payload",
        imageId: "bad",
        chatId: "chat_a",
        mimeType: "image/png",
        base64: "",
      });
      internal.handleMessage({
        type: "image_payload",
        imageId: "00000000-0000-4000-8000-000000000001",
        chatId: "chat_a",
        mimeType: "image/png",
        base64: Buffer.from("hi").toString("base64"),
        filename: "x.png",
      });
      await Promise.all([...internal.pendingImageWrites]);

      const oldHomeForFailure = process.env.FIRST_TREE_HOME;
      process.env.FIRST_TREE_HOME = "/dev/null/first-tree-image-failure";
      internal.handleMessage({
        type: "image_payload",
        imageId: "00000000-0000-4000-8000-000000000002",
        chatId: "chat_a",
        mimeType: "image/png",
        base64: Buffer.from("hi").toString("base64"),
        filename: "x.png",
      });
      await Promise.all([...internal.pendingImageWrites]);
      process.env.FIRST_TREE_HOME = oldHomeForFailure;

      let releaseImageWrite: () => void = () => {};
      const pendingWrite = new Promise<void>((resolve) => {
        releaseImageWrite = resolve;
      });
      internal.pendingImageWrites.add(pendingWrite);
      internal.handleMessage(makeInboxFrame(41));
      expect(delivered).toEqual([]);
      releaseImageWrite();
      await flushMicrotasks();
      expect(delivered).toEqual([41]);

      internal.pendingImageWrites.clear();
      internal.handleMessage(makeInboxFrame(42));
      expect(delivered).toEqual([41, 42]);
      internal.handleMessage({ type: "inbox:deliver", entryId: 43, inboxId: "agent_a", chatId: "chat_a" });

      const pendingError = new Promise<BoundAgent>((resolve, reject) => {
        internal.pendingBinds.set("ref-error", { agentId: "agent_err", runtimeType: "codex", resolve, reject });
      });
      internal.handleMessage({ type: "error", ref: "ref-error", message: "bind exploded" });
      await expect(pendingError).rejects.toThrow("bind exploded");
      internal.handleMessage({ type: "error", message: "plain error" });

      expect(events).toEqual(
        expect.arrayContaining([
          "bound:agent_a:agent_a:agent",
          "unbound:agent_a",
          "unbound:agent_force",
          "command:session:suspend:agent_a:chat_a",
          "command:session:terminate:agent_a:chat_b",
          "reconcile:agent_a:chat_stale",
        ]),
      );
      expect(errors).toContain("plain error");
    } finally {
      if (oldHome === undefined) {
        delete process.env.FIRST_TREE_HOME;
      } else {
        process.env.FIRST_TREE_HOME = oldHome;
      }
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("covers bind rejection, rebind recovery, skip, and failed rebind paths", async () => {
    vi.useFakeTimers();
    const connection = makeConnection();
    const internal = priv(connection);
    const socket = attachOpenSocket(connection);
    const events: string[] = [];
    connection.on("resilience.bind.skipped", (payload) => events.push(`skipped:${payload.agentId}`));
    connection.on("resilience.bind.recovered", (payload) =>
      events.push(`recovered:${payload.agentId}:${payload.totalAttempts}`),
    );
    connection.on("resilience.bind.disabled", (payload) =>
      events.push(`disabled:${payload.agentId}:${payload.reasonCode}`),
    );
    connection.on("agent:unbound", (agentId) => events.push(`unbound:${agentId}`));
    connection.on("reconnected", () => events.push("reconnected"));

    internal.desiredBindings.set("agent_skip", { agentId: "agent_skip", runtimeType: "codex" });
    internal.bindRetryRecords.set("agent_skip", {
      attempts: 2,
      nextAllowedAt: Date.now() + 60_000,
      lastReason: "wrong_client",
    });
    internal.desiredBindings.set("agent_ok", { agentId: "agent_ok", runtimeType: "codex", runtimeVersion: "1" });
    internal.bindRetryRecords.set("agent_ok", {
      attempts: 3,
      nextAllowedAt: Date.now() - 1,
      lastReason: "wrong_client",
    });
    internal.desiredBindings.set("agent_bad", { agentId: "agent_bad", runtimeType: "codex" });

    internal.rebindAgents();
    const bindFrames = socket.sent.filter((frame) => frame.type === "agent:bind");
    expect(bindFrames.map((frame) => frame.agentId)).toEqual(["agent_ok", "agent_bad"]);

    internal.handleMessage({
      type: "agent:bound",
      ref: bindFrames[0]?.ref,
      agentId: "agent_ok",
      displayName: "Agent OK",
      agentType: "assistant",
    });
    internal.handleMessage({
      type: "agent:bind:rejected",
      ref: bindFrames[1]?.ref,
      reason: "unknown_agent",
    });
    await flushMicrotasks();

    expect(events).toEqual(
      expect.arrayContaining([
        "reconnected",
        "skipped:agent_skip",
        "recovered:agent_ok:3",
        "disabled:agent_bad:bind_unknown_agent",
        "unbound:agent_bad",
      ]),
    );

    internal.handleMessage({ type: "agent:bind:rejected", reason: undefined });
  });

  it("covers paused-mode, reconnect, heartbeat, timer, and pending-bind utilities", async () => {
    vi.useFakeTimers();
    const connection = makeConnection();
    const internal = priv(connection);
    let socket = attachOpenSocket(connection);
    const events: string[] = [];
    connection.on("auth:paused", (reason) => events.push(`paused:${reason}`));
    connection.on("auth:fatal", () => events.push("fatal"));
    connection.on("resilience.connection.paused", (payload) => events.push(`paused-event:${payload.reason}`));
    connection.on("reconnecting", (attempt) => events.push(`reconnecting:${attempt}`));
    connection.on("error", (err) => events.push(`error:${err.message}`));

    connection.clearPaused();
    internal.reconnectTimer = setTimeout(() => {}, 1_000);
    internal.enterPausedMode("auth_rejected", new Error("rejected"));
    expect(internal.reconnectTimer).toBeNull();
    internal.enterPausedMode("auth_rejected", new Error("again"));
    internal.scheduleReconnect();
    expect(events).toEqual(expect.arrayContaining(["paused:auth_rejected", "fatal", "paused-event:auth_rejected"]));

    internal.ws = null;
    internal.registered = false;
    connection.clearPaused();
    expect(internal.reconnectTimer).not.toBeNull();
    internal.clearTimers();

    internal.nextReconnectMinDelayMs = 10;
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    internal.scheduleReconnect();
    expect(events).toContain("reconnecting:1");
    internal.clearTimers();

    internal.closing = true;
    internal.scheduleReconnect();
    internal.closing = false;

    socket = attachOpenSocket(connection);
    internal.pausedReason = "auth_rejected";
    internal.startHeartbeat();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent.some((frame) => frame.type === "heartbeat" && frame.pausedReason === "auth_rejected")).toBe(
      true,
    );
    expect(socket.ping).toHaveBeenCalled();
    socket.send.mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    await vi.advanceTimersByTimeAsync(30_000);
    internal.stopHeartbeat();
    internal.ws = null;
    internal.startHeartbeat();
    await vi.advanceTimersByTimeAsync(30_000);
    internal.stopHeartbeat();

    const pendingRejected: { current: Error | null } = { current: null };
    internal.pendingBinds.set("pending", {
      agentId: "agent_pending",
      runtimeType: "codex",
      resolve: () => {},
      reject: (err: Error) => {
        pendingRejected.current = err;
      },
    });
    internal.rejectAllPendingBinds("nope");
    expect(pendingRejected.current?.message).toBe("nope");

    internal.authRefreshTimer = setTimeout(() => {}, 1_000);
    internal.wsConnectTimer = setTimeout(() => {}, 1_000) as never;
    internal.reconnectTimer = setTimeout(() => {}, 1_000);
    internal.clearTimers();
    expect(internal.authRefreshTimer).toBeNull();
    expect(internal.wsConnectTimer).toBeNull();
    expect(internal.reconnectTimer).toBeNull();
  });

  it("covers disconnect on a connecting socket and proactive refresh failure paths", async () => {
    vi.useFakeTimers();
    const connecting = makeConnection();
    const connectingInternal = priv(connecting);
    const connectingSocket = attachOpenSocket(connecting);
    connectingSocket.readyState = WebSocket.CONNECTING;
    await connecting.disconnect();
    expect(connectingSocket.terminate).toHaveBeenCalled();

    const rateLimited = new Error("limited");
    rateLimited.name = "AuthRefreshRateLimitedError";
    Object.assign(rateLimited, { retryAfterMs: 1234 });
    const rateLimitedConnection = makeConnection({
      getAccessToken: async () => {
        throw rateLimited;
      },
    });
    const rateLimitedSocket = attachOpenSocket(rateLimitedConnection);
    await priv(rateLimitedConnection).runProactiveAuthRefresh();
    expect(priv(rateLimitedConnection).nextReconnectMinDelayMs).toBe(1234);
    expect(rateLimitedSocket.close).toHaveBeenCalledWith(1000, "proactive auth refresh");

    const failed = new Error("revoked");
    failed.name = "AuthRefreshFailedError";
    const failedConnection = makeConnection({
      getAccessToken: async () => {
        throw failed;
      },
    });
    const failedSocket = attachOpenSocket(failedConnection);
    const failedEvents: string[] = [];
    failedConnection.on("auth:paused", (reason) => failedEvents.push(reason));
    await priv(failedConnection).runProactiveAuthRefresh();
    expect(failedEvents).toEqual(["auth_refresh_failed"]);
    expect(failedSocket.close).not.toHaveBeenCalled();

    const genericConnection = makeConnection({
      getAccessToken: async () => {
        throw "plain failure";
      },
    });
    const genericSocket = attachOpenSocket(genericConnection);
    await priv(genericConnection).runProactiveAuthRefresh();
    expect(genericSocket.close).toHaveBeenCalledWith(1000, "proactive auth refresh");

    const closingConnection = makeConnection();
    const closingInternal = priv(closingConnection);
    closingInternal.closing = true;
    await closingInternal.runProactiveAuthRefresh();

    const scheduledConnection = makeConnection();
    const scheduledInternal = priv(scheduledConnection);
    scheduledInternal.scheduleProactiveAuthRefresh(makeJwt({ exp: Math.floor(Date.now() / 1000) - 1 }));
    expect(scheduledInternal.authRefreshTimer).toBeNull();

    connectingInternal.clearTimers();
  });
});
