import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notifier } from "../services/notifier.js";

type SocketHandler = (payload?: unknown) => void | Promise<void>;
type WsRouteHandler = (
  socket: FakeSocket,
  request: { headers: Record<string, string | undefined>; ip: string },
) => void | Promise<void>;

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  closeCode: number | undefined;
  closeReason: string | undefined;
  sent: string[] = [];
  private readonly handlers = new Map<string, SocketHandler[]>();

  on(event: string, handler: SocketHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    for (const handler of this.handlers.get("close") ?? []) {
      void handler(code);
    }
  }

  async emitMessage(payload: unknown): Promise<void> {
    for (const handler of this.handlers.get("message") ?? []) {
      await handler(payload);
    }
  }
}

type DbRows = {
  agentRows?: unknown[];
  aliveRows?: unknown[];
  memberRows?: unknown[];
  updateRows?: unknown[];
  userRows?: unknown[];
};

function createDb(rows: DbRows = {}): Record<string, unknown> {
  return {
    select(selection: Record<string, unknown>) {
      const keys = Object.keys(selection);
      return createChain(() => {
        if (keys.includes("clientUserId")) return rows.agentRows ?? [];
        if (keys.includes("organizationId") && keys.length === 1) return rows.memberRows ?? [];
        if (keys.includes("status")) return rows.userRows ?? [{ id: "user-1", status: "active" }];
        if (keys.includes("chatId")) return rows.aliveRows ?? [];
        return [];
      });
    },
    update: () => createChain(() => rows.updateRows ?? []),
  };
}

function createChain(resolve: () => unknown[]): Record<string, unknown> {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    limit: async () => resolve(),
    orderBy: () => chain,
    returning: async () => resolve(),
    set: () => chain,
    where: () => chain,
  };
  return chain;
}

function frameAt(socket: FakeSocket, index: number): Record<string, unknown> {
  return parseFrame(socket.sent[index] ?? "{}");
}

function sentTypes(socket: FakeSocket): unknown[] {
  return socket.sent.map((item) => parseFrame(item).type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (isRecord(value)) return value;
  const empty: Record<string, unknown> = {};
  return empty;
}

function boundAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: "client-1",
    clientUserId: "user-1",
    displayName: "Atlas",
    id: "agent-1",
    inboxId: "inbox-1",
    managerMemberStatus: "active",
    managerUserId: "user-1",
    organizationId: "org-1",
    runtimeProvider: "claude-code",
    status: "active",
    type: "agent",
    ...overrides,
  };
}

type LoadedRoute = {
  appLog: {
    debug: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  clientService: {
    listActiveAgentsPinnedToClient: ReturnType<typeof vi.fn>;
    registerClient: ReturnType<typeof vi.fn>;
  };
  connectionManager: {
    bindAgentToClient: ReturnType<typeof vi.fn>;
    setClientConnection: ReturnType<typeof vi.fn>;
  };
  handler: WsRouteHandler;
  inboxService: {
    ackEntryByIdForBoundAgents: ReturnType<typeof vi.fn>;
    claimAndBuildForPush: ReturnType<typeof vi.fn>;
    claimBacklogForPush: ReturnType<typeof vi.fn>;
  };
  jwtVerify: ReturnType<typeof vi.fn>;
  notifier: {
    notifySessionEvent: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };
};

async function loadRoute(
  opts: {
    dbRows?: DbRows;
    jwtPayload?: Record<string, unknown>;
    listPinned?: () => Promise<unknown[]>;
    registerClient?: () => Promise<void>;
  } = {},
): Promise<LoadedRoute> {
  vi.resetModules();
  const jwtVerify = vi.fn(async () => ({
    payload: opts.jwtPayload ?? { sub: "user-1", type: "access" },
  }));
  const registerClient = vi.fn(opts.registerClient ?? (async () => {}));
  const listActiveAgentsPinnedToClient = vi.fn(opts.listPinned ?? (async () => []));
  const setClientConnection = vi.fn();
  const bindAgentToClient = vi.fn();
  const ackEntryByIdForBoundAgents = vi.fn(async () => null);
  const claimAndBuildForPush = vi.fn(async () => []);
  const claimBacklogForPush = vi.fn(async () => []);
  const appLog = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() };

  vi.doMock("jose", () => ({ jwtVerify }));
  vi.doMock("../observability/index.js", () => ({
    endWsConnectionSpan: vi.fn(),
    setWsConnectionAttrs: vi.fn(),
    startWsConnectionSpan: vi.fn(),
    withWsMessageSpan: async (
      _socket: unknown,
      _type: string,
      _attrs: Record<string, unknown>,
      fn: () => Promise<void>,
    ) => fn(),
  }));
  vi.doMock("../services/client.js", () => ({
    disconnectClient: vi.fn(async () => {}),
    heartbeatClient: vi.fn(async () => {}),
    listActiveAgentsPinnedToClient,
    registerClient,
  }));
  vi.doMock("../services/agent.js", () => ({
    legacyWireAgentType: (type: string) => type,
  }));
  vi.doMock("../services/connection-manager.js", () => ({
    bindAgentToClient,
    getAgentClientId: vi.fn(() => null),
    isActiveClientConnection: vi.fn(() => true),
    removeClientConnection: vi.fn(),
    setClientConnection,
    unbindAgentFromClient: vi.fn(),
  }));
  vi.doMock("../services/presence.js", () => ({
    bindAgent: vi.fn(async () => {}),
    setRuntimeState: vi.fn(async () => {}),
    touchAgent: vi.fn(async () => {}),
    unbindAgent: vi.fn(async () => {}),
  }));
  vi.doMock("../services/notification.js", () => ({
    markAgentFaultsResolved: vi.fn(async () => {}),
    notifyAgentEvent: vi.fn(async () => {}),
  }));
  vi.doMock("../services/inbox.js", () => ({
    ackEntryByIdForBoundAgents,
    claimAndBuildForPush,
    claimBacklogForPush,
  }));
  vi.doMock("../services/activity.js", () => ({
    setSessionRuntime: vi.fn(async () => {}),
    upsertSessionState: vi.fn(async () => {}),
  }));
  vi.doMock("../services/session-event.js", () => ({
    appendEvent: vi.fn(async () => {}),
  }));

  const { clientWsRoutes } = await import("../api/agent/ws-client.js");
  let handler: WsRouteHandler | null = null;
  const app = {
    commandVersion: () => "0.0.0-test",
    config: {
      inbox: { maxInFlightPerAgent: 1 },
      secrets: { jwtSecret: "test-secret" },
    },
    db: createDb(opts.dbRows),
    get: (_path: string, _options: unknown, routeHandler: WsRouteHandler) => {
      handler = routeHandler;
    },
    log: appLog,
  };
  const notifier = {
    notifySessionEvent: vi.fn(async () => {}),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };

  // Minimal Fastify/Notifier harness: only the fields touched by this route are implemented.
  await clientWsRoutes(notifier as unknown as Notifier, "instance-1")(app as unknown as FastifyInstance);
  if (!handler) throw new Error("expected websocket route registration");

  return {
    appLog,
    clientService: { listActiveAgentsPinnedToClient, registerClient },
    connectionManager: { bindAgentToClient, setClientConnection },
    handler,
    inboxService: { ackEntryByIdForBoundAgents, claimAndBuildForPush, claimBacklogForPush },
    jwtVerify,
    notifier,
  };
}

async function connectSocket(handler: WsRouteHandler): Promise<FakeSocket> {
  const socket = new FakeSocket();
  await handler(socket, { headers: { "user-agent": "vitest" }, ip: "127.0.0.1" });
  return socket;
}

async function authenticate(socket: FakeSocket): Promise<void> {
  await socket.emitMessage(JSON.stringify({ type: "auth", token: "token-1" }));
}

function inboxEntry(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    inboxId: "inbox-1",
    chatId: "chat-1",
    message: {
      id: `msg-${id}`,
      chatId: "chat-1",
      senderId: "agent-human",
      format: "text",
      content: `hello ${id}`,
      metadata: {},
      inReplyTo: null,
      source: null,
      createdAt: "2026-05-28T00:00:00.000Z",
      configVersion: 1,
      recipientMode: "full",
      precedingMessages: [],
    },
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("clientWsRoutes unit branches", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rejects sockets that never send an auth frame", async () => {
    vi.useFakeTimers();
    const { handler } = await loadRoute();
    const socket = await connectSocket(handler);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(frameAt(socket, 0)).toEqual({ type: "auth:rejected", reason: "timeout" });
    expect(socket.closeCode).toBe(4401);
    expect(socket.closeReason).toBe("auth timeout");
  });

  it("handles malformed pre-auth frames without hitting JWT verification", async () => {
    const { handler, jwtVerify } = await loadRoute();
    const invalidJson = await connectSocket(handler);
    await invalidJson.emitMessage("{");
    expect(frameAt(invalidJson, 0)).toEqual({ type: "error", message: "Invalid JSON" });

    const invalidShape = await connectSocket(handler);
    await invalidShape.emitMessage(JSON.stringify({ agentId: "agent-1" }));
    expect(frameAt(invalidShape, 0)).toEqual({ type: "error", message: "Invalid message format" });

    const notAuthenticated = await connectSocket(handler);
    await notAuthenticated.emitMessage(JSON.stringify({ type: "heartbeat" }));
    expect(frameAt(notAuthenticated, 0)).toEqual({ type: "auth:rejected", reason: "not_authenticated" });
    expect(notAuthenticated.closeCode).toBe(4401);
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("rejects malformed auth frames and JWT verification failures", async () => {
    const { handler, jwtVerify } = await loadRoute();
    const invalidAuth = await connectSocket(handler);
    await invalidAuth.emitMessage(JSON.stringify({ type: "auth", token: "" }));
    expect(frameAt(invalidAuth, 0)).toEqual({ type: "auth:rejected", reason: "invalid_frame" });
    expect(invalidAuth.closeReason).toBe("invalid auth");

    jwtVerify.mockRejectedValueOnce(new Error("bad signature"));
    const badToken = await connectSocket(handler);
    await badToken.emitMessage(JSON.stringify({ type: "auth", token: "bad-token" }));
    expect(frameAt(badToken, 0)).toEqual({ type: "auth:rejected", reason: "bad signature" });
    expect(badToken.closeReason).toBe("auth rejected");
  });

  it("rejects invalid claims and inactive users, then expires valid auth sessions", async () => {
    const invalidClaims = await loadRoute({ jwtPayload: { sub: "user-1", type: "refresh" } });
    const invalidClaimsSocket = await connectSocket(invalidClaims.handler);
    await authenticate(invalidClaimsSocket);
    expect(frameAt(invalidClaimsSocket, 0)).toEqual({ type: "auth:rejected", reason: "Invalid token claims" });
    expect(invalidClaimsSocket.closeReason).toBe("auth rejected");

    const inactiveUser = await loadRoute({
      dbRows: { userRows: [{ id: "user-1", status: "suspended" }] },
      jwtPayload: { sub: "user-1", type: "access" },
    });
    const inactiveSocket = await connectSocket(inactiveUser.handler);
    await authenticate(inactiveSocket);
    expect(frameAt(inactiveSocket, 0)).toEqual({ type: "auth:rejected", reason: "User not found or suspended" });
    expect(inactiveSocket.closeReason).toBe("auth rejected");

    vi.useFakeTimers();
    const expiring = await loadRoute({
      jwtPayload: { exp: Math.floor(Date.now() / 1000) + 1, sub: "user-1", type: "access" },
    });
    const expiringSocket = await connectSocket(expiring.handler);
    await authenticate(expiringSocket);
    expect(sentTypes(expiringSocket)).toEqual(["auth:ok", "server:welcome"]);

    await vi.advanceTimersByTimeAsync(1_100);

    expect(frameAt(expiringSocket, expiringSocket.sent.length - 1)).toEqual({ type: "auth:expired" });
    expect(expiringSocket.closeReason).toBe("auth expired");
  });

  it("authenticates, rejects bind-before-register, and rejects users with no active membership", async () => {
    const { handler } = await loadRoute({ dbRows: { memberRows: [] } });
    const socket = await connectSocket(handler);

    await authenticate(socket);
    await socket.emitMessage(
      JSON.stringify({ type: "agent:bind", ref: "bind-1", agentId: "agent-1", runtimeType: "claude-code" }),
    );
    await socket.emitMessage(JSON.stringify({ type: "client:register", clientId: "client-1" }));

    expect(sentTypes(socket)).toContain("auth:ok");
    expect(socket.sent.some((item) => item.includes("Must register client first"))).toBe(true);
    expect(frameAt(socket, socket.sent.length - 1)).toEqual({
      type: "client:register:rejected",
      message: "User has no active organization membership",
    });
    expect(socket.closeCode).toBe(4403);
  });

  it("reports client register failures with a rejected frame", async () => {
    const { clientService, handler } = await loadRoute({
      jwtPayload: { organizationId: "org-1", sub: "user-1", type: "access" },
      registerClient: async () => {
        throw new Error("client owner mismatch");
      },
    });
    const socket = await connectSocket(handler);

    await authenticate(socket);
    await socket.emitMessage(JSON.stringify({ type: "client:register", clientId: "client-1" }));

    expect(clientService.registerClient).toHaveBeenCalled();
    expect(frameAt(socket, socket.sent.length - 1)).toEqual({
      type: "client:register:rejected",
      message: "client owner mismatch",
    });
    expect(socket.closeReason).toBe("client register rejected");
  });

  it("logs pinned-agent backfill failures after a successful client registration", async () => {
    const { appLog, clientService, connectionManager, handler } = await loadRoute({
      jwtPayload: { organizationId: "org-1", sub: "user-1", type: "access" },
      listPinned: async () => {
        throw new Error("pinned lookup failed");
      },
    });
    const socket = await connectSocket(handler);

    await authenticate(socket);
    await socket.emitMessage(JSON.stringify({ type: "client:register", clientId: "client-1", hostname: "devbox" }));

    expect(clientService.listActiveAgentsPinnedToClient).toHaveBeenCalledWith(expect.anything(), "client-1");
    expect(connectionManager.setClientConnection).toHaveBeenCalledWith("client-1", socket);
    expect(sentTypes(socket)).toContain("client:registered");
    expect(appLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client-1" }),
      expect.stringContaining("agent:pinned backfill"),
    );
  });

  it("skips invalid pinned-agent frames and rejects unknown bound agents", async () => {
    const { appLog, handler } = await loadRoute({
      dbRows: { agentRows: [] },
      jwtPayload: { organizationId: "org-1", sub: "user-1", type: "access" },
      listPinned: async () => [{ uuid: "agent-1", name: "", displayName: "Atlas", type: "agent" }],
    });
    const socket = await connectSocket(handler);

    await authenticate(socket);
    await socket.emitMessage(JSON.stringify({ type: "client:register", clientId: "client-1" }));
    await socket.emitMessage(
      JSON.stringify({ type: "agent:bind", ref: "bind-1", agentId: "missing-agent", runtimeType: "claude-code" }),
    );

    expect(appLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", clientId: "client-1" }),
      expect.stringContaining("agent:pinned backfill frame failed schema validation"),
    );
    expect(frameAt(socket, socket.sent.length - 1)).toEqual({
      type: "agent:bind:rejected",
      ref: "bind-1",
      reason: "unknown_agent",
    });
  });

  it("rejects bind requests for suspended, unowned, wrong-client, and race-lost agents", async () => {
    const cases = [
      { agentRows: [boundAgent({ status: "suspended" })], reason: "agent_suspended" },
      { agentRows: [boundAgent({ managerUserId: "user-2" })], reason: "not_owned" },
      { agentRows: [boundAgent({ clientId: "client-2" })], reason: "wrong_client" },
      { agentRows: [boundAgent({ clientUserId: "user-2" })], reason: "not_owned" },
      { agentRows: [boundAgent({ clientId: null })], reason: "wrong_client", updateRows: [] },
    ];

    for (const testCase of cases) {
      const { handler } = await loadRoute({
        dbRows: { agentRows: testCase.agentRows, updateRows: testCase.updateRows },
        jwtPayload: { organizationId: "org-1", sub: "user-1", type: "access" },
      });
      const socket = await connectSocket(handler);
      await authenticate(socket);
      await socket.emitMessage(JSON.stringify({ type: "client:register", clientId: "client-1" }));
      await socket.emitMessage(
        JSON.stringify({ type: "agent:bind", ref: "bind-1", agentId: "agent-1", runtimeType: "claude-code" }),
      );

      expect(frameAt(socket, socket.sent.length - 1)).toEqual({
        type: "agent:bind:rejected",
        ref: "bind-1",
        reason: testCase.reason,
      });
    }
  });

  it("binds, handles malformed bound-agent frames, heartbeats, and unbinds", async () => {
    const { handler } = await loadRoute({
      dbRows: { agentRows: [boundAgent()], aliveRows: [{ chatId: "chat-live" }] },
      jwtPayload: { organizationId: "org-1", sub: "user-1", type: "access" },
    });
    const socket = await connectSocket(handler);

    await authenticate(socket);
    await socket.emitMessage(JSON.stringify({ type: "client:register", clientId: "client-1" }));
    await socket.emitMessage(JSON.stringify({ type: "agent:unbind", agentId: "agent-1" }));
    await socket.emitMessage(
      JSON.stringify({ type: "agent:bind", ref: "bind-1", agentId: "agent-1", runtimeType: "claude-code" }),
    );
    await socket.emitMessage(JSON.stringify({ type: "session:runtime", agentId: "agent-1" }));
    await socket.emitMessage(
      JSON.stringify({ type: "session:reconcile", agentId: "agent-1", chatIds: ["chat-live", "gone"] }),
    );
    await socket.emitMessage(JSON.stringify({ type: "runtime:state", agentId: "agent-1", runtimeState: "error" }));
    await socket.emitMessage(JSON.stringify({ type: "inbox:ack" }));
    await socket.emitMessage(JSON.stringify({ type: "heartbeat" }));
    await socket.emitMessage(JSON.stringify({ type: "agent:unbind", agentId: "agent-1" }));

    expect(sentTypes(socket)).toContain("agent:bound");
    expect(socket.sent.some((item) => item.includes("Agent not bound"))).toBe(true);
    expect(socket.sent.some((item) => item.includes("Malformed session:runtime frame"))).toBe(true);
    expect(socket.sent.some((item) => item.includes("Malformed inbox:ack frame"))).toBe(true);
    expect(socket.sent.some((item) => item.includes("heartbeat:ack"))).toBe(true);
    expect(frameAt(socket, socket.sent.length - 1)).toEqual({ type: "agent:unbound", agentId: "agent-1" });
  });

  it("pushes inbox frames from backlog and NOTIFY handlers, then drains after ack", async () => {
    const { handler, inboxService, notifier } = await loadRoute({
      dbRows: { agentRows: [boundAgent()] },
      jwtPayload: { organizationId: "org-1", sub: "user-1", type: "access" },
    });
    inboxService.claimBacklogForPush.mockResolvedValueOnce([inboxEntry(1)]);
    const socket = await connectSocket(handler);

    await authenticate(socket);
    await socket.emitMessage(JSON.stringify({ type: "client:register", clientId: "client-1" }));
    await socket.emitMessage(
      JSON.stringify({ type: "agent:bind", ref: "bind-1", agentId: "agent-1", runtimeType: "claude-code" }),
    );
    await flushMicrotasks();

    expect(sentTypes(socket)).toEqual(
      expect.arrayContaining(["auth:ok", "server:welcome", "client:registered", "agent:bound", "inbox:deliver"]),
    );
    expect(frameAt(socket, socket.sent.length - 1)).toMatchObject({ type: "inbox:deliver", entryId: 1 });
    expect(notifier.subscribe).toHaveBeenCalledWith("inbox-1", socket, expect.any(Function));

    const pushHandler = notifier.subscribe.mock.calls[0]?.[2];
    if (typeof pushHandler !== "function") throw new Error("missing inbox push handler");

    await pushHandler("msg-at-cap");
    expect(inboxService.claimAndBuildForPush).not.toHaveBeenCalled();
    expect(inboxService.ackEntryByIdForBoundAgents).not.toHaveBeenCalled();

    inboxService.ackEntryByIdForBoundAgents.mockResolvedValueOnce({ inboxId: "inbox-1" });
    inboxService.claimBacklogForPush.mockResolvedValueOnce([]);
    await socket.emitMessage(JSON.stringify({ type: "inbox:ack", entryId: 1 }));
    expect(inboxService.ackEntryByIdForBoundAgents).toHaveBeenCalledWith(applyDbMatcher(), 1, ["inbox-1"]);

    inboxService.claimAndBuildForPush.mockResolvedValueOnce([inboxEntry(2)]);
    await pushHandler("msg-2");

    expect(inboxService.claimAndBuildForPush).toHaveBeenCalledWith(applyDbMatcher(), "inbox-1", "msg-2");
    expect(frameAt(socket, socket.sent.length - 1)).toMatchObject({ type: "inbox:deliver", entryId: 2 });
  });
});

function applyDbMatcher(): unknown {
  return expect.anything();
}
