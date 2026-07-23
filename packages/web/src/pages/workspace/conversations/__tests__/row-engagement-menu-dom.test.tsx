// @vitest-environment happy-dom

import type { CronJob } from "@first-tree/shared";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
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

const authMock = vi.hoisted(() => ({
  memberId: "member-owner" as string | null,
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

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => ({ memberId: authMock.memberId }),
}));

vi.mock("../../../../components/ui/toast.js", () => ({
  useToast: () => ({ addToast: toastMock.addToast }),
}));

function activeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? "job-1",
    ownerMemberId: overrides.ownerMemberId ?? "member-owner",
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
let queryClient: QueryClient;

const CRON_KEY = ["chat-right-sidebar", "cron-jobs", "chat-1"] as const;

/** Keeps the shared schedule cache ACTIVELY OBSERVED so an invalidation
 *  triggers a real refetch, exactly like the mounted sidebar section. */
function CronProbe() {
  useQuery({ queryKey: CRON_KEY, queryFn: () => cronApiMocks.listChatCronJobs("chat-1") });
  return null;
}

function probeJobs(): CronJob[] {
  return queryClient.getQueryData<{ items: CronJob[] }>(CRON_KEY)?.items ?? [];
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderMenu(status: "active" | "archived", opts?: { withProbe?: boolean }): Promise<void> {
  const { RowEngagementMenu } = await import("../row-engagement-menu.js");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <RowEngagementMenu chatId="chat-1" status={status} hasUnread={false} pinned={false} />
        {opts?.withProbe ? <CronProbe /> : null}
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
  authMock.memberId = "member-owner";
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
    cronApiMocks.listChatCronJobs.mockResolvedValue({
      items: [activeJob(), activeJob({ id: "job-2", ownerMemberId: "member-other" })],
    });
    await renderMenu("active");
    await selectMenuItem("Archive");

    expect(chatApiMocks.patchChatEngagement).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Archive this chat?");
    expect(document.body.textContent).toContain("2 active schedules");
    expect(document.body.textContent).toContain("keep running while the chat is archived");
    expect(document.body.textContent).toContain("visible in your list again");

    await click(buttonByText("Archive chat"));
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "archived");
  });

  it("always re-checks schedules at action time instead of trusting the sidebar cache", async () => {
    await renderMenu("active");
    // Seed a FRESH cached list containing an active job. If the guard reused
    // the sidebar's 30s-fresh cache, it would warn; the forced-fresh lookup
    // must instead re-request and see the current empty server state.
    queryClient.setQueryData(["chat-right-sidebar", "cron-jobs", "chat-1"], { items: [activeJob()] });
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [] });

    await selectMenuItem("Archive");

    expect(cronApiMocks.listChatCronJobs).toHaveBeenCalledWith("chat-1");
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "archived");
    expect(document.body.textContent).not.toContain("Archive this chat?");
  });

  it("delete warning only promises to pause the caller's own schedules", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [activeJob()] });
    await renderMenu("active");
    await selectMenuItem("Delete");

    expect(document.body.textContent).toContain("Delete this chat?");
    expect(document.body.textContent).toContain("1 active schedule");
    expect(document.body.textContent).toContain("Deleting pauses them first");
    expect(document.body.textContent).toContain("you must resume each schedule");

    await click(buttonByText("Delete chat"));
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "deleted");
  });

  it("delete warning says other members' schedules keep running but the deleted view stays hidden", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({
      items: [
        activeJob({ id: "job-a", ownerMemberId: "member-other" }),
        activeJob({ id: "job-b", ownerMemberId: "member-third" }),
      ],
    });
    await renderMenu("active");
    await selectMenuItem("Delete");

    expect(document.body.textContent).toContain("2 active schedules");
    expect(document.body.textContent).toContain("owned by other members");
    expect(document.body.textContent).toContain("does not pause them");
    expect(document.body.textContent).toContain("they keep running");
    // `deleted` is sticky: a later scheduled message revives only archived
    // views, so the copy must never promise the caller's view reappears.
    expect(document.body.textContent).toContain("stays hidden until you restore it");
    expect(document.body.textContent).not.toContain("visible again");
    expect(document.body.textContent).not.toContain("Deleting pauses them first");

    await click(buttonByText("Delete chat"));
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "deleted");
  });

  it("delete warning splits caller-owned and other-owned schedules in a mixed chat", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({
      items: [activeJob(), activeJob({ id: "job-2", ownerMemberId: "member-other" })],
    });
    await renderMenu("active");
    await selectMenuItem("Delete");

    expect(document.body.textContent).toContain("(1 yours, 1 owned by others)");
    expect(document.body.textContent).toContain("Deleting pauses only your 1 active schedule first");
    expect(document.body.textContent).toContain("owned by other members keep running");
    expect(document.body.textContent).toContain("will not resume yours");
    expect(document.body.textContent).toContain("stays hidden until you restore it");
    expect(document.body.textContent).not.toContain("visible again");
  });

  it("cancel leaves the engagement unchanged", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [activeJob()] });
    await renderMenu("active");
    await selectMenuItem("Delete");
    await click(buttonByText("Cancel"));

    expect(chatApiMocks.patchChatEngagement).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Delete this chat?");
  });

  it("a failed lookup fails safe: nothing applied until the owner chooses", async () => {
    cronApiMocks.listChatCronJobs.mockRejectedValue(new Error("endpoint down"));
    await renderMenu("active");
    await selectMenuItem("Delete");

    expect(chatApiMocks.patchChatEngagement).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Couldn't confirm schedules");
    expect(document.body.textContent).toContain("Nothing has been applied");

    // Retry re-runs the lookup; a healthy server then shows the real warning.
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [activeJob()] });
    await click(buttonByText("Retry"));
    expect(document.body.textContent).toContain("Delete this chat?");
    expect(document.body.textContent).toContain("1 active schedule");
    expect(chatApiMocks.patchChatEngagement).not.toHaveBeenCalled();

    await click(buttonByText("Delete chat"));
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "deleted");
  });

  it("proceed-anyway after a failed lookup is an explicit informed choice", async () => {
    cronApiMocks.listChatCronJobs.mockRejectedValue(new Error("endpoint down"));
    await renderMenu("active");
    await selectMenuItem("Archive");

    expect(document.body.textContent).toContain("Couldn't confirm schedules");
    expect(document.body.textContent).toContain("any active schedules keep running");

    await click(buttonByText("Archive anyway"));
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "archived");
  });

  it("delete refreshes the shared schedule cache to the server truth: owned paused, others untouched", async () => {
    const owned = activeJob();
    const other = activeJob({ id: "job-2", ownerMemberId: "member-other" });
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [owned, other] });
    await renderMenu("active", { withProbe: true });
    // The actively-observed cache (as the sidebar sees it) starts with both
    // owners' jobs active.
    expect(probeJobs().map((j) => j.state)).toEqual(["active", "active"]);

    await selectMenuItem("Delete");
    // The Server applies the owner-scoped pause without emitting
    // chat:updated; the next read after the delete returns the new truth.
    const pausedOwned: CronJob = {
      ...owned,
      state: "paused",
      stateReason: "owner_chat_deleted",
      revision: 2,
      nextRunAt: null,
    };
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [pausedOwned, other] });
    await click(buttonByText("Delete chat"));

    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "deleted");
    const jobs = probeJobs();
    const after = jobs.find((j) => j.id === "job-1");
    expect(after?.state).toBe("paused");
    expect(after?.stateReason).toBe("owner_chat_deleted");
    expect(after?.revision).toBe(2);
    expect(jobs.find((j) => j.id === "job-2")?.state).toBe("active");
  });

  it("a failed delete leaves the shared schedule cache untouched", async () => {
    const owned = activeJob();
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [owned] });
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    chatApiMocks.patchChatEngagement.mockRejectedValue(new Error("boom"));
    await renderMenu("active", { withProbe: true });
    await selectMenuItem("Delete");
    await click(buttonByText("Delete chat"));

    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "deleted");
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: CRON_KEY });
    expect(probeJobs().map((j) => j.state)).toEqual(["active"]);
  });

  it("archive does not touch the schedule projection (no server-side pause happens)", async () => {
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [] });
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderMenu("active");
    await selectMenuItem("Archive");

    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "archived");
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["chat-right-sidebar", "cron-jobs", "chat-1"] });
  });

  it("unarchive never consults schedules", async () => {
    await renderMenu("archived");
    await selectMenuItem("Unarchive");

    expect(cronApiMocks.listChatCronJobs).not.toHaveBeenCalled();
    expect(chatApiMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "active");
  });
});
