// @vitest-environment happy-dom

import type { Agent, UsageAgentSummary, UsageTurnsResponse } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDetailContext } from "../layout-context.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const contextMock = vi.hoisted(() => ({
  value: null as AgentDetailContext | null,
}));

const usageMocks = vi.hoisted(() => ({
  getAgentUsageSummary: vi.fn(),
  getAgentUsageTurns: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("../layout-context.js", () => ({
  useAgentDetailContext: () => {
    if (!contextMock.value) throw new Error("Missing agent detail context");
    return contextMock.value;
  },
}));

vi.mock("../../../api/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/usage.js")>()),
  getAgentUsageSummary: usageMocks.getAgentUsageSummary,
  getAgentUsageTurns: usageMocks.getAgentUsageTurns,
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => routerMocks.navigate,
}));

const NOW = "2026-05-28T12:00:00.000Z";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-self",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "inbox-1",
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function createContext(overrides: Partial<AgentDetailContext> = {}): AgentDetailContext {
  const baseAgent = overrides.agent ?? agent();
  return {
    uuid: baseAgent.uuid,
    agent: baseAgent,
    isHuman: baseAgent.type === "human",
    canManageAgent: true,
    canEditConfig: true,
    guardedNavigate: vi.fn(),
    draft: {} as AgentDetailContext["draft"],
    config: undefined,
    configLoading: false,
    configError: null,
    clientStatus: undefined,
    clientStatusLoading: false,
    clientStatusError: null,
    isUnclaimed: false,
    isOffline: false,
    boundClientLabel: "gandy-macbook",
    setupRuntimeProvider: "claude-code",
    onOpenBindDialog: () => undefined,
    onOpenRebindDialog: () => undefined,
    bindClientPending: false,
    saveIdentity: async () => undefined,
    refreshAgent: async () => undefined,
    suspendPending: false,
    reactivatePending: false,
    deletePending: false,
    dangerError: null,
    onSuspend: () => undefined,
    onReactivate: () => undefined,
    onDelete: () => undefined,
    dryRunText: null,
    dryRunPending: false,
    onRunDryRun: () => undefined,
    ...overrides,
  };
}

function summary(overrides: Partial<UsageAgentSummary> = {}): UsageAgentSummary {
  return {
    agentId: overrides.agentId ?? "agent-1",
    from: overrides.from ?? "2026-04-28T12:00:00.000Z",
    to: overrides.to ?? NOW,
    totals: overrides.totals ?? {
      inputTokens: 1_200_000,
      cachedInputTokens: 2_000_000,
      outputTokens: 450_000,
      turns: 42,
      chats: 7,
      lastUsageAt: "2026-05-28T11:30:00.000Z",
    },
    daily: overrides.daily ?? [
      {
        date: "2026-05-27",
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 25,
        turns: 2,
      },
      {
        date: "2026-05-28",
        inputTokens: 9_000,
        cachedInputTokens: 1_000,
        outputTokens: 500,
        turns: 4,
      },
    ],
  };
}

function turnsResponse(overrides: Partial<UsageTurnsResponse> = {}): UsageTurnsResponse {
  return {
    agentId: overrides.agentId ?? "agent-1",
    from: overrides.from ?? "2026-04-28T12:00:00.000Z",
    to: overrides.to ?? NOW,
    rows: overrides.rows ?? [
      {
        seq: 1,
        chatId: "chat-1",
        chatTitle: "Launch planning",
        createdAt: "2026-05-28T11:50:00.000Z",
        inputTokens: 12_000,
        cachedInputTokens: 30_000,
        outputTokens: 4_200,
        provider: "claude-code",
        model: "sonnet",
      },
      {
        seq: 2,
        chatId: "chat-private",
        chatTitle: null,
        createdAt: "2026-05-28T11:55:00.000Z",
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 300,
        provider: "codex",
        model: "gpt-5",
      },
    ],
    nextCursor: overrides.nextCursor ?? "cursor-2",
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderUsageTab(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected an element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  contextMock.value = createContext();
  usageMocks.getAgentUsageSummary.mockReset();
  usageMocks.getAgentUsageTurns.mockReset();
  routerMocks.navigate.mockReset();
  usageMocks.getAgentUsageSummary.mockResolvedValue(summary());
  usageMocks.getAgentUsageTurns.mockImplementation(async (_agentId: string, args: { cursor?: string | null }) =>
    args.cursor
      ? turnsResponse({
          rows: [
            {
              seq: 3,
              chatId: "chat-2",
              chatTitle: "Follow-up",
              createdAt: "2026-05-28T11:59:00.000Z",
              inputTokens: 2_000,
              cachedInputTokens: 500,
              outputTokens: 250,
              provider: "claude-code",
              model: "opus",
            },
          ],
          nextCursor: null,
        })
      : turnsResponse(),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("UsageTab", () => {
  it("renders activity, recent turns, and chat navigation", async () => {
    const { UsageTab } = await import("../usage-tab.js");
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    usageMocks.getAgentUsageSummary.mockResolvedValue(
      summary({
        daily: [
          {
            date: today.toISOString().slice(0, 10),
            inputTokens: 9_000,
            cachedInputTokens: 1_000,
            outputTokens: 500,
            turns: 4,
          },
        ],
      }),
    );

    const { container, root } = await renderUsageTab(<UsageTab />);
    const activityCells = [...container.querySelectorAll("span.usage-cal-cell[role='img']")];
    expect(container.textContent).not.toContain("Usage overview");
    expect(container.textContent).toContain("Activity");
    expect(container.textContent).toContain("last 90 days");
    expect(activityCells.length).toBe(90);
    expect(container.textContent).toContain("Active days");
    expect(container.textContent).toContain("Peak day");
    expect(container.textContent).toContain("Recent turns");
    expect(container.textContent).toContain("Daily total tokens. Darker cells mean more usage.");
    expect(activityCells.find((cell) => cell.getAttribute("aria-label")?.includes("10.5K total tokens"))).toBeDefined();
    expect(container.textContent).toContain("Your most recent turns from the last 30 days.");
    expect(container.textContent).toContain("Launch planning");
    expect(container.textContent).toContain("private chat");
    expect(container.textContent).toContain("claude-code/sonnet");
    expect(container.textContent).toContain("46.2K");
    expect(usageMocks.getAgentUsageSummary).toHaveBeenCalledWith("agent-1", "30d");
    expect(usageMocks.getAgentUsageTurns).toHaveBeenCalledWith("agent-1", {
      window: "30d",
      limit: 10,
    });

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Launch planning") ?? null,
    );
    // Opening a chat from Usage goes through the leave guard, not raw navigate.
    expect(contextMock.value?.guardedNavigate).toHaveBeenCalledWith("/?chat=chat-1");

    await act(async () => root.unmount());
  });

  it("renders human, loading, error, and empty states", async () => {
    const { UsageTab } = await import("../usage-tab.js");

    contextMock.value = createContext({ agent: agent({ type: "human", clientId: null }) });
    const human = await renderUsageTab(<UsageTab />);
    expect(human.container.textContent).toContain("only tracked for agent-type accounts");
    expect(usageMocks.getAgentUsageSummary).not.toHaveBeenCalled();
    await act(async () => human.root.unmount());

    contextMock.value = createContext();
    usageMocks.getAgentUsageSummary.mockImplementation(() => new Promise(() => undefined));
    usageMocks.getAgentUsageTurns.mockImplementation(() => new Promise(() => undefined));
    const loading = await renderUsageTab(<UsageTab />);
    expect(loading.container.textContent).toContain("Loading activity");
    expect(loading.container.textContent).toContain("Loading recent turns");
    await act(async () => loading.root.unmount());

    usageMocks.getAgentUsageSummary.mockRejectedValue(new Error("summary failed"));
    usageMocks.getAgentUsageTurns.mockRejectedValue(new Error("turns failed"));
    const errored = await renderUsageTab(<UsageTab />);
    expect(errored.container.textContent).toContain("Failed to load activity.");
    expect(errored.container.textContent).toContain("Failed to load recent turns.");
    await act(async () => errored.root.unmount());

    usageMocks.getAgentUsageSummary.mockResolvedValue(
      summary({
        totals: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          turns: 0,
          chats: 0,
          lastUsageAt: null,
        },
        daily: [],
      }),
    );
    usageMocks.getAgentUsageTurns.mockResolvedValue(turnsResponse({ rows: [], nextCursor: null }));
    const empty = await renderUsageTab(<UsageTab />);
    expect(empty.container.textContent).toContain("No turns recorded in the last 30 days.");
    expect(empty.container.textContent).not.toContain("Input 0");
    await act(async () => empty.root.unmount());
  });
});
