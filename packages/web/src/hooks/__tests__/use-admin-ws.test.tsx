// @vitest-environment happy-dom

import type { AgentChatStatus } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const clientMocks = vi.hoisted(() => ({
  getStoredTokens: vi.fn(),
  refreshAccessToken: vi.fn(),
  getApiSelectedOrganizationId: vi.fn(),
  ADMIN_WS_ORG_CHANGED_EVENT: "admin-ws:org-changed",
}));

vi.mock("../../api/client.js", () => clientMocks);

type WsHandler = ((event: MessageEvent<string>) => void) | null;
type CloseHandler = ((event: CloseEvent) => void) | null;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: WsHandler = null;
  onopen: (() => void) | null = null;
  onclose: CloseHandler = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  open(): void {
    this.onopen?.();
  }

  closeWith(code: number): void {
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient;

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderHook(enabled = true, onMessage = vi.fn()): Promise<typeof onMessage> {
  const { useAdminWs } = await import("../use-admin-ws.js");
  function Probe() {
    useAdminWs({ enabled, onMessage });
    return <div>mounted</div>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await flush();
  return onMessage;
}

function makeStatus(overrides: Partial<AgentChatStatus> = {}): AgentChatStatus {
  return {
    agentId: overrides.agentId ?? "agent-1",
    main: overrides.main ?? "working",
    reachable: overrides.reachable ?? true,
    engagement: overrides.engagement ?? "active",
    working: overrides.working ?? true,
    errored: overrides.errored ?? false,
    activity: overrides.activity ?? null,
  };
}

beforeEach(() => {
  vi.resetModules();
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol: "https:", host: "first-tree.test" },
  });
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-1");
  clientMocks.getStoredTokens.mockReturnValue({ accessToken: "access-1", refreshToken: "refresh-1" });
  clientMocks.refreshAccessToken.mockResolvedValue({ accessToken: "access-2", refreshToken: "refresh-2" });
  root = null;
  container = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("useAdminWs", () => {
  it("connects once, broadcasts messages, patches status, and invalidates affected queries", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    queryClient = new QueryClient();
    const onMessage = await renderHook();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");

    expect(socket.url).toBe("wss://first-tree.test/api/v1/orgs/org-1/ws/?token=access-1");
    queryClient.setQueryData(
      ["chat-agent-status", "chat-1"],
      [makeStatus({ agentId: "agent-1", main: "ready", working: false })],
    );

    await act(async () => {
      socket.emit({ type: "session:state", agentId: "agent-1", chatId: "chat-1", status: makeStatus() });
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "session:state" }));
    expect(queryClient.getQueryData<AgentChatStatus[]>(["chat-agent-status", "chat-1"])?.[0]?.main).toBe("working");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["activity"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["sessions"] });

    await act(async () => {
      socket.emit({ type: "session:event", agentId: "agent-1", chatId: "chat-1", status: makeStatus() });
      socket.emit({ type: "chat:message", chatId: "chat-1" });
      socket.emit({ type: "pulse:tick" });
      socket.emit("not json");
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["session-events", "agent-1", "chat-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-session-events", "chat-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-messages", "chat-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-detail", "chat-1"] });
  });

  it("refreshes access tokens on auth close and reconnects immediately", async () => {
    const onMessage = await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");

    await act(async () => {
      first.closeWith(4001);
    });
    await flush();

    expect(clientMocks.refreshAccessToken).toHaveBeenCalled();
    const second = FakeWebSocket.instances[1];
    expect(second).toBeTruthy();

    await act(async () => {
      second?.open();
    });
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
  });

  it("skips disabled hooks and tears down the shared socket when the last subscriber unmounts", async () => {
    await renderHook(false);
    expect(FakeWebSocket.instances).toHaveLength(0);

    await renderHook(true);
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");
    await act(async () => root?.unmount());
    expect(socket.closed).toBe(true);
  });

  it("reconnects to the new org's socket when the selected org changes", async () => {
    await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");
    expect(first.url).toBe("wss://first-tree.test/api/v1/orgs/org-1/ws/?token=access-1");

    // selectOrganization flips the API client's selected-org value and fires the
    // org-changed event; the shared socket must drop org-1 and reopen on org-2.
    clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-2");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("admin-ws:org-changed"));
    });
    await flush();

    expect(first.closed).toBe(true);
    const second = FakeWebSocket.instances[1];
    expect(second?.url).toBe("wss://first-tree.test/api/v1/orgs/org-2/ws/?token=access-1");
  });

  it("ignores the org-changed event after the workspace socket has torn down", async () => {
    await renderHook();
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => root?.unmount());

    clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-2");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("admin-ws:org-changed"));
    });
    await flush();

    // No live consumer → no reconnect; the listener was removed on teardown.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
