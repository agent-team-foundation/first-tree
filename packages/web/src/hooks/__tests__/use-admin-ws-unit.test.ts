import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EffectCleanup = () => void;
type QueryCall = { queryKey: readonly unknown[] };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  close = vi.fn();
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
}

function createQueryClient() {
  return {
    invalidations: [] as QueryCall[],
    patches: [] as Array<{ queryKey: readonly unknown[]; updater: unknown }>,
    invalidateQueries(call: QueryCall) {
      this.invalidations.push(call);
    },
    setQueryData(queryKey: readonly unknown[], updater: unknown) {
      this.patches.push({ queryKey, updater });
    },
  };
}

function setupBrowser(orgId: string | null = "org-1"): void {
  const storage = {
    getItem: vi.fn((key: string) => (key === "first-tree:selectedOrganizationId" ? orgId : null)),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    location: {
      host: "hub.example.test",
      protocol: "https:",
    },
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

async function loadHook({
  queryClient = createQueryClient(),
  token = "access-token",
  refreshedToken = "fresh-token",
}: {
  queryClient?: ReturnType<typeof createQueryClient>;
  token?: string | null;
  refreshedToken?: string | null;
} = {}) {
  const cleanups: EffectCleanup[] = [];
  const onMessageRefValues: unknown[] = [];
  const refreshAccessToken = vi.fn(async () => (refreshedToken ? { accessToken: refreshedToken } : null));

  vi.doMock("react", () => ({
    useEffect: (fn: () => undefined | EffectCleanup) => {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    useRef: (initial: unknown) => {
      const ref = { current: initial };
      onMessageRefValues.push(ref);
      return ref;
    },
  }));
  vi.doMock("@tanstack/react-query", () => ({
    useQueryClient: () => queryClient,
  }));
  vi.doMock("../../api/client.js", () => ({
    getStoredTokens: () => (token ? { accessToken: token } : null),
    refreshAccessToken,
  }));

  const mod = await import("../use-admin-ws.js");
  return {
    cleanups,
    queryClient,
    refreshAccessToken,
    useAdminWs: mod.useAdminWs,
  };
}

function emit(socket: FakeWebSocket, frame: Record<string, unknown>): void {
  socket.onmessage?.({ data: JSON.stringify(frame) });
}

describe("useAdminWs singleton connection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
    setupBrowser();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens one org-scoped socket, broadcasts frames, invalidates caches, refreshes auth, and tears down", async () => {
    const onMessage = vi.fn();
    const { cleanups, queryClient, refreshAccessToken, useAdminWs } = await loadHook();

    useAdminWs({ onMessage });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe("wss://hub.example.test/api/v1/orgs/org-1/ws/?token=access-token");

    FakeWebSocket.instances[0]?.onopen?.();
    expect(queryClient.invalidations.map((call) => call.queryKey)).toEqual(
      expect.arrayContaining([
        ["activity"],
        ["sessions"],
        ["me", "chats"],
        ["chat-agent-status"],
        ["session"],
        ["attentions"],
        ["chat-messages"],
        ["chat-detail"],
      ]),
    );

    const firstSocket = FakeWebSocket.instances[0];
    if (!firstSocket) throw new Error("expected first websocket");

    emit(firstSocket, {
      type: "session:state",
      agentId: "agent-1",
      chatId: "chat-1",
      status: { malformed: true },
    });
    emit(firstSocket, {
      type: "session:event",
      agentId: "agent-1",
      chatId: "chat-1",
      status: { malformed: true },
    });
    emit(firstSocket, { type: "chat:message", chatId: "chat-1" });
    emit(firstSocket, { type: "attention:opened", chatId: "chat-1" });
    emit(firstSocket, { type: "attention:cancelled", chatId: "chat-1" });
    emit(firstSocket, { type: "pulse:tick" });
    firstSocket.onmessage?.({ data: "not json" });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "session:state" }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "chat:message" }));
    expect(queryClient.invalidations.map((call) => call.queryKey)).toEqual(
      expect.arrayContaining([
        ["session", "agent-1", "chat-1"],
        ["chat-right-sidebar", "session", "agent-1", "chat-1"],
        ["agent-sessions", "agent-1"],
        ["session-events", "agent-1", "chat-1"],
        ["chat-messages", "chat-1"],
        ["chat-detail", "chat-1"],
        ["attentions", "chat", "chat-1"],
      ]),
    );

    FakeWebSocket.instances[0]?.onclose?.({ code: 4001 });
    await Promise.resolve();
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]?.onopen?.();
    expect(queryClient.invalidations.map((call) => call.queryKey)).toContainEqual(["chat-messages"]);

    cleanups.forEach((cleanup) => {
      cleanup();
    });
    expect(FakeWebSocket.instances[1]?.close).toHaveBeenCalledWith(1000, "unmount");
  }, 15_000);

  it("uses exponential reconnect for non-auth closes and skips disabled or unauthenticated states", async () => {
    const disabled = await loadHook();
    disabled.useAdminWs({ enabled: false });
    expect(FakeWebSocket.instances).toHaveLength(0);

    vi.resetModules();
    const noToken = await loadHook({ token: null });
    noToken.useAdminWs();
    expect(FakeWebSocket.instances).toHaveLength(0);
    noToken.cleanups.forEach((cleanup) => {
      cleanup();
    });

    vi.resetModules();
    setupBrowser(null);
    const noOrg = await loadHook();
    noOrg.useAdminWs();
    expect(FakeWebSocket.instances).toHaveLength(0);
    noOrg.cleanups.forEach((cleanup) => {
      cleanup();
    });

    vi.resetModules();
    setupBrowser("org-2");
    const connected = await loadHook({ refreshedToken: null });
    connected.useAdminWs();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]?.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]?.onclose?.({ code: 4001 });
    await Promise.resolve();
    expect(connected.refreshAccessToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    connected.cleanups.forEach((cleanup) => {
      cleanup();
    });
  }, 15_000);
});
