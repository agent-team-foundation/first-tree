// @vitest-environment happy-dom

import type { Message } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast.js";
import {
  addAskAgentNavLock,
  clearAskAgentNavLocks,
  getAskAgentNavTarget,
  installAskAgentNavGuard,
  isAskAgentNavLocked,
  removeAskAgentNavLock,
  subscribeAskAgentNavLock,
  uninstallAskAgentNavGuardForTest,
  useAskAgentNavLocked,
} from "../ask-agent-nav-lock.js";
import { useAskAgent } from "../use-ask-agent.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const chatMocks = vi.hoisted(() => ({
  listRequestThread: vi.fn(),
  sendAskAgentQuestion: vi.fn(),
}));

const agentStatusMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

vi.mock("../../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/chats.js")>()),
  listRequestThread: chatMocks.listRequestThread,
  sendAskAgentQuestion: chatMocks.sendAskAgentQuestion,
}));

vi.mock("../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId] as const,
  fetchChatAgentStatuses: agentStatusMocks.fetchChatAgentStatuses,
}));

function message(overrides: Partial<Message> & Pick<Message, "id" | "senderId">): Message {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    format: overrides.format ?? "markdown",
    content: overrides.content ?? "Can you clarify?",
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt ?? "2026-07-28T10:00:00.000Z",
  };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForCondition(predicate: () => boolean, messageText: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(messageText);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === text) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  uninstallAskAgentNavGuardForTest();
});

afterEach(() => {
  uninstallAskAgentNavGuardForTest();
  document.body.innerHTML = "";
});

describe("ask-agent nav lock store", () => {
  it("tracks locks, notifies subscribers, and dedupes repeat writes", () => {
    const notifications: boolean[] = [];
    const off = subscribeAskAgentNavLock(() => {
      notifications.push(isAskAgentNavLocked());
    });

    const lock = { chatId: "chat-1", requestId: "req-1" };
    expect(isAskAgentNavLocked()).toBe(false);
    addAskAgentNavLock(lock);
    expect(isAskAgentNavLocked()).toBe(true);
    // Duplicate add / unknown remove are no-ops (no extra notifications).
    addAskAgentNavLock(lock);
    removeAskAgentNavLock({ chatId: "chat-1", requestId: "req-other" });
    expect(isAskAgentNavLocked()).toBe(true);
    removeAskAgentNavLock(lock);
    expect(isAskAgentNavLocked()).toBe(false);

    off();
    expect(notifications).toEqual([true, false]);

    addAskAgentNavLock(lock);
    uninstallAskAgentNavGuardForTest();
    expect(isAskAgentNavLocked()).toBe(false);
  });

  it("pins the surface target on the first lock and releases it on the last", () => {
    const first = { chatId: "chat-1", requestId: "req-1" };
    const second = { chatId: "chat-2", requestId: "req-2" };

    expect(getAskAgentNavTarget()).toBeNull();
    addAskAgentNavLock(first);
    const target = getAskAgentNavTarget();
    expect(target).not.toBeNull();
    expect(target?.url).toBe(`${window.location.pathname}${window.location.search}${window.location.hash}`);

    // A second lock does NOT move the pinned target; removing it keeps the
    // first target pinned; the last removal releases it.
    addAskAgentNavLock(second);
    expect(getAskAgentNavTarget()).toBe(target);
    removeAskAgentNavLock(second);
    expect(getAskAgentNavTarget()).toBe(target);
    removeAskAgentNavLock(first);
    expect(getAskAgentNavTarget()).toBeNull();
  });
});

describe("installAskAgentNavGuard", () => {
  it("registers the singleton listener exactly once (idempotent) and uninstalls cleanly", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    try {
      installAskAgentNavGuard();
      installAskAgentNavGuard();
      const popRegistrations = addSpy.mock.calls.filter(([type]) => type === "popstate");
      expect(popRegistrations).toHaveLength(1);

      const removeSpy = vi.spyOn(window, "removeEventListener");
      try {
        uninstallAskAgentNavGuardForTest();
        expect(removeSpy.mock.calls.filter(([type]) => type === "popstate")).toHaveLength(1);
        // A fresh install after teardown registers again.
        installAskAgentNavGuard();
        expect(addSpy.mock.calls.filter(([type]) => type === "popstate")).toHaveLength(2);
      } finally {
        removeSpy.mockRestore();
      }
    } finally {
      addSpy.mockRestore();
    }
  });

  it("is wired in main.tsx before the React root renders", async () => {
    // Production ordering contract: the singleton's popstate listener must
    // exist BEFORE BrowserRouter's history listener (at-target listeners run
    // in registration order). Assert the bootstrap call precedes createRoot.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    const installAt = source.indexOf("installAskAgentNavGuard()");
    const renderAt = source.indexOf("createRoot(");
    expect(installAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(-1);
    expect(installAt).toBeLessThan(renderAt);
  });
});

/**
 * Simulates the `useAskAgent` owner: publishes the attempt lock while the
 * review surface is mounted and removes it from the unmount cleanup — the
 * exact lifecycle that made the real-browser Back lose the waiting state.
 */
function OwnerProbe() {
  useEffect(() => {
    const lock = { chatId: "chat-1", requestId: "req-1" };
    addAskAgentNavLock(lock);
    return () => removeAskAgentNavLock(lock);
  }, []);
  return <div data-testid="owner-surface">owner surface</div>;
}

function BrowserShell() {
  const locked = useAskAgentNavLocked();
  const location = useLocation();
  const navigate = useNavigate();
  const reviewing = location.search.includes("review=need-you");
  return (
    <div>
      <div data-testid="browser-location">{`${location.pathname}${location.search}`}</div>
      <div data-testid="browser-locked">{String(locked)}</div>
      <button type="button" onClick={() => navigate("/?review=need-you")}>
        open review
      </button>
      <button type="button" onClick={() => navigate("/?review=need-you#evidence")}>
        open review with hash
      </button>
      <button type="button" onClick={() => navigate("/?future")}>
        open future
      </button>
      {reviewing ? <OwnerProbe /> : <div data-testid="home-surface">home surface</div>}
    </div>
  );
}

describe("bootstrap singleton guard with a real BrowserRouter", () => {
  async function renderBrowserShell(): Promise<{
    container: HTMLElement;
    root: ReturnType<typeof createRoot>;
    locationText: () => string | null | undefined;
    addressBar: () => string;
  }> {
    // Mirror main.tsx: the singleton guard installs BEFORE the React root
    // renders, so its popstate listener is registered before BrowserRouter's
    // history listener — the only ordering that exists at the window target.
    installAskAgentNavGuard();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BrowserRouter unstable_useTransitions={false}>
          <BrowserShell />
        </BrowserRouter>,
      );
    });
    await flush();
    return {
      container,
      root,
      locationText: () => container.querySelector('[data-testid="browser-location"]')?.textContent,
      addressBar: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
    };
  }

  it("blocks browser Back before the router commits the exit, and resumes after the attempt lifts", async () => {
    const { container, root, locationText, addressBar } = await renderBrowserShell();
    expect(locationText()).toBe("/");
    expect(container.querySelector('[data-testid="home-surface"]')).not.toBeNull();

    // Router-side witness, registered AFTER the bootstrap singleton (which
    // `renderBrowserShell` installed before the React root) — the same
    // position React Router's own popstate listener holds in production.
    // `popstate` fires AT the window target, so listeners run in
    // REGISTRATION ORDER: the singleton sees a locked pop first and calls
    // `stopImmediatePropagation()`, and no later-registered listener — this
    // witness included — may ever observe it.
    const bubbleWitness = vi.fn();
    window.addEventListener("popstate", bubbleWitness);
    try {
      // Build real history: / → /?review=need-you. The owner mounts and
      // publishes the attempt lock; the store pins URL + history index.
      await click(buttonByText(container, "open review"));
      expect(locationText()).toBe("/?review=need-you");
      expect(container.querySelector('[data-testid="owner-surface"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="browser-locked"]')?.textContent).toBe("true");
      expect(isAskAgentNavLocked()).toBe(true);

      // Real browser Back. Without the earlier-registered singleton, the
      // router's listener would process the pop and commit the exit
      // (unmounting the owner, whose cleanup removes the lock).
      await act(async () => {
        window.history.back();
      });
      await flush();
      expect(bubbleWitness).not.toHaveBeenCalled();
      expect(locationText()).toBe("/?review=need-you");
      expect(addressBar()).toBe("/?review=need-you");
      expect(container.querySelector('[data-testid="owner-surface"]')).not.toBeNull();
      expect(isAskAgentNavLocked()).toBe(true);

      // A second Back is trapped the same way.
      await act(async () => {
        window.history.back();
      });
      await flush();
      expect(bubbleWitness).not.toHaveBeenCalled();
      expect(locationText()).toBe("/?review=need-you");
      expect(container.querySelector('[data-testid="owner-surface"]')).not.toBeNull();

      // The attempt lifts: the same Back now commits normally (the router's
      // listener sees the pop again).
      await act(async () => {
        clearAskAgentNavLocks();
      });
      await flush();
      expect(container.querySelector('[data-testid="browser-locked"]')?.textContent).toBe("false");
      await act(async () => {
        window.history.back();
      });
      await flush();
      expect(bubbleWitness).toHaveBeenCalled();
      expect(locationText()).toBe("/");
      expect(addressBar()).toBe("/");
      expect(container.querySelector('[data-testid="home-surface"]')).not.toBeNull();

      await act(async () => root.unmount());
    } finally {
      window.removeEventListener("popstate", bubbleWitness);
    }
  });

  it("blocks browser Forward with an entry ahead of the locked review, preserving the exact hash URL", async () => {
    const { container, root, locationText, addressBar } = await renderBrowserShell();
    const bubbleWitness = vi.fn();
    window.addEventListener("popstate", bubbleWitness);
    try {
      // Build real history with an entry AHEAD of the review:
      // / → /?review=need-you#evidence → /?future. All pushes — no pops yet.
      await click(buttonByText(container, "open review with hash"));
      await click(buttonByText(container, "open future"));
      expect(locationText()).toBe("/?future");
      expect(container.querySelector('[data-testid="owner-surface"]')).toBeNull();

      // Return to the review while UNLOCKED: the router processes the pop,
      // the owner mounts and engages the lock with the hash URL captured.
      await act(async () => {
        window.history.back();
      });
      await flush();
      expect(locationText()).toBe("/?review=need-you");
      expect(addressBar()).toBe("/?review=need-you#evidence");
      expect(container.querySelector('[data-testid="owner-surface"]')).not.toBeNull();
      expect(isAskAgentNavLocked()).toBe(true);

      // Real browser Forward while locked: a genuine popstate with
      // currentIdx > target.idx — the negative-delta branch. The router side
      // never sees the pop; the exact hash URL is preserved.
      bubbleWitness.mockClear();
      await act(async () => {
        window.history.forward();
      });
      await flush();
      expect(bubbleWitness).not.toHaveBeenCalled();
      expect(locationText()).toBe("/?review=need-you");
      expect(addressBar()).toBe("/?review=need-you#evidence");
      expect(container.querySelector('[data-testid="owner-surface"]')).not.toBeNull();
      expect(isAskAgentNavLocked()).toBe(true);

      // The attempt lifts: the same Forward now reaches /?future normally.
      await act(async () => {
        clearAskAgentNavLocks();
      });
      await flush();
      await act(async () => {
        window.history.forward();
      });
      await flush();
      expect(bubbleWitness).toHaveBeenCalled();
      expect(locationText()).toBe("/?future");
      expect(addressBar()).toBe("/?future");
      expect(container.querySelector('[data-testid="owner-surface"]')).toBeNull();

      await act(async () => root.unmount());
    } finally {
      window.removeEventListener("popstate", bubbleWitness);
    }
  });
});

function AskAgentProbe() {
  const controller = useAskAgent({
    chatId: "chat-1",
    requestId: "req-1",
    humanAgentId: "human-1",
    askerAgentId: "agent-1",
  });
  return <div data-testid="ask-waiting">{String(controller.waiting)}</div>;
}

describe("useAskAgent navigation lock publishing", () => {
  it("locks while a clarification awaits a reply and unlocks when the reply lands", async () => {
    const startedAt = Date.now();
    const clarification = message({
      id: "clarification-1",
      senderId: "human-1",
      inReplyTo: "req-1",
      metadata: { askAgent: { requestId: "req-1", agentId: "agent-1" } },
      createdAt: new Date(startedAt).toISOString(),
    });
    const reply = message({
      id: "reply-1",
      senderId: "agent-1",
      inReplyTo: clarification.id,
      content: "The migration keeps the old API compatible.",
      createdAt: new Date(startedAt + 1_000).toISOString(),
    });
    chatMocks.listRequestThread.mockResolvedValue({ items: [clarification] });
    agentStatusMocks.fetchChatAgentStatuses.mockResolvedValue([]);

    const queryClient = createClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AskAgentProbe />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flush();

    // Waiting for the durable reply: the shared lock is held.
    await waitForCondition(
      () => container.querySelector('[data-testid="ask-waiting"]')?.textContent === "true",
      "waiting state",
    );
    expect(isAskAgentNavLocked()).toBe(true);

    // The reply lands: waiting ends and the lock lifts.
    await act(async () => {
      queryClient.setQueryData(["request-thread", "chat-1", "req-1"], { items: [clarification, reply] });
    });
    await flush();
    await waitForCondition(
      () => container.querySelector('[data-testid="ask-waiting"]')?.textContent === "false",
      "reply applied",
    );
    expect(isAskAgentNavLocked()).toBe(false);

    await act(async () => root.unmount());
    expect(isAskAgentNavLocked()).toBe(false);
  });
});
