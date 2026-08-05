// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const meChatMocks = vi.hoisted(() => ({
  listNeedYouRequests: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: { organizationId: "org-1" as string | null },
}));

vi.mock("../../../../api/me-chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/me-chats.js")>()),
  listNeedYouRequests: meChatMocks.listNeedYouRequests,
}));

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
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

async function renderEntry(
  element: ReactElement,
): Promise<{ container: HTMLElement; root: Root; queryClient: QueryClient }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createClient();
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  await flush();
  return { container, root, queryClient };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { organizationId: "org-1" };
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe.each([
  { variant: "desktop" as const },
  { variant: "mobile" as const },
])("NeedYouEntry ($variant) queue states", ({ variant }) => {
  async function render() {
    const { NeedYouEntry } = await import("../need-you-entry.js");
    const onOpen = vi.fn();
    const rendered = await renderEntry(<NeedYouEntry variant={variant} onOpen={onOpen} />);
    const button = () => rendered.container.querySelector("button");
    return { ...rendered, onOpen, button };
  }

  it("announces loading as unknown, never as a confirmed zero", async () => {
    // A cold, still-pending queue must not read as "no questions".
    meChatMocks.listNeedYouRequests.mockReturnValue(new Promise(() => {}));
    const { button, root } = await render();

    expect(button()?.disabled).toBe(true);
    expect(button()?.getAttribute("aria-label")).toBe("Need you, loading");
    expect(button()?.getAttribute("aria-label")).not.toContain("no questions");

    await act(async () => root.unmount());
  });

  it("keeps the entry reachable on error and retries the queue fetch on click", async () => {
    meChatMocks.listNeedYouRequests.mockRejectedValue(new Error("queue unavailable"));
    const { button, onOpen, root } = await render();

    await waitForCondition(
      () => button()?.getAttribute("aria-label")?.includes("failed to load") === true,
      "error label",
    );
    expect(button()?.disabled).toBe(false);

    // There is no review page to recover in: the click retries the fetch
    // itself and never navigates on unknown queue state.
    const callsBefore = meChatMocks.listNeedYouRequests.mock.calls.length;
    await click(button());
    expect(onOpen).not.toHaveBeenCalled();
    await waitForCondition(() => meChatMocks.listNeedYouRequests.mock.calls.length > callsBefore, "retry fetch");

    await act(async () => root.unmount());
  });

  it("disables only on a confirmed zero", async () => {
    meChatMocks.listNeedYouRequests.mockResolvedValue({ items: [], total: 0 });
    const { button, onOpen, root } = await render();

    await waitForCondition(
      () => button()?.getAttribute("aria-label") === "Need you, no questions",
      "confirmed-zero label",
    );
    expect(button()?.disabled).toBe(true);

    await click(button());
    expect(onOpen).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("enables with the exact count and opens the oldest request's chat", async () => {
    meChatMocks.listNeedYouRequests.mockResolvedValue({
      items: [
        { request: { id: "req-old" }, chat: { id: "chat-oldest", title: "Oldest" }, asker: { agentId: "agent-1" } },
        { request: { id: "req-new" }, chat: { id: "chat-newer", title: "Newer" }, asker: { agentId: "agent-2" } },
      ],
      total: 2,
    });
    const { button, onOpen, root } = await render();

    await waitForCondition(() => button()?.getAttribute("aria-label") === "Need you, 2 questions", "count label");
    expect(button()?.disabled).toBe(false);
    expect(button()?.textContent).toContain("2");

    await click(button());
    expect(onOpen).toHaveBeenCalledWith("chat-oldest");

    await act(async () => root.unmount());
  });
});
