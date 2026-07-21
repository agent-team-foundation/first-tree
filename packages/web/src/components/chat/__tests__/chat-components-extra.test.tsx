// @vitest-environment happy-dom

import {
  type AgentChatStatus,
  type AgentChatStatusInput,
  buildAgentChatStatus,
  type ChatParticipantDetail,
  type LiveActivity,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createRef, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";

const agentStatusApiMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

const sessionApiMocks = vi.hoisted(() => ({
  listChatCurrentTurnNarrations: vi.fn(),
  suspendSession: vi.fn(),
  resumeSession: vi.fn(),
}));

vi.mock("../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId] as const,
  fetchChatAgentStatuses: agentStatusApiMocks.fetchChatAgentStatuses,
}));

vi.mock("../../../api/sessions.js", () => ({
  chatCurrentTurnNarrationsQueryKey: (chatId: string) => ["chat-current-turn-narrations", chatId] as const,
  listChatCurrentTurnNarrations: sessionApiMocks.listChatCurrentTurnNarrations,
  suspendSession: sessionApiMocks.suspendSession,
  resumeSession: sessionApiMocks.resumeSession,
}));

import { AgentStatusPanel } from "../agent-status-panel.js";
import { ComposeStatusBar } from "../compose-status-bar.js";

const BASE_STATUS: Omit<AgentChatStatusInput, "agentId"> = {
  reachable: true,
  errored: false,
  working: false,
  engagement: "none",
};

function status(agentId: string, overrides: Partial<AgentChatStatusInput> = {}): AgentChatStatus {
  return buildAgentChatStatus({
    ...BASE_STATUS,
    agentId,
    ...overrides,
  });
}

function activity(agentId: string, overrides: Partial<LiveActivity> = {}): LiveActivity {
  return {
    agentId,
    kind: "tool_call",
    label: "Bash",
    detail: "packages/web/src/pages/docs/doc-page.tsx",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function agent(agentId: string, displayName: string): ChatParticipantDetail {
  return {
    agentId,
    role: "speaker",
    mode: "participant",
    joinedAt: "2026-07-04T12:00:00.000Z",
    displayName,
    name: displayName.toLowerCase().replace(/\s+/g, "-"),
    type: "agent",
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } },
  });
}

function withProviders(ui: ReactElement, queryClient = createQueryClient()): ReactElement {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
}

async function waitForSettled(h: DomHarness, assertion: () => void): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 50; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await h.flush();
  }
  throw lastErr;
}

async function click(h: DomHarness, element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await h.flush();
}

async function keyDown(h: DomHarness, target: EventTarget, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await h.flush();
}

class ResizeObserverMock {
  observe(): void {}
  disconnect(): void {}
}

describe("ComposeStatusBar extra DOM coverage", () => {
  let h: DomHarness;

  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    sessionApiMocks.listChatCurrentTurnNarrations.mockResolvedValue([]);
  });

  afterEach(() => {
    h.cleanup();
    vi.unstubAllGlobals();
  });

  it("stays hidden when every status is quiet", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([status("agent-ready", { engagement: "active" })]);

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-ready", "Ready Agent")]} />));

    await waitForSettled(h, () => expect(agentStatusApiMocks.fetchChatAgentStatuses).toHaveBeenCalledWith("chat-1"));
    expect(h.container.querySelector("[data-compose-status-bar]")).toBeNull();
    expect(h.container.querySelector('[role="status"]')?.textContent).toContain("0 agent updates");
  });

  it("does not infer working from residual timeline markup", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([status("agent-ready", { engagement: "active" })]);

    h.render(
      withProviders(
        <>
          <div data-working-agent="agent-ready" />
          <ComposeStatusBar chatId="chat-1" agents={[agent("agent-ready", "Ready Agent")]} />
        </>,
      ),
    );

    await waitForSettled(h, () => expect(agentStatusApiMocks.fetchChatAgentStatuses).toHaveBeenCalledWith("chat-1"));
    expect(h.container.querySelector("[data-compose-status-bar]")).toBeNull();
  });

  it("keeps one live region mounted across quiet and active transitions", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(["chat-agent-status", "chat-1"], []);

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />, queryClient));
    const liveStatus = h.container.querySelector<HTMLElement>('[role="status"]');
    expect(liveStatus?.textContent).toContain("0 agent updates");

    await act(async () => {
      queryClient.setQueryData(
        ["chat-agent-status", "chat-1"],
        [status("agent-nova", { working: true, engagement: "active", activity: activity("agent-nova") })],
      );
    });
    await h.flush();
    await waitForSettled(h, () => expect(liveStatus?.textContent).toContain("1 agent update"));
    expect(h.container.querySelector('[role="status"]')).toBe(liveStatus);

    await act(async () => {
      queryClient.setQueryData(["chat-agent-status", "chat-1"], []);
    });
    await h.flush();
    await waitForSettled(h, () => expect(liveStatus?.textContent).toContain("0 agent updates"));
  });

  it("opens complete current-turn Markdown inline and hides redundant tool metadata", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Write **focused** DOM tests" }),
      }),
    ]);
    sessionApiMocks.listChatCurrentTurnNarrations.mockResolvedValue([
      {
        agentId: "agent-nova",
        afterSeq: 12,
        latestSeq: 16,
        text: "Write **focused** DOM tests\n\n- [keep every line](https://example.com)\n- remove tool duplication",
      },
    ]);

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />));

    await waitForSettled(h, () => expect(h.container.textContent).toContain("Write focused DOM tests"));
    expect(h.container.textContent).not.toContain("Activity");
    expect(h.container.textContent).not.toContain("Bash");

    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Expand current agent output"]');
    expect(trigger?.getAttribute("aria-label")).toContain("Nova Working");
    expect(trigger?.getAttribute("aria-label")).toContain("Write focused DOM tests");
    await click(h, trigger);
    await waitForSettled(h, () => expect(h.container.textContent).toContain("remove tool duplication"));

    const detail = h.container.querySelector('section[aria-label="Current agent output"]');
    expect(detail).not.toBeNull();
    expect(detail?.querySelector("strong")?.textContent).toBe("focused");
    expect(detail?.textContent).not.toContain("Bash");
    expect(sessionApiMocks.listChatCurrentTurnNarrations).toHaveBeenCalledWith("chat-1");

    const detailLink = detail?.querySelector<HTMLAnchorElement>("a");
    detailLink?.focus();
    if (!detailLink) throw new Error("Expected narration link");
    await keyDown(h, detailLink, "Escape");
    expect(h.container.querySelector(".compose-status-detail")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses the current tool only when the turn has no narration", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova"),
      }),
    ]);

    const queryClient = createQueryClient();
    queryClient.setQueryData(["chat-current-turn-narrations", "chat-1"], []);
    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />, queryClient));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Bash · doc-page.tsx"));
    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    await waitForSettled(h, () =>
      expect(h.container.querySelector(".compose-status-detail")?.textContent).toContain("Bash · doc-page.tsx"),
    );
  });

  it("keeps provider reasons visible in compact and expanded states", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-waiting", {
        statusReason: {
          kind: "waiting",
          severity: "warning",
          provider: "codex",
          scope: "session_resume",
          category: "provider_capacity",
          reasonCode: "provider_rate_limited",
          label: "Waiting for provider capacity",
          detail: "capacity queue",
        },
      }),
    ]);

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-waiting", "Beacon")]} />));

    await waitForSettled(h, () => expect(h.container.textContent).toContain("Waiting for provider capacity"));
    expect(h.container.querySelector(".compose-status-state")?.textContent).toContain("Waiting");
    expect(h.container.querySelector(".compose-status-state")?.textContent).not.toContain("Idle");
    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Expand current agent output"]');
    expect(trigger?.getAttribute("aria-label")).toContain("Beacon Waiting");
    await click(h, trigger);
    await waitForSettled(h, () => expect(h.container.textContent).toContain("capacity queue"));
    expect(h.container.querySelector(".compose-status-agent")?.textContent).not.toContain("Idle");
    expect(h.container.textContent).not.toContain("Activity");
  });

  it("uses retrying and terminal reason states instead of contradictory Idle labels", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-retrying", {
        statusReason: {
          kind: "retrying",
          severity: "info",
          provider: "codex",
          scope: "provider_turn",
          category: "transient_transport",
          reasonCode: "provider_transient_transport",
          label: "Retrying provider",
        },
      }),
      status("agent-terminal", {
        statusReason: {
          kind: "terminal",
          severity: "error",
          provider: "codex",
          scope: "provider_turn",
          category: "unknown",
          reasonCode: "unknown_exhausted",
          label: "Provider retry exhausted",
        },
      }),
    ]);

    h.render(
      withProviders(
        <ComposeStatusBar
          chatId="chat-1"
          agents={[agent("agent-retrying", "Relay"), agent("agent-terminal", "Beacon")]}
        />,
      ),
    );

    await waitForSettled(h, () => expect(h.container.textContent).toContain("Provider retry exhausted"));
    expect(h.container.querySelector(".compose-status-state")?.textContent).toContain("Failed");
    expect(h.container.textContent).not.toContain("Idle");
    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Retrying provider"));
    expect(h.container.textContent).toContain("Retrying");
    expect(h.container.textContent).not.toContain("Idle");
  });

  it("prioritizes failure and lists every active agent in one inline region", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-atlas", { errored: true }),
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Run the focused suite" }),
      }),
    ]);
    sessionApiMocks.listChatCurrentTurnNarrations.mockResolvedValue([
      { agentId: "agent-nova", afterSeq: 2, latestSeq: 4, text: "Run the focused suite" },
    ]);

    h.render(
      withProviders(
        <ComposeStatusBar chatId="chat-1" agents={[agent("agent-atlas", "Atlas"), agent("agent-nova", "Nova")]} />,
      ),
    );

    await waitForSettled(h, () => {
      expect(h.container.querySelector(".compose-status-agent-name")?.textContent).toBe("Atlas");
      expect(h.container.textContent).toContain("1 more");
    });
    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Expand current agent output"]');
    expect(trigger?.getAttribute("aria-label")).toContain("1 more agent updates");
    await click(h, trigger);
    await waitForSettled(h, () => expect(h.container.querySelectorAll(".compose-status-agent")).toHaveLength(2));
    expect(h.container.querySelectorAll('section[aria-label="Current agent output"]')).toHaveLength(1);
  });

  it("collapses on Escape without moving focus away from the toggle", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Check keyboard focus" }),
      }),
    ]);

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Check keyboard focus"));
    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Expand current agent output"]');
    trigger?.focus();
    await click(h, trigger);
    await waitForSettled(h, () =>
      expect(trigger?.getAttribute("aria-label")).toMatch(/^Collapse current agent output/),
    );

    if (!trigger) throw new Error("Expected connected status toggle");
    await keyDown(h, trigger, "Escape");
    expect(h.container.querySelector(".compose-status-detail")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the toggle when Escape collapses a load error", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Load the complete response" }),
      }),
    ]);
    sessionApiMocks.listChatCurrentTurnNarrations.mockRejectedValue(new Error("offline"));

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Load the complete response"));
    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Expand current agent output"]');
    await click(h, trigger);
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Couldn't load current output"));
    const retry = h.container.querySelector<HTMLButtonElement>(".compose-status-load-error button");
    retry?.focus();
    if (!trigger || !retry) throw new Error("Expected connected status error controls");

    await keyDown(h, retry, "Escape");

    expect(h.container.querySelector(".compose-status-detail")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves Escape to a focused layer outside the connected status", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Check layered keyboard handling" }),
      }),
    ]);
    const externalEscape = vi.fn();

    h.render(
      withProviders(
        <>
          <ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />
          <input
            aria-label="Mention autocomplete"
            onKeyDown={(event) => {
              if (event.key === "Escape") externalEscape();
            }}
          />
        </>,
      ),
    );
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Check layered keyboard handling"));
    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    const laterLayer = h.container.querySelector<HTMLInputElement>('input[aria-label="Mention autocomplete"]');
    if (!laterLayer) throw new Error("Expected later keyboard layer");
    laterLayer.focus();

    await keyDown(h, laterLayer, "Escape");

    expect(externalEscape).toHaveBeenCalledTimes(1);
    expect(h.container.querySelector(".compose-status-detail")).not.toBeNull();
  });

  it("returns focus to the composer when the last active status disappears", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      ["chat-agent-status", "chat-1"],
      [status("agent-nova", { working: true, engagement: "active", activity: activity("agent-nova") })],
    );
    const fallbackRef = createRef<HTMLButtonElement>();

    h.render(
      withProviders(
        <>
          <ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} fallbackFocusRef={fallbackRef} />
          <button ref={fallbackRef} type="button">
            Composer fallback
          </button>
        </>,
        queryClient,
      ),
    );

    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Expand current agent output"]');
    trigger?.focus();
    await act(async () => {
      queryClient.setQueryData(["chat-agent-status", "chat-1"], []);
    });
    await h.flush();

    await waitForSettled(h, () => expect(document.activeElement).toBe(fallbackRef.current));
    expect(h.container.querySelector("[data-compose-status-bar]")).toBeNull();
  });
});
describe("AgentStatusPanel extra DOM coverage", () => {
  let h: DomHarness;

  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    sessionApiMocks.suspendSession.mockResolvedValue({
      agentId: "agent-nova",
      chatId: "chat-1",
      state: "suspended",
      transitioned: true,
    });
    sessionApiMocks.resumeSession.mockResolvedValue({
      agentId: "agent-paused",
      chatId: "chat-1",
      state: "active",
      transitioned: true,
    });
  });

  afterEach(() => {
    h.cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a server-ready row Idle and does not offer Pause for residual timeline evidence", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([status("agent-nova", { engagement: "active" })]);

    h.render(
      withProviders(
        <>
          <div data-working-agent="agent-nova" />
          <AgentStatusPanel chatId="chat-1" agents={[agent("agent-nova", "Nova")]} canManage={() => true} compact />
        </>,
      ),
    );

    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("Nova");
      expect(h.container.textContent).toContain("Idle");
    });
    expect(h.container.querySelector('button[aria-label="Pause agent"]')).toBeNull();
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();
  });

  it("keeps working and failed roster statuses static and omits activity detail", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-worker", {
        working: true,
        engagement: "active",
        activity: activity("agent-worker", { label: "Bash" }),
      }),
      status("agent-failed", { errored: true }),
    ]);

    h.render(
      withProviders(
        <AgentStatusPanel
          chatId="chat-1"
          agents={[agent("agent-worker", "Worker Agent"), agent("agent-failed", "Failed Agent")]}
          canManage={() => false}
        />,
      ),
    );

    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("Working");
      expect(h.container.textContent).toContain("Failed");
    });
    expect(h.container.textContent).not.toContain("Bash");
    expect(h.container.querySelector('button[aria-label^="Jump to this agent"]')).toBeNull();
  });

  it("renders missing statuses as empty, and resumes suspended rows", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([status("agent-paused", { engagement: "suspended" })]);

    h.render(
      withProviders(
        <AgentStatusPanel
          chatId="chat-1"
          agents={[agent("agent-paused", "Paused Agent"), agent("agent-missing", "Missing Agent")]}
          canManage={() => true}
        />,
      ),
    );

    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("Paused Agent");
      expect(h.container.textContent).toContain("Missing Agent");
      expect(h.container.textContent).toContain("\u2026");
      expect(h.container.querySelector('button[aria-label="Resume agent"]')).not.toBeNull();
    });

    expect(h.container.querySelector('button[aria-label="Pause agent"]')).toBeNull();
    await click(h, h.container.querySelector('button[aria-label="Resume agent"]'));
    await waitForSettled(h, () => expect(sessionApiMocks.resumeSession).toHaveBeenCalledWith("agent-paused", "chat-1"));
  });

  it("sorts priority rows by attention before the original agent order", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-idle", { engagement: "active" }),
      status("agent-worker", {
        working: true,
        engagement: "active",
        activity: activity("agent-worker", { label: "Read", detail: "packages/web/src/app.tsx" }),
      }),
      status("agent-failed", { errored: true }),
    ]);

    h.render(
      withProviders(
        <AgentStatusPanel
          chatId="chat-1"
          agents={[
            agent("agent-idle", "Idle Agent"),
            agent("agent-worker", "Worker Agent"),
            agent("agent-failed", "Failed Agent"),
          ]}
          canManage={() => false}
          order="priority"
        />,
      ),
    );

    await waitForSettled(h, () => {
      const text = h.container.textContent ?? "";
      expect(text.indexOf("Failed Agent")).toBeLessThan(text.indexOf("Worker Agent"));
      expect(text.indexOf("Worker Agent")).toBeLessThan(text.indexOf("Idle Agent"));
    });
    const text = h.container.textContent ?? "";
    expect(text.indexOf("Failed Agent")).toBeLessThan(text.indexOf("Worker Agent"));
    expect(text.indexOf("Worker Agent")).toBeLessThan(text.indexOf("Idle Agent"));
  });
});
