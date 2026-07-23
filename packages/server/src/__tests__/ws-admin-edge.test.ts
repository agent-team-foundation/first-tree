import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { orgWsRoutes } from "../api/orgs/ws.js";
import type { Database } from "../db/connection.js";
import type { Notifier } from "../services/notifier.js";

const JWT_SECRET = "test-jwt-secret-key-for-vitest";
const SERVER_AUTHORITY = "http://server.test/api/v1";

type RouteHandler = (socket: WebSocket, request: Record<string, unknown>) => Promise<void>;

type CapturedHandlers = {
  sessionState?: (payload: { agentId: string; chatId: string; organizationId: string }) => void;
  sessionEvent?: (payload: { agentId: string; chatId: string; organizationId: string }) => void;
  sessionRuntime?: (payload: { agentId: string; chatId: string; organizationId: string }) => void;
  chatMessage?: (payload: { chatId: string; messageId: string }) => void;
  chatUpdated?: (payload: { chatId: string }) => void;
  meChatsChanged?: (payload: { humanAgentId: string; organizationId: string }) => void;
};

function makeNotifier(handlers: CapturedHandlers): Notifier {
  return {
    onSessionStateChange: (handler: NonNullable<CapturedHandlers["sessionState"]>) => {
      handlers.sessionState = handler;
    },
    onSessionEvent: (handler: NonNullable<CapturedHandlers["sessionEvent"]>) => {
      handlers.sessionEvent = handler;
    },
    onSessionRuntime: (handler: NonNullable<CapturedHandlers["sessionRuntime"]>) => {
      handlers.sessionRuntime = handler;
    },
    onChatMessage: (handler: NonNullable<CapturedHandlers["chatMessage"]>) => {
      handlers.chatMessage = handler;
    },
    onChatUpdated: (handler: NonNullable<CapturedHandlers["chatUpdated"]>) => {
      handlers.chatUpdated = handler;
    },
    onMeChatsChanged: (handler: NonNullable<CapturedHandlers["meChatsChanged"]>) => {
      handlers.meChatsChanged = handler;
    },
    onConfigChange: vi.fn(),
    onRuntimeStateChange: vi.fn(),
    onChatAudience: vi.fn(),
    onAgentRouteChange: vi.fn(),
    onDaemonClientCommand: vi.fn(),
    onDaemonClientCommandResult: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    notify: vi.fn(),
    notifyConfigChange: vi.fn(),
    notifySessionStateChange: vi.fn(),
    notifySessionEvent: vi.fn(),
    notifyRuntimeStateChange: vi.fn(),
    notifySessionRuntime: vi.fn(),
    notifyChatMessage: vi.fn(),
    notifyChatAudience: vi.fn(),
    notifyChatUpdated: vi.fn(),
    notifyMeChatsChanged: vi.fn(),
    notifyAgentRouteChange: vi.fn(),
    notifyDaemonClientCommand: vi.fn(),
    notifyDaemonClientCommandResult: vi.fn(),
    pushFrameToInbox: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as Notifier;
}

function makeSelectBuilder(rows: unknown[]) {
  const resolveRows = () => Promise.resolve(rows);
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(resolveRows),
    // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable thenables.
    then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
      resolveRows().then(resolve, reject),
  };
}

function makeDb(options: {
  memberRows?: unknown[];
  visibleRows?: unknown[];
  humanRows?: unknown[];
  audienceRows?: unknown[][];
}) {
  const memberRows = options.memberRows ?? [{ id: "member-1", role: "admin", agentId: "human-1" }];
  const visibleRows = options.visibleRows ?? [{ id: "visible-agent" }];
  const humanRows = options.humanRows ?? [{ uuid: "human-1" }];
  const selectRows = [memberRows, visibleRows, humanRows];
  let selectIndex = 0;
  const execute = vi.fn();
  for (const rows of options.audienceRows ?? []) execute.mockResolvedValueOnce(rows);
  execute.mockResolvedValue([]);
  return {
    execute,
    select: vi.fn(() => makeSelectBuilder(selectRows[selectIndex++ % selectRows.length] ?? [])),
  } as unknown as Database;
}

function makeApp(db: Database): {
  app: {
    config: Record<string, unknown>;
    db: Database;
    get: ReturnType<typeof vi.fn>;
    log: { warn: ReturnType<typeof vi.fn> };
  };
  getRoute: () => RouteHandler;
} {
  let route: RouteHandler | undefined;
  const app = {
    config: {
      server: { authority: SERVER_AUTHORITY, host: "127.0.0.1", port: 0, publicUrl: undefined },
    },
    db,
    log: { warn: vi.fn() },
    get: vi.fn((_path: string, _opts: unknown, handler: RouteHandler) => {
      route = handler;
    }),
  };
  return {
    app,
    getRoute: () => {
      if (!route) throw new Error("admin ws route was not registered");
      return route;
    },
  };
}

function makeSocket(): {
  socket: WebSocket;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setReadyState: (readyState: number) => void;
  emitClose: (code: number) => void;
  emitMessage: (frame: unknown, isBinary?: boolean) => void;
} {
  let readyState = 1;
  let closeHandler: ((code: number) => void) | undefined;
  let messageHandler: ((raw: Buffer, isBinary: boolean) => void) | undefined;
  const send = vi.fn();
  const close = vi.fn();
  const socket = {
    get readyState() {
      return readyState;
    },
    send,
    close,
    on: vi.fn((event: string, handler: (code: number) => void) => {
      if (event === "close") closeHandler = handler;
      return socket;
    }),
    once: vi.fn((event: string, handler: (raw: Buffer, isBinary: boolean) => void) => {
      if (event === "message") messageHandler = handler;
      return socket;
    }),
  } as unknown as WebSocket;
  return {
    socket,
    send,
    close,
    setReadyState: (next) => {
      readyState = next;
    },
    emitClose: (code) => closeHandler?.(code),
    emitMessage: (frame, isBinary = false) => {
      const handler = messageHandler;
      messageHandler = undefined;
      handler?.(Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame)), isBinary);
    },
  };
}

async function signToken(
  payload: Record<string, unknown>,
  expiresInSeconds = 300,
  notBeforeSeconds?: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signer = new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds);
  if (notBeforeSeconds !== undefined) signer.setNotBefore(now + notBeforeSeconds);
  return signer.sign(new TextEncoder().encode(JWT_SECRET));
}

function request(orgId = "org-1"): Record<string, unknown> {
  return {
    ip: "127.0.0.1",
    headers: { "user-agent": "vitest-admin-ws" },
    params: { orgId },
    query: {},
  };
}

function sentPayloads(send: ReturnType<typeof vi.fn>): Array<{ type?: string } & Record<string, unknown>> {
  return send.mock.calls.map(([frame]) => JSON.parse(String(frame)));
}

async function waitForAsyncDispatch(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function authenticate(
  route: RouteHandler,
  socket: ReturnType<typeof makeSocket>,
  token: string,
  orgId = "org-1",
) {
  await route(socket.socket, request(orgId));
  expect(sentPayloads(socket.send)[0]).toEqual({ type: "server:hello", authority: SERVER_AUTHORITY });
  socket.emitMessage({ type: "auth", token });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const types = sentPayloads(socket.send).map((payload) => payload.type);
    if (
      types.includes("auth:ok") ||
      types.includes("auth:rejected") ||
      types.includes("auth:expired") ||
      types.includes("auth:retryable")
    ) {
      return;
    }
    await waitForAsyncDispatch();
  }
  throw new Error("admin websocket authentication did not settle");
}

describe("Admin WS route edge paths", () => {
  it("rejects malformed frames, invalid tokens, wrong token types, and non-member handshakes", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({ memberRows: [] });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();

    const malformedFrame = makeSocket();
    await route(malformedFrame.socket, request());
    malformedFrame.emitMessage({ type: "not-auth", token: "secret" });
    expect(sentPayloads(malformedFrame.send).at(-1)).toMatchObject({
      type: "auth:rejected",
      code: "invalid_auth_frame",
    });
    expect(malformedFrame.close).toHaveBeenCalledWith(4401, "Invalid auth frame");

    const malformed = makeSocket();
    await authenticate(route, malformed, "not-a-jwt");
    expect(sentPayloads(malformed.send).at(-1)).toMatchObject({
      type: "auth:rejected",
      code: "invalid_token",
      message: "Invalid token",
    });
    expect(malformed.close).toHaveBeenCalledWith(4401, "Auth failed");

    const wrongType = makeSocket();
    await authenticate(route, wrongType, await signToken({ sub: "user-1", type: "refresh" }));
    expect(sentPayloads(wrongType.send).at(-1)).toMatchObject({
      type: "auth:rejected",
      code: "wrong_token_type",
      message: "Invalid token type",
    });
    expect(wrongType.close).toHaveBeenCalledWith(4401, "Invalid token");

    const missingSubject = makeSocket();
    await authenticate(route, missingSubject, await signToken({ type: "access" }));
    expect(sentPayloads(missingSubject.send).at(-1)).toMatchObject({
      type: "auth:rejected",
      code: "invalid_claims",
      message: "Invalid token claims",
    });
    expect(missingSubject.close).toHaveBeenCalledWith(4401, "Invalid claims");

    const notYetValid = makeSocket();
    await authenticate(route, notYetValid, await signToken({ sub: "user-1", type: "access" }, 300, 60));
    expect(sentPayloads(notYetValid.send).at(-1)).toMatchObject({
      type: "auth:rejected",
      code: "invalid_claims",
      message: "Invalid token claims",
    });
    expect(notYetValid.close).toHaveBeenCalledWith(4401, "Invalid claims");

    const nonMember = makeSocket();
    await authenticate(route, nonMember, await signToken({ sub: "user-1", type: "access" }));
    expect(sentPayloads(nonMember.send).at(-1)).toMatchObject({
      type: "auth:rejected",
      message: "Not an active member of this organization",
    });
    expect(nonMember.close).toHaveBeenCalledWith(4403, "Not a member");
  });

  it("classifies an expired JWT separately from permanent token rejection", async () => {
    const handlers: CapturedHandlers = {};
    const { app, getRoute } = makeApp(makeDb({}));
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const expired = makeSocket();

    await authenticate(getRoute(), expired, await signToken({ sub: "user-1", type: "access" }, -1));

    expect(sentPayloads(expired.send).at(-1)).toEqual({ type: "auth:expired" });
    expect(expired.close).toHaveBeenCalledWith(4001, "Auth expired");
  });

  it("emits auth:retryable for backend failures instead of rejecting the credential", async () => {
    const handlers: CapturedHandlers = {};
    const db = {
      select: vi.fn(() => {
        throw new Error("database unavailable");
      }),
    } as unknown as Database;
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const pending = makeSocket();

    await authenticate(getRoute(), pending, await signToken({ sub: "user-1", type: "access" }));

    expect(sentPayloads(pending.send).at(-1)).toMatchObject({
      type: "auth:retryable",
      code: "auth_backend_unavailable",
      retryAfterMs: 2_000,
    });
    expect(pending.close).toHaveBeenCalledWith(1013, "Auth unavailable");
    expect(app.log.warn).toHaveBeenCalled();
  });

  it("expires an authenticated socket when its verified access token reaches exp", async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let timerId = 0;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      scheduled.push({ callback, delay: Number(delay) });
      timerId += 1;
      return timerId as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const handlers: CapturedHandlers = {};
      const { app, getRoute } = makeApp(makeDb({}));
      await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
      const active = makeSocket();

      await authenticate(getRoute(), active, await signToken({ sub: "user-1", type: "access" }));
      expect(sentPayloads(active.send).map((payload) => payload.type)).toEqual(["server:hello", "auth:ok"]);

      const expiry = scheduled.find(({ delay }) => delay > 5_000);
      expect(expiry).toBeDefined();
      expiry?.callback();

      expect(sentPayloads(active.send).at(-1)).toEqual({ type: "auth:expired" });
      expect(active.close).toHaveBeenCalledWith(4001, "Auth expired");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("dispatches chat and session frames only to active audience sockets", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({
      audienceRows: [[{ agent_id: "human-1" }], [{ agent_id: "human-1" }], []],
    });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const token = await signToken({ sub: "user-1", type: "access" });
    const active = makeSocket();
    const closed = makeSocket();

    await authenticate(route, active, token);
    await authenticate(route, closed, token);
    closed.setReadyState(3);

    handlers.chatMessage?.({ chatId: "chat-message-edge", messageId: "msg-1" });
    await waitForAsyncDispatch();
    handlers.chatUpdated?.({ chatId: "chat-updated-edge" });
    await waitForAsyncDispatch();
    handlers.sessionState?.({ agentId: "agent-1", chatId: "chat-session-empty-edge", organizationId: "org-1" });
    await waitForAsyncDispatch();

    const activeTypes = sentPayloads(active.send).map((payload) => payload.type);
    const closedTypes = sentPayloads(closed.send).map((payload) => payload.type);
    expect(activeTypes).toEqual(["server:hello", "auth:ok", "chat:message", "chat:updated", "session:state"]);
    expect(closedTypes).toEqual(["server:hello", "auth:ok"]);

    active.emitClose(1000);
    handlers.chatMessage?.({ chatId: "chat-after-close-edge", messageId: "msg-2" });
    await waitForAsyncDispatch();
    expect(sentPayloads(active.send).map((payload) => payload.type)).toEqual([
      "server:hello",
      "auth:ok",
      "chat:message",
      "chat:updated",
      "session:state",
    ]);
  });

  it("keeps unauthenticated sockets out of broadcasts and closes a timed-out handshake", async () => {
    vi.useFakeTimers();
    try {
      const handlers: CapturedHandlers = {};
      const db = makeDb({});
      const { app, getRoute } = makeApp(db);
      await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
      const pending = makeSocket();
      await getRoute()(pending.socket, request());

      handlers.sessionState?.({ agentId: "agent-1", chatId: "chat-1", organizationId: "org-1" });
      expect(sentPayloads(pending.send)).toEqual([{ type: "server:hello", authority: SERVER_AUTHORITY }]);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(sentPayloads(pending.send).at(-1)).toMatchObject({
        type: "auth:retryable",
        code: "auth_timeout",
        retryAfterMs: 2_000,
        message: "Authentication timed out",
      });
      expect(pending.close).toHaveBeenCalledWith(1013, "Auth timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows socket send failures while dispatching chat and session frames", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({
      audienceRows: [[{ agent_id: "human-1" }], [{ agent_id: "human-1" }], [{ agent_id: "human-1" }]],
    });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const token = await signToken({ sub: "user-1", type: "access" });
    const active = makeSocket();

    await authenticate(route, active, token);
    active.send.mockImplementation(() => {
      throw new Error("socket send failed");
    });

    handlers.chatMessage?.({ chatId: "chat-message-send-fail", messageId: "msg-1" });
    await waitForAsyncDispatch();
    handlers.chatUpdated?.({ chatId: "chat-updated-send-fail" });
    await waitForAsyncDispatch();
    handlers.sessionRuntime?.({ agentId: "agent-1", chatId: "chat-runtime-send-fail", organizationId: "org-1" });
    await waitForAsyncDispatch();

    expect(active.send).toHaveBeenCalledTimes(5);
  });

  it("fans a me-chats:changed frame only to the acting user's own sockets in that org", async () => {
    const handlers: CapturedHandlers = {};
    // The mock db resolves every handshake to humanAgentId "human-1"; the org is
    // taken from the request path, so `own` (org-1) and `otherOrg` (org-2) share
    // a user but differ by org — enough to exercise both filter dimensions.
    const db = makeDb({});
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();
    const token = await signToken({ sub: "user-1", type: "access" });

    const own = makeSocket();
    const otherOrg = makeSocket();
    await authenticate(route, own, token, "org-1");
    await authenticate(route, otherOrg, token, "org-2");

    // The acting user's own pin in their org → delivered to `own` only.
    handlers.meChatsChanged?.({ humanAgentId: "human-1", organizationId: "org-1" });
    // A DIFFERENT user's pin in the same org → delivered to nobody. This is the
    // privacy boundary: pin state is private and must never reach another member.
    handlers.meChatsChanged?.({ humanAgentId: "human-2", organizationId: "org-1" });
    // The same user, a different org → delivered to nobody here (org-scoped).
    handlers.meChatsChanged?.({ humanAgentId: "human-1", organizationId: "org-3" });

    expect(sentPayloads(own.send).map((payload) => payload.type)).toEqual([
      "server:hello",
      "auth:ok",
      "me-chats:changed",
    ]);
    // The other-org socket (same user) never sees org-1's pin.
    expect(sentPayloads(otherOrg.send).map((payload) => payload.type)).toEqual(["server:hello", "auth:ok"]);
  });
});
