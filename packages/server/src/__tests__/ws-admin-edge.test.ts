import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { orgWsRoutes } from "../api/orgs/ws.js";
import type { Database } from "../db/connection.js";
import type { Notifier } from "../services/notifier.js";

const JWT_SECRET = "test-jwt-secret-key-for-vitest";

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
    notifyStrict: vi.fn(),
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

function makeApp(db: Database): { app: { db: Database; get: ReturnType<typeof vi.fn> }; getRoute: () => RouteHandler } {
  let route: RouteHandler | undefined;
  const app = {
    db,
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
} {
  let readyState = 1;
  let closeHandler: ((code: number) => void) | undefined;
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
  } as unknown as WebSocket;
  return {
    socket,
    send,
    close,
    setReadyState: (next) => {
      readyState = next;
    },
    emitClose: (code) => closeHandler?.(code),
  };
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function request(token: string | undefined, orgId = "org-1"): Record<string, unknown> {
  return {
    ip: "127.0.0.1",
    headers: { "user-agent": "vitest-admin-ws" },
    params: { orgId },
    query: token ? { token } : {},
  };
}

function sentPayloads(send: ReturnType<typeof vi.fn>): Array<{ type?: string } & Record<string, unknown>> {
  return send.mock.calls.map(([frame]) => JSON.parse(String(frame)));
}

async function waitForAsyncDispatch(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("Admin WS route edge paths", () => {
  it("rejects missing, malformed, wrong-type, and non-member handshakes", async () => {
    const handlers: CapturedHandlers = {};
    const db = makeDb({ memberRows: [] });
    const { app, getRoute } = makeApp(db);
    await orgWsRoutes(makeNotifier(handlers), JWT_SECRET)(app as never);
    const route = getRoute();

    const missing = makeSocket();
    await route(missing.socket, request(undefined));
    expect(sentPayloads(missing.send)[0]).toMatchObject({ type: "error", message: "Missing token or org" });
    expect(missing.close).toHaveBeenCalledWith(4001, "Missing token");

    const malformed = makeSocket();
    await route(malformed.socket, request("not-a-jwt"));
    expect(sentPayloads(malformed.send)[0]).toMatchObject({ type: "error", message: "Invalid or expired token" });
    expect(malformed.close).toHaveBeenCalledWith(4001, "Auth failed");

    const wrongType = makeSocket();
    await route(wrongType.socket, request(await signToken({ sub: "user-1", type: "refresh" })));
    expect(sentPayloads(wrongType.send)[0]).toMatchObject({ type: "error", message: "Invalid token type" });
    expect(wrongType.close).toHaveBeenCalledWith(4001, "Invalid token");

    const nonMember = makeSocket();
    await route(nonMember.socket, request(await signToken({ sub: "user-1", type: "access" })));
    expect(sentPayloads(nonMember.send)[0]).toMatchObject({
      type: "error",
      message: "Not an active member of this organization",
    });
    expect(nonMember.close).toHaveBeenCalledWith(4403, "Not a member");
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

    await route(active.socket, request(token));
    await route(closed.socket, request(token));
    closed.setReadyState(3);

    handlers.chatMessage?.({ chatId: "chat-message-edge", messageId: "msg-1" });
    await waitForAsyncDispatch();
    handlers.chatUpdated?.({ chatId: "chat-updated-edge" });
    await waitForAsyncDispatch();
    handlers.sessionState?.({ agentId: "agent-1", chatId: "chat-session-empty-edge", organizationId: "org-1" });
    await waitForAsyncDispatch();

    const activeTypes = sentPayloads(active.send).map((payload) => payload.type);
    const closedTypes = sentPayloads(closed.send).map((payload) => payload.type);
    expect(activeTypes).toEqual(["admin:connected", "chat:message", "chat:updated", "session:state"]);
    expect(closedTypes).toEqual(["admin:connected"]);

    active.emitClose(1000);
    handlers.chatMessage?.({ chatId: "chat-after-close-edge", messageId: "msg-2" });
    await waitForAsyncDispatch();
    expect(sentPayloads(active.send).map((payload) => payload.type)).toEqual([
      "admin:connected",
      "chat:message",
      "chat:updated",
      "session:state",
    ]);
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

    await route(active.socket, request(token));
    active.send.mockImplementation(() => {
      throw new Error("socket send failed");
    });

    handlers.chatMessage?.({ chatId: "chat-message-send-fail", messageId: "msg-1" });
    await waitForAsyncDispatch();
    handlers.chatUpdated?.({ chatId: "chat-updated-send-fail" });
    await waitForAsyncDispatch();
    handlers.sessionRuntime?.({ agentId: "agent-1", chatId: "chat-runtime-send-fail", organizationId: "org-1" });
    await waitForAsyncDispatch();

    expect(active.send).toHaveBeenCalledTimes(4);
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
    await route(own.socket, request(token, "org-1"));
    await route(otherOrg.socket, request(token, "org-2"));

    // The acting user's own pin in their org → delivered to `own` only.
    handlers.meChatsChanged?.({ humanAgentId: "human-1", organizationId: "org-1" });
    // A DIFFERENT user's pin in the same org → delivered to nobody. This is the
    // privacy boundary: pin state is private and must never reach another member.
    handlers.meChatsChanged?.({ humanAgentId: "human-2", organizationId: "org-1" });
    // The same user, a different org → delivered to nobody here (org-scoped).
    handlers.meChatsChanged?.({ humanAgentId: "human-1", organizationId: "org-3" });

    expect(sentPayloads(own.send).map((payload) => payload.type)).toEqual(["admin:connected", "me-chats:changed"]);
    // The other-org socket (same user) never sees org-1's pin.
    expect(sentPayloads(otherOrg.send).map((payload) => payload.type)).toEqual(["admin:connected"]);
  });
});
