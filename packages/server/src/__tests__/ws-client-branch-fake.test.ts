import { EventEmitter } from "node:events";
import { AUTH_REJECTED_CODES, type ClientMessage, type InboxEntryWithMessage } from "@first-tree/shared";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientWsRoutes } from "../api/agent/ws-client.js";
import type { inboxEntries } from "../db/schema/inbox-entries.js";
import * as activityService from "../services/activity.js";
import * as agentRuntimeSessionService from "../services/agent-runtime-session.js";
import * as clientService from "../services/client.js";
import * as inboxService from "../services/inbox.js";
import * as notificationService from "../services/notification.js";
import * as presenceService from "../services/presence.js";
import * as runtimeLivenessService from "../services/runtime-liveness.js";

type WsHandler = (socket: FakeSocket, request: { headers: Record<string, string | undefined>; ip: string }) => unknown;

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  sent: unknown[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  failSend: ((frame: string) => boolean) | null = null;

  send(frame: string): void {
    if (this.failSend?.(frame)) throw new Error("send failed");
    this.sent.push(JSON.parse(frame));
  }

  close(code: number, reason: string): void {
    this.readyState = this.CLOSED;
    this.closes.push({ code, reason });
    this.emit("close", code);
  }
}

function queryChain(rows: unknown[] = []): unknown {
  const promise = Promise.resolve(rows);
  const chain = new Proxy(
    function queryProxy(): unknown {
      return chain;
    },
    {
      get: (_target, prop) => {
        if (prop === "then") return promise.then.bind(promise);
        if (prop === "catch") return promise.catch.bind(promise);
        if (prop === "finally") return promise.finally.bind(promise);
        if (prop === Symbol.iterator) return rows[Symbol.iterator].bind(rows);
        return vi.fn(() => chain);
      },
    },
  );
  return chain;
}

function queuedDb(results: unknown[][]): unknown {
  return {
    select: vi.fn(() => queryChain(results.shift() ?? [])),
    update: vi.fn(() => queryChain(results.shift() ?? [])),
  };
}

function throwingSelectDb(error: unknown): unknown {
  return {
    select: vi.fn(() => {
      throw error;
    }),
  };
}

function routeHarness(db: unknown): { handler: WsHandler; notifier: Record<string, unknown> } {
  let handler: WsHandler | null = null;
  const notifier = {
    onAgentRouteChange: vi.fn(),
    onDaemonClientCommand: vi.fn(),
    onDaemonClientCommandResult: vi.fn(),
    notifyDaemonClientCommand: vi.fn(async () => {}),
    notifyDaemonClientCommandResult: vi.fn(async () => {}),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
  const app = {
    commandVersion: () => "test-version",
    config: {
      inbox: { maxInFlightPerAgent: 1, maxInFlightPerAgentChat: 1 },
      secrets: { jwtSecret: "test-jwt-secret-key-for-vitest" },
    },
    db,
    get: vi.fn((_path: string, _options: unknown, routeHandler: WsHandler) => {
      handler = routeHandler;
    }),
    log: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
  void clientWsRoutes(notifier as never, "fake-instance")(app as never);
  if (!handler) throw new Error("WS route handler was not registered");
  return { handler, notifier };
}

async function signAccess(payload: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ sub: "user_1", type: "access", organizationId: "org_1", ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now);
  if (!("exp" in payload)) jwt.setExpirationTime(now + 300);
  return jwt.sign(new TextEncoder().encode("test-jwt-secret-key-for-vitest"));
}

async function emitMessage(socket: FakeSocket, frame: unknown): Promise<void> {
  socket.emit("message", typeof frame === "string" ? frame : JSON.stringify(frame));
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 500) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageRow(overrides: Partial<ClientMessage> = {}): ClientMessage {
  return {
    id: "msg_1",
    chatId: "chat_1",
    senderId: "agent_1",
    format: "text",
    content: "hello",
    metadata: {},
    inReplyTo: null,
    source: "api",
    createdAt: "2026-01-01T00:00:00.000Z",
    configVersion: 1,
    recipientMode: "full",
    precedingMessages: [],
    ...overrides,
  };
}

function inboxEntry(overrides: Partial<InboxEntryWithMessage> = {}): InboxEntryWithMessage {
  return {
    id: 101,
    inboxId: "inbox_1",
    chatId: "chat_1",
    messageId: "msg_1",
    status: "pending",
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    ackedAt: null,
    message: messageRow(),
    ...overrides,
  };
}

function inboxDbRow(overrides: Partial<typeof inboxEntries.$inferSelect> = {}): typeof inboxEntries.$inferSelect {
  return {
    id: 101,
    inboxId: "inbox_1",
    chatId: "chat_1",
    messageId: "msg_1",
    status: "acked",
    notify: true,
    retryCount: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deliveredAt: null,
    ackedAt: new Date("2026-01-01T00:00:01.000Z"),
    ...overrides,
  };
}

describe("Agent client WS branch fakes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows auth rejection sends when the socket has already closed", async () => {
    const { handler } = routeHarness(queuedDb([]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    socket.readyState = socket.CLOSED;
    await emitMessage(socket, { type: "not-auth" });

    expect(socket.closes).toContainEqual({ code: 4401, reason: "auth rejected" });
    expect(socket.sent).toEqual([]);
  });

  it("swallows expired-auth sends when the socket has already closed", async () => {
    const { handler } = routeHarness(queuedDb([]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    socket.readyState = socket.CLOSED;
    const expired = await signAccess({ exp: Math.floor(Date.now() / 1000) - 1 });
    await emitMessage(socket, { type: "auth", token: expired });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.closes).toContainEqual({ code: 4401, reason: "auth expired" });
    expect(socket.sent).toEqual([]);
  });

  it("turns post-auth send failures into retryable closes", async () => {
    const { handler } = routeHarness(queuedDb([[{ id: "user_1", status: "active" }]]));
    const socket = new FakeSocket();
    let sendCount = 0;
    socket.failSend = () => {
      sendCount += 1;
      return sendCount === 2;
    };
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.sent).toContainEqual({ type: "auth:ok" });
    expect(socket.sent).toContainEqual({
      type: "auth:retryable",
      code: "handshake_internal_error",
      message: "post-auth handshake failed",
    });
    expect(socket.closes).toContainEqual({ code: 1011, reason: "auth retryable" });
  });

  it("swallows retryable auth frames when the socket closes during retry handling", async () => {
    const { handler } = routeHarness(throwingSelectDb(new Error("lookup unavailable")));
    const socket = new FakeSocket();
    let sendCount = 0;
    socket.failSend = (frame) => {
      const parsed = JSON.parse(frame) as { type?: string };
      sendCount += 1;
      return parsed.type === "auth:retryable";
    };
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.closes.length > 0);

    expect(sendCount).toBe(1);
    expect(socket.sent.some((frame) => (frame as { type?: string }).type === "auth:retryable")).toBe(false);
    expect(socket.closes).toContainEqual({ code: 1013, reason: "auth retryable" });
  });

  it("classifies non-Error auth lookup failures as retryable backend failures", async () => {
    const { handler } = routeHarness(throwingSelectDb("lookup unavailable as string"));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.sent).toContainEqual({
      type: "auth:retryable",
      code: "auth_backend_unavailable",
      message: "authentication backend unavailable",
    });
    expect(socket.closes).toContainEqual({ code: 1013, reason: "auth retryable" });
  });

  it("maps non-Error client registration failures to the fallback rejection", async () => {
    vi.spyOn(clientService, "registerClient").mockImplementation(async () => {
      throw "register failed as string";
    });
    const { handler } = routeHarness(queuedDb([[{ id: "user_1", status: "active" }]]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "server:welcome"));
    await emitMessage(socket, { type: "client:register", clientId: "client_fake1234" });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.sent).toContainEqual({
      type: "client:register:rejected",
      message: "client register failed",
    });
    expect(socket.closes).toContainEqual({ code: 4403, reason: "client register rejected" });
  });

  it("rejects client registration when no membership fallback exists", async () => {
    const { handler } = routeHarness(queuedDb([[{ id: "user_1", status: "active" }], []]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": undefined }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess({ organizationId: undefined }) });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "server:welcome"));
    await emitMessage(socket, { type: "client:register", clientId: "client_fake1234" });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.sent).toContainEqual({
      type: "client:register:rejected",
      message: "User has no active organization membership",
    });
    expect(socket.closes).toContainEqual({ code: 4403, reason: "no membership" });
  });

  it("uses the invalid-claims code for missing token type", async () => {
    const { handler } = routeHarness(queuedDb([]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess({ type: undefined }) });
    await waitUntil(() => socket.sent.length > 0);

    expect(socket.sent).toContainEqual({
      type: "auth:rejected",
      code: AUTH_REJECTED_CODES.INVALID_CLAIMS,
      message: "member access token required",
    });
  });

  async function authenticateAndRegister(socket: FakeSocket, handler: WsHandler): Promise<void> {
    vi.spyOn(clientService, "registerClient").mockResolvedValue(undefined);
    vi.spyOn(clientService, "listActiveAgentsPinnedToClient").mockResolvedValue([]);
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });
    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "server:welcome"));
    await emitMessage(socket, { type: "client:register", clientId: "client_fake1234" });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "client:registered"));
  }

  function activeAgentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "agent_1",
      displayName: "Agent",
      type: "agent",
      organizationId: "org_1",
      inboxId: "inbox_1",
      status: "active",
      clientId: "client_fake1234",
      managerId: "member_1",
      runtimeProvider: "claude-code",
      clientUserId: "user_1",
      managerUserId: "user_1",
      managerMemberStatus: "active",
      ...overrides,
    };
  }

  function mockSuccessfulBindServices(): void {
    vi.spyOn(agentRuntimeSessionService, "bindAgentRuntimeSession").mockResolvedValue("runtime-token");
    vi.spyOn(agentRuntimeSessionService, "revokeAgentRuntimeSession").mockResolvedValue(true);
    vi.spyOn(agentRuntimeSessionService, "revokeAgentRuntimeSessionIfTokenMatches").mockResolvedValue(true);
    vi.spyOn(presenceService, "bindAgentIfActiveClient").mockResolvedValue(true);
    vi.spyOn(presenceService, "unbindAgent").mockResolvedValue(1);
    vi.spyOn(presenceService, "setRuntimeState").mockResolvedValue(undefined);
    vi.spyOn(notificationService, "markAgentFaultsResolved").mockResolvedValue(undefined);
    vi.spyOn(notificationService, "notifyAgentEvent").mockResolvedValue(undefined);
    vi.spyOn(inboxService, "resetDeliveredForInboxes").mockResolvedValue(1);
    vi.spyOn(inboxService, "claimBacklogForPushFair").mockResolvedValue([]);
    vi.spyOn(inboxService, "claimBacklogForPushForChat").mockResolvedValue([]);
    vi.spyOn(inboxService, "recoverUnackedForScope").mockResolvedValue({ resetEntryIds: [] });
    vi.spyOn(inboxService, "ackEntryByIdForBoundAgents").mockResolvedValue({
      ok: true,
      throughEntry: inboxDbRow(),
      disposition: "acked",
      ackedCount: 1,
      ackedEntryIds: [101],
    });
    vi.spyOn(activityService, "upsertSessionState").mockResolvedValue(undefined);
    vi.spyOn(activityService, "setSessionRuntime").mockResolvedValue(undefined);
    vi.spyOn(runtimeLivenessService, "recordClientHeartbeat").mockResolvedValue({
      clientUpdated: true,
      restoredAgentIds: ["agent_1"],
    });
  }

  async function bindAgent(socket: FakeSocket, handler: WsHandler, ref = "bind-ok"): Promise<void> {
    await authenticateAndRegister(socket, handler);
    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref,
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "agent:bound"));
  }

  it("rejects first-bind races when the claim update returns no row", async () => {
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow({ clientId: null })],
        [],
      ]),
    );
    const socket = new FakeSocket();
    await authenticateAndRegister(socket, handler);

    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref: "bind-claim-empty",
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });

    expect(socket.sent).toContainEqual({
      type: "agent:bind:rejected",
      ref: "bind-claim-empty",
      reason: "wrong_client",
    });
  });

  it("rejects bind attempts for agents pinned to another client", async () => {
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow({ clientId: "client_other1234" })],
      ]),
    );
    const socket = new FakeSocket();
    await authenticateAndRegister(socket, handler);

    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref: "bind-wrong-client",
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });

    expect(socket.sent).toContainEqual({
      type: "agent:bind:rejected",
      ref: "bind-wrong-client",
      reason: "wrong_client",
    });
  });

  it("rejects bind attempts when the pinned client has no matching user", async () => {
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow({ clientUserId: null })],
      ]),
    );
    const socket = new FakeSocket();
    await authenticateAndRegister(socket, handler);

    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref: "bind-client-user-missing",
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });

    expect(socket.sent).toContainEqual({
      type: "agent:bind:rejected",
      ref: "bind-client-user-missing",
      reason: "not_owned",
    });
  });

  it("binds an agent and drains backlog through the fake inbox push path", async () => {
    mockSuccessfulBindServices();
    vi.spyOn(inboxService, "claimBacklogForPushFair").mockResolvedValueOnce([inboxEntry()]).mockResolvedValue([]);
    const { handler, notifier } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow({ clientId: "client_fake1234", clientUserId: undefined, managerId: undefined })],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "inbox:deliver"));

    expect(socket.sent).toContainEqual(
      expect.objectContaining({ type: "agent:bound", runtimeSessionToken: "runtime-token" }),
    );
    expect(socket.sent).toContainEqual(
      expect.objectContaining({ type: "inbox:deliver", entryId: 101, chatId: "chat_1" }),
    );
    expect(notifier.subscribe).toHaveBeenCalledWith("inbox_1", socket, expect.any(Function));
  });

  it("delivers null-chat inbox entries and accepts acks without refs", async () => {
    mockSuccessfulBindServices();
    vi.spyOn(inboxService, "claimBacklogForPushFair")
      .mockResolvedValueOnce([inboxEntry({ id: 303, chatId: null })])
      .mockResolvedValue([]);
    vi.spyOn(inboxService, "ackEntryByIdForBoundAgents").mockResolvedValueOnce({
      ok: true,
      throughEntry: inboxDbRow({ id: 303, chatId: null }),
      disposition: "acked",
      ackedCount: 1,
      ackedEntryIds: [303],
    });
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler, "bind-null-chat");
    await waitUntil(() => socket.sent.some((frame) => (frame as { entryId?: number }).entryId === 303));

    await emitMessage(socket, { type: "inbox:ack", entryId: 303 });
    await waitUntil(() => vi.mocked(inboxService.ackEntryByIdForBoundAgents).mock.calls.length > 0);

    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "inbox:deliver", entryId: 303, chatId: null }));
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ type: "inbox:ack:accepted", entryId: 303 }));
  });

  it("treats runtime-switch claimed routes as no longer routed here without dropping the local binding", async () => {
    mockSuccessfulBindServices();
    const switchClaim = {
      claimId: "claim_1",
      phase: "claimed",
      claimedAt: "2026-01-01T00:00:00.000Z",
      claimedByUserId: "user_1",
      claimedByMemberId: "member_1",
      oldClientId: "client_fake1234",
      oldRuntimeProvider: "claude-code",
      targetClientId: "client_next1234",
      targetRuntimeProvider: "codex",
    };
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [
          {
            clientId: "client_fake1234",
            status: "suspended",
            runtimeProvider: "claude-code",
            metadata: { runtimeSwitch: switchClaim },
          },
        ],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler, "bind-switch-claimed");

    await emitMessage(socket, { type: "session:state", agentId: "agent_1", chatId: "chat_1", state: "active" });

    expect(socket.sent).toContainEqual({ type: "error", message: "Agent not bound" });
  });

  it("throttles heartbeat-triggered inbox repair when the last repair is recent", async () => {
    mockSuccessfulBindServices();
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler, "bind-heartbeat-throttle");

    const heartbeatAckCount = (): number =>
      socket.sent.filter((frame) => (frame as { type?: string }).type === "heartbeat:ack").length;

    await emitMessage(socket, { type: "heartbeat" });
    await waitUntil(() => heartbeatAckCount() === 1);
    await emitMessage(socket, { type: "heartbeat" });
    await waitUntil(() => heartbeatAckCount() === 2);

    expect(runtimeLivenessService.recordClientHeartbeat).toHaveBeenCalledTimes(2);
    expect(socket.sent).toContainEqual({ type: "heartbeat:ack" });
  });

  it("covers inbox cap logging for notify and recover drains", async () => {
    mockSuccessfulBindServices();
    const { handler, notifier } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    vi.spyOn(inboxService, "claimBacklogForPushFair").mockResolvedValueOnce([inboxEntry()]);
    const pushHandler = (notifier.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
      | ((messageId: string) => Promise<void>)
      | undefined;
    await pushHandler?.("msg_notify");
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "inbox:deliver"));

    await pushHandler?.("msg_at_cap");
    await emitMessage(socket, { type: "inbox:recover", ref: "recover-at-cap", agentId: "agent_1", chatId: "chat_1" });

    expect(socket.sent).toContainEqual({
      type: "inbox:recover:accepted",
      ref: "recover-at-cap",
      agentId: "agent_1",
      chatId: "chat_1",
      resetCount: 0,
    });
  });

  it("stops a drain when the socket closes after backlog is claimed", async () => {
    mockSuccessfulBindServices();
    const { handler, notifier } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    vi.spyOn(inboxService, "claimBacklogForPushFair").mockImplementationOnce(async () => {
      socket.readyState = socket.CLOSED;
      return [inboxEntry({ id: 202 })] as never;
    });
    const pushHandler = (notifier.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
      | ((messageId: string) => Promise<void>)
      | undefined;
    await pushHandler?.("msg_close_mid_drain");

    expect(socket.sent).not.toContainEqual(expect.objectContaining({ entryId: 202 }));
  });

  it("persists session state and runtime frames after binding", async () => {
    mockSuccessfulBindServices();
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    await emitMessage(socket, { type: "session:state", agentId: "agent_1", chatId: "chat_1", state: "active" });
    await emitMessage(socket, {
      type: "session:runtime",
      agentId: "agent_1",
      chatId: "chat_1",
      runtimeState: "working",
    });
    await emitMessage(socket, { type: "runtime:state", agentId: "agent_1", runtimeState: "idle" });
    await waitUntil(() => vi.mocked(activityService.setSessionRuntime).mock.calls.length > 0);

    expect(activityService.upsertSessionState).toHaveBeenCalledWith(
      expect.anything(),
      "agent_1",
      "chat_1",
      "active",
      "org_1",
      expect.anything(),
    );
    expect(activityService.setSessionRuntime).toHaveBeenCalledWith(
      expect.anything(),
      "agent_1",
      "chat_1",
      "working",
      "org_1",
      expect.anything(),
    );
    expect(presenceService.setRuntimeState).toHaveBeenCalledWith(
      expect.anything(),
      "agent_1",
      "idle",
      expect.objectContaining({ organizationId: "org_1" }),
    );
  });
});
