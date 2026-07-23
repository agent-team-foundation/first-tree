// @vitest-environment happy-dom

import type { CronJob } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const chatApiMocks = vi.hoisted(() => ({
  patchChatEngagement: vi.fn(),
}));

const cronApiMocks = vi.hoisted(() => ({
  listChatCronJobs: vi.fn(),
}));

const meChatMocks = vi.hoisted(() => ({
  markMeChatUnread: vi.fn(),
  pinMeChat: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("../../../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/chats.js")>()),
  patchChatEngagement: chatApiMocks.patchChatEngagement,
}));

vi.mock("../../../../api/cron-jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/cron-jobs.js")>()),
  listChatCronJobs: cronApiMocks.listChatCronJobs,
}));

vi.mock("../../../../api/me-chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/me-chats.js")>()),
  markMeChatUnread: meChatMocks.markMeChatUnread,
  pinMeChat: meChatMocks.pinMeChat,
}));

vi.mock("../../../../components/ui/toast.js", () => ({
  useToast: () => ({ addToast: toastMock.addToast }),
}));

function activeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? "job-1",
    ownerMemberId: "member-owner",
    controlChatId: "chat-1",
    agentId: "agent-1",
    name: "Daily summary",
    chatMode: "reuse_control_chat",
    schedule: "0 9 * * *",
    timezone: "UTC",
    prompt: "Summarize.",
    state: overrides.state ?? "active",
    stateReason: null,
    revision: 1,
    nextRunAt: "2030-01-02T09:00:00.000Z",
    outstanding: null,
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderMenu(status: "active" | "archived"): Promise<void> {
  const { RowEngagementMenu } = await import("../row-engagement-menu.js");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <RowEngagementMenu chatId="chat-1" status={status} hasUnread={false} pinned={false} />
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function selectMenuItem(label: string): Promise<void> {
  await click(document.querySelector('button[aria-label="Manage chat"]'));
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === label);
  await click(item);
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

beforeEach(() => {
  vi.clearAllMocks();
  chatApiMocks.patchChatEngagement.mockResolvedValue({ chatId: "chat-1", engagementStatus: "archived" });
  cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [] });
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("RowEngagementMenu schedule warnings", () => {
  it("archives immediately when the chat has no schedules (pre-change behavior)", async () => {
    await renderMenu("active");
    await selectMenuItem("Archive");

    expect(cronApiMocks.listChatCronJobs).toHaveBeenCalledWith("chat-1");
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "archived");
    expect(document.body.textContent).not.toContain("Archive this chat?");
  });

  it("archives immediately when every schedule is already paused", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [activeJob({ state: "paused" })] });
    await renderMenu("active");
    await selectMenuItem("Archive");

    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "archived");
    expect(document.body.textContent).not.toContain("Archive this chat?");
  });

  it("warns before archiving a chat with active schedules, then proceeds on confirm", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [activeJob()] });
    await renderMenu("active");
    await selectMenuItem("Archive");

    expect(chatApiMocks.patchChatEngagement).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Archive this chat?");
    expect(document.body.textContent).toContain("1 active schedule");
    expect(document.body.textContent).toContain("keep running while the chat is archived");
    expect(document.body.textContent).toContain("visible in your list again");

    await click(buttonByText("Archive chat"));
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "archived");
  });

  it("warns that delete pauses active schedules and restore will not resume them", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [activeJob(), activeJob({ id: "job-2" })] });
    await renderMenu("active");
    await selectMenuItem("Delete");

    expect(chatApiMocks.patchChatEngagement).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Delete this chat?");
    expect(document.body.textContent).toContain("2 active schedules");
    expect(document.body.textContent).toContain("Deleting pauses them first");
    expect(document.body.textContent).toContain("will not resume them");

    await click(buttonByText("Delete chat"));
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "deleted");
  });

  it("cancel leaves the engagement unchanged", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [activeJob()] });
    await renderMenu("active");
    await selectMenuItem("Delete");
    await click(buttonByText("Cancel"));

    expect(chatApiMocks.patchChatEngagement).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Delete this chat?");
  });

  it("fails open when the schedule lookup errors — the warning is advisory, not a gate", async () => {
    cronApiMocks.listChatCronJobs.mockRejectedValue(new Error("endpoint down"));
    await renderMenu("active");
    await selectMenuItem("Delete");

    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "deleted");
  });

  it("unarchive never consults schedules", async () => {
    await renderMenu("archived");
    await selectMenuItem("Unarchive");

    expect(cronApiMocks.listChatCronJobs).not.toHaveBeenCalled();
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "active");
  });
});
