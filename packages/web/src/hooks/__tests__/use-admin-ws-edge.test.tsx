// @vitest-environment happy-dom

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

  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  emit(data: unknown): void {
    this.emitRaw(JSON.stringify(data));
  }

  open(): void {
    this.onopen?.();
  }

  closeWith(code: number): void {
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

let root: Root | null = null;
let queryClient: QueryClient;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderHook(onMessage = vi.fn()): Promise<typeof onMessage> {
  const { useAdminWs } = await import("../use-admin-ws.js");
  function Probe() {
    useAdminWs({ onMessage });
    return <div>mounted</div>;
  }
  const container = document.createElement("div");
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  Object.defineProperty(window, "WebSocket", { configurable: true, value: FakeWebSocket });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol: "http:", host: "first-tree.test" },
  });
  clientMocks.getStoredTokens.mockReturnValue({ accessToken: "access-1", refreshToken: "refresh-1" });
  clientMocks.getApiSelectedOrganizationId.mockReturnValue("org/one");
  clientMocks.refreshAccessToken.mockResolvedValue(null);
  queryClient = new QueryClient();
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useAdminWs edge cases", () => {
  it("skips opening a socket until both tokens and a selected org exist", async () => {
    clientMocks.getStoredTokens.mockReturnValueOnce(null);
    await renderHook();
    expect(FakeWebSocket.instances).toHaveLength(0);
    await act(async () => root?.unmount());

    clientMocks.getStoredTokens.mockReturnValue({ accessToken: "access-1", refreshToken: "refresh-1" });
    clientMocks.getApiSelectedOrganizationId.mockReturnValueOnce(null);
    await renderHook();

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("ignores stale socket events and reconnects after a normal close", async () => {
    const onMessage = await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");
    expect(first.url).toBe("ws://first-tree.test/api/v1/orgs/org%2Fone/ws/?token=access-1");

    clientMocks.getApiSelectedOrganizationId.mockReturnValue("org-two");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("admin-ws:org-changed"));
    });
    const second = FakeWebSocket.instances[1];
    if (!second) throw new Error("second socket missing");

    await act(async () => {
      first.emit({ type: "chat:updated", chatId: "stale-chat" });
      first.open();
      first.closeWith(1006);
    });

    expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ chatId: "stale-chat" }));
    expect(FakeWebSocket.instances).toHaveLength(2);

    await act(async () => {
      second.closeWith(1006);
      vi.advanceTimersByTime(2000);
    });

    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(FakeWebSocket.instances[2]?.url).toBe("ws://first-tree.test/api/v1/orgs/org-two/ws/?token=access-1");
  });

  it("falls back to reconnect backoff when token refresh fails", async () => {
    await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");

    await act(async () => {
      first.closeWith(4001);
    });
    await flush();
    expect(clientMocks.refreshAccessToken).toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("invalidates catch-up queries and broadcasts only reconnect opens", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const onMessage = await renderHook();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("socket missing");

    await act(async () => {
      first.open();
    });
    expect(onMessage).not.toHaveBeenCalledWith({ type: "ws:reconnect" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-messages"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-open-requests"] });

    await act(async () => {
      first.closeWith(1006);
      vi.advanceTimersByTime(2000);
    });
    const second = FakeWebSocket.instances[1];
    if (!second) throw new Error("second socket missing");

    await act(async () => {
      second.open();
    });

    expect(onMessage).toHaveBeenCalledWith({ type: "ws:reconnect" });
  });

  it("invalidates runtime, event fallback, chat update, and malformed chat message branches", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const onMessage = vi.fn(() => {
      throw new Error("subscriber failure should be isolated");
    });
    await renderHook(onMessage);
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("socket missing");

    await act(async () => {
      socket.emit({ type: "session:runtime", chatId: "chat-1", status: { invalid: true } });
      socket.emit({ type: "session:event", chatId: "chat-1", status: { invalid: true } });
      socket.emit({ type: "chat:updated", chatId: "chat-1" });
      socket.emit({ type: "chat:message" });
      socket.emitRaw("{");
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "session:runtime" }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-agent-status"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-detail", "chat-1"] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["chat-messages", "chat-1"] });
  });
});
