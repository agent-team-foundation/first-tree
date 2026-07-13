// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RowEngagementMenu } from "../row-engagement-menu.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const meChatMocks = vi.hoisted(() => ({
  markMeChatUnread: vi.fn(),
  pinMeChat: vi.fn(),
}));

const chatMocks = vi.hoisted(() => ({
  patchChatEngagement: vi.fn(),
}));

vi.mock("../../../../api/me-chats.js", () => meChatMocks);
vi.mock("../../../../api/chats.js", () => ({
  patchChatEngagement: chatMocks.patchChatEngagement,
}));
// The menu's pin mutation surfaces failures via a toast; the harness renders no
// ToastProvider, so stub the hook (its addToast is exercised in a failure test).
const toastMocks = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("../../../../components/ui/toast.js", () => ({ useToast: () => toastMocks }));

let root: Root | null = null;
let queryClient: QueryClient | null = null;

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = createClient();
  queryClient = client;
  await act(async () => {
    root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function manageButton(rootNode: ParentNode): HTMLButtonElement | null {
  return rootNode.querySelector<HTMLButtonElement>('button[aria-label="Manage chat"]');
}

function menuItem(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );
  if (!button) throw new Error(`Missing menu item ${label}`);
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  meChatMocks.markMeChatUnread.mockResolvedValue(undefined);
  meChatMocks.pinMeChat.mockResolvedValue({ chatId: "chat", pinnedAt: null });
  chatMocks.patchChatEngagement.mockResolvedValue(undefined);
  root = null;
  queryClient = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
  queryClient?.clear();
});

describe("RowEngagementMenu", () => {
  it("marks active chats unread and invalidates chat caches", async () => {
    const dom = await render(
      <RowEngagementMenu chatId="chat-active" status="active" hasUnread={false} pinned={false} />,
    );
    const invalidate = vi.spyOn(queryClient as QueryClient, "invalidateQueries");

    await click(manageButton(dom));
    await click(menuItem("Mark as unread"));

    expect(meChatMocks.markMeChatUnread).toHaveBeenCalledWith("chat-active");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["me", "chats"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chat-detail", "chat-active"] });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables mark-unread when the active row already has unread work", async () => {
    const dom = await render(
      <RowEngagementMenu chatId="chat-unread" status="active" hasUnread={true} pinned={false} />,
    );

    await click(manageButton(dom));
    const markUnread = menuItem("Mark as unread");

    expect(markUnread.disabled).toBe(true);
    await click(markUnread);
    expect(meChatMocks.markMeChatUnread).not.toHaveBeenCalled();
  });

  it("archives and deletes active chats through engagement mutations", async () => {
    const dom = await render(
      <RowEngagementMenu chatId="chat-active" status="active" hasUnread={false} pinned={false} />,
    );

    await click(manageButton(dom));
    await click(menuItem("Archive"));
    await click(manageButton(dom));
    await click(menuItem("Delete"));

    expect(chatMocks.patchChatEngagement.mock.calls).toEqual([
      ["chat-active", "archived"],
      ["chat-active", "deleted"],
    ]);
  });

  it("offers archived-row recovery without the active-only mark-unread action", async () => {
    const dom = await render(
      <RowEngagementMenu chatId="chat-archived" status="archived" hasUnread={false} pinned={false} />,
    );

    await click(manageButton(dom));
    expect(document.body.textContent).toContain("Unarchive");
    expect(document.body.textContent).toContain("Delete");
    expect(document.body.textContent).not.toContain("Mark as unread");
    expect(document.body.textContent).not.toContain("Archive");

    await click(menuItem("Unarchive"));

    expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith("chat-archived", "active");
  });

  it("renders no menu for deleted rows", async () => {
    const dom = await render(
      <RowEngagementMenu chatId="chat-deleted" status="deleted" hasUnread={false} pinned={false} />,
    );

    expect(manageButton(dom)).toBeNull();
  });

  it("pins an unpinned chat and invalidates the list caches", async () => {
    const dom = await render(
      <RowEngagementMenu chatId="chat-active" status="active" hasUnread={false} pinned={false} />,
    );
    const invalidate = vi.spyOn(queryClient as QueryClient, "invalidateQueries");

    await click(manageButton(dom));
    await click(menuItem("Pin"));

    expect(meChatMocks.pinMeChat).toHaveBeenCalledWith("chat-active", true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["me", "chats"] });
    // A success toast confirms the write — the row only regroups once the
    // invalidate-driven refetch lands, so silence would read as a no-op.
    expect(toastMocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Pinned" }));
  });

  it("offers Unpin on a pinned chat and toggles it off", async () => {
    const dom = await render(
      <RowEngagementMenu chatId="chat-pinned" status="active" hasUnread={false} pinned={true} />,
    );

    await click(manageButton(dom));
    expect(document.body.textContent).toContain("Unpin");
    await click(menuItem("Unpin"));

    expect(meChatMocks.pinMeChat).toHaveBeenCalledWith("chat-pinned", false);
    expect(toastMocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Unpinned" }));
  });

  it("shows an error toast when a pin write fails", async () => {
    meChatMocks.pinMeChat.mockRejectedValueOnce(new Error("nope"));
    const dom = await render(
      <RowEngagementMenu chatId="chat-active" status="active" hasUnread={false} pinned={false} />,
    );

    await click(manageButton(dom));
    await click(menuItem("Pin"));

    expect(toastMocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't pin" }));
  });

  it("skips non-infinite me-chats caches (palette / mobile) instead of throwing on the optimistic apply", async () => {
    const dom = await render(
      <RowEngagementMenu chatId="chat-active" status="active" hasUnread={false} pinned={false} />,
    );
    // The command palette and mobile lists store a BARE `ListMeChatsResponse`
    // (no `pages`) under the same `["me","chats"]` prefix the pin optimistic
    // apply writes through. Feeding one to the InfiniteData transform would throw
    // on `data.pages`; the `"pages" in old` guard must skip it. Without the guard
    // `onMutate` throws before `pinMeChat` is ever called.
    const palette = { priorityRows: { attention: [], pinned: [] }, rows: [], nextCursor: null };
    (queryClient as QueryClient).setQueryData(["me", "chats", "palette"], palette);

    await click(manageButton(dom));
    await click(menuItem("Pin"));

    expect(meChatMocks.pinMeChat).toHaveBeenCalledWith("chat-active", true);
    expect(toastMocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Pinned" }));
    // The bare cache is left untouched (same reference) — it reconciles via the
    // trailing invalidate, not the optimistic transform.
    expect((queryClient as QueryClient).getQueryData(["me", "chats", "palette"])).toBe(palette);
  });
});
