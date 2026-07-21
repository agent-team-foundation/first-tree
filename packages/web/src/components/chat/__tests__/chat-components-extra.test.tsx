// @vitest-environment happy-dom

import {
  type AgentChatStatus,
  type AgentChatStatusInput,
  buildAgentChatStatus,
  type ChatParticipantDetail,
  type LiveActivity,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createRef, type ReactElement, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";

const agentStatusApiMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

const sessionApiMocks = vi.hoisted(() => ({
  suspendSession: vi.fn(),
  resumeSession: vi.fn(),
}));

const timelineMocks = vi.hoisted(() => ({
  scrollToAgentTimeline: vi.fn(),
}));

vi.mock("../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId] as const,
  fetchChatAgentStatuses: agentStatusApiMocks.fetchChatAgentStatuses,
}));

vi.mock("../../../api/sessions.js", () => ({
  suspendSession: sessionApiMocks.suspendSession,
  resumeSession: sessionApiMocks.resumeSession,
}));

vi.mock("../../../lib/scroll-to-agent-timeline.js", () => timelineMocks);

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
    expect(h.container.querySelector('[role="status"]')?.textContent).toContain("0 actionable agents");
  });

  it("does not infer working from a residual mounted timeline turn", async () => {
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
    expect(liveStatus?.textContent).toContain("0 actionable agents");

    await act(async () => {
      queryClient.setQueryData(
        ["chat-agent-status", "chat-1"],
        [status("agent-nova", { working: true, engagement: "active", activity: activity("agent-nova") })],
      );
    });
    await h.flush();
    await waitForSettled(h, () => expect(liveStatus?.textContent).toContain("1 actionable agent"));
    expect(h.container.querySelector('[role="status"]')).toBe(liveStatus);

    await act(async () => {
      queryClient.setQueryData(["chat-agent-status", "chat-1"], []);
    });
    await h.flush();
    await waitForSettled(h, () => expect(liveStatus?.textContent).toContain("0 actionable agents"));
    expect(h.container.querySelector('[role="status"]')).toBe(liveStatus);
  });

  it("keeps the collapsed snapshot concise and opens one live activity inspector", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", {
          turnText: "Write **extra** DOM tests",
          turnTextFull: "Write **extra** DOM tests\n\nCover the status rail.",
        }),
      }),
    ]);

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />));

    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("Nova");
      expect(h.container.textContent).toContain("Working");
      expect(h.container.textContent).toContain("Write extra DOM tests");
      expect(h.container.textContent).toContain("Activity (1)");
    });
    expect(h.container.textContent).not.toContain("Bash");
    expect(h.container.textContent).not.toContain("Cover the status rail.");

    const trigger = h.container.querySelector('button[aria-label^="Open agent activity"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Open agent activity, 1 actionable agent");
    const liveStatus = h.container.querySelector('[role="status"]');
    expect(liveStatus?.textContent).toContain("1 actionable agent");
    expect(liveStatus?.textContent).toContain("Nova Working");
    expect(liveStatus?.textContent).not.toContain("Bash");
    expect(liveStatus?.textContent).not.toContain("Write extra DOM tests");

    await click(h, trigger);
    await waitForSettled(h, () => {
      expect(h.container.querySelector('section[aria-label="Agent activity"]')).not.toBeNull();
      expect(h.container.textContent).toContain("Agent activity · 1 agent");
      expect(h.container.textContent).toContain("Bash");
      expect(h.container.textContent).toContain("doc-page.tsx");
    });
    // `turnTextFull` is timeline evidence, not duplicated into the live snapshot.
    expect(h.container.textContent).not.toContain("Cover the status rail.");

    const focusedControl = document.activeElement;
    if (!(focusedControl instanceof HTMLElement)) throw new Error("Expected a focused Inspector control");
    await keyDown(h, focusedControl, "Escape");
    await waitForSettled(h, () => expect(h.container.querySelector('section[aria-label="Agent activity"]')).toBeNull());
  });

  it("keeps the server-derived main state while presenting status reasons as explanation", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
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
      status("agent-offline", {
        reachable: false,
        statusReason: {
          kind: "waiting",
          severity: "warning",
          provider: "codex",
          scope: "session_resume",
          category: "provider_capacity",
          reasonCode: "provider_rate_limited",
          label: "Waiting for provider capacity",
        },
      }),
    ]);

    h.render(
      withProviders(
        <ComposeStatusBar
          chatId="chat-1"
          agents={[agent("agent-terminal", "Terminal Agent"), agent("agent-offline", "Offline Agent")]}
        />,
      ),
    );

    await waitForSettled(h, () => expect(h.container.textContent).toContain("Provider retry exhausted"));
    expect(h.container.textContent).toContain("Idle");
    expect(h.container.textContent).not.toContain("Failed");

    await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Offline Agent"));
    expect(h.container.textContent).toContain("Offline");
  });

  it("shows a current reason in the strip and its detail inside the inspector", async () => {
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
    expect(h.container.textContent).toContain("Waiting");
    await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
    await waitForSettled(h, () => expect(h.container.querySelector('[title="capacity queue"]')).not.toBeNull());
    expect(h.container.querySelector('[title="capacity queue"]')).not.toBeNull();
    expect(h.container.querySelector('button[aria-label*="timeline"]')).toBeNull();
  });

  it("opens all agents in one lightly divided inspector without duplicating the lead", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-atlas", { errored: true }),
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Run the focused suite" }),
      }),
    ]);

    h.render(
      withProviders(
        <ComposeStatusBar chatId="chat-1" agents={[agent("agent-atlas", "Atlas"), agent("agent-nova", "Nova")]} />,
      ),
    );

    await waitForSettled(h, () => {
      expect(h.container.querySelector(".compose-status-agent-name")?.textContent).toBe("Atlas");
    });

    await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Nova"));

    const inspector = h.container.querySelector("[data-live-activity-inspector]");
    const atlasCount = inspector?.textContent?.match(/Atlas/g)?.length ?? 0;
    expect(atlasCount).toBe(1);
    expect(h.container.querySelectorAll("[data-live-activity-inspector]")).toHaveLength(1);
    expect(h.container.querySelectorAll("[data-live-activity-agent]")).toHaveLength(2);
  });

  it("makes the whole anchored agent item close the inspector and jump to evidence", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Run the focused suite" }),
      }),
    ]);

    h.render(
      withProviders(
        <>
          <div data-working-agent="agent-nova" />
          <ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />
        </>,
      ),
    );

    await waitForSettled(h, () => expect(h.container.textContent).toContain("Activity (1)"));
    await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
    await waitForSettled(h, () =>
      expect(
        h.container.querySelector('button[aria-label*="Nova"][aria-label*="Run the focused suite"]'),
      ).not.toBeNull(),
    );

    await click(h, h.container.querySelector('button[aria-label*="Nova"][aria-label*="Run the focused suite"]'));

    expect(timelineMocks.scrollToAgentTimeline).toHaveBeenCalledWith("agent-nova", "working", { focus: true });
    expect(h.container.querySelector("[data-live-activity-inspector]")).toBeNull();
  });

  it("places the inspector after its trigger and restores trigger focus on Escape", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Check keyboard focus" }),
      }),
    ]);

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Activity (1)"));

    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Open agent activity"]');
    trigger?.focus();
    await click(h, trigger);
    const inspector = h.container.querySelector<HTMLElement>("[data-live-activity-inspector]");
    expect(inspector).not.toBeNull();
    const domPosition = trigger?.compareDocumentPosition(inspector ?? document.body) ?? 0;
    expect(domPosition & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await waitForSettled(h, () =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Close agent activity"),
    );

    const focusedControl = document.activeElement;
    if (!(focusedControl instanceof HTMLElement)) throw new Error("Expected a focused Inspector control");
    await keyDown(h, focusedControl, "Escape");
    expect(h.container.querySelector("[data-live-activity-inspector]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves Escape to a later focused keyboard layer outside the inspector", async () => {
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
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Activity (1)"));
    await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
    const laterLayer = h.container.querySelector<HTMLInputElement>('input[aria-label="Mention autocomplete"]');
    if (!laterLayer) throw new Error("Expected later keyboard layer");
    laterLayer.focus();

    await keyDown(h, laterLayer, "Escape");

    expect(externalEscape).toHaveBeenCalledTimes(1);
    expect(h.container.querySelector("[data-live-activity-inspector]")).not.toBeNull();
    expect(document.activeElement).toBe(laterLayer);
  });

  it("jumps a ready terminal error to its mounted error evidence", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
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
        <>
          <div data-error-agent="agent-terminal" />
          <ComposeStatusBar chatId="chat-1" agents={[agent("agent-terminal", "Terminal Agent")]} />
        </>,
      ),
    );
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Activity (1)"));
    await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
    const row = h.container.querySelector(
      'button[aria-label*="Terminal Agent"][aria-label*="Provider retry exhausted"]',
    );
    expect(row).not.toBeNull();
    await click(h, row);
    expect(timelineMocks.scrollToAgentTimeline).toHaveBeenCalledWith("agent-terminal", "failed", { focus: true });
  });

  it("jumps waiting, retrying, and terminal-warning summaries to provider evidence", async () => {
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
        },
      }),
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
      status("agent-warning", {
        statusReason: {
          kind: "terminal",
          severity: "warning",
          provider: "codex",
          scope: "provider_turn",
          category: "unknown",
          reasonCode: "provider_warning",
          label: "Provider stopped with warning",
        },
      }),
    ]);

    h.render(
      withProviders(
        <>
          <div data-status-reason-agent="agent-waiting" />
          <div data-status-reason-agent="agent-retrying" />
          <div data-status-reason-agent="agent-warning" />
          <ComposeStatusBar
            chatId="chat-1"
            agents={[
              agent("agent-waiting", "Waiting Agent"),
              agent("agent-retrying", "Retrying Agent"),
              agent("agent-warning", "Warning Agent"),
            ]}
          />
        </>,
      ),
    );
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Activity (3)"));

    for (const [agentId, name] of [
      ["agent-waiting", "Waiting Agent"],
      ["agent-retrying", "Retrying Agent"],
      ["agent-warning", "Warning Agent"],
    ]) {
      await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
      await click(h, h.container.querySelector(`button[aria-label*="${name}"][aria-label*="timeline"]`));
      expect(timelineMocks.scrollToAgentTimeline).toHaveBeenLastCalledWith(agentId, "reason", { focus: true });
    }
  });

  it("keeps focus inside a live-updating inspector, then returns it to the composer fallback", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      ["chat-agent-status", "chat-1"],
      [
        status("agent-nova", { working: true, engagement: "active", activity: activity("agent-nova") }),
        status("agent-atlas", { working: true, engagement: "active", activity: activity("agent-atlas") }),
      ],
    );
    const fallbackRef = createRef<HTMLButtonElement>();

    h.render(
      withProviders(
        <>
          <div data-working-agent="agent-nova" />
          <div data-working-agent="agent-atlas" />
          <ComposeStatusBar
            chatId="chat-1"
            agents={[agent("agent-nova", "Nova"), agent("agent-atlas", "Atlas")]}
            fallbackFocusRef={fallbackRef}
          />
          <button ref={fallbackRef} type="button">
            Composer fallback
          </button>
        </>,
        queryClient,
      ),
    );

    await waitForSettled(h, () => expect(h.container.textContent).toContain("Activity (2)"));
    await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
    const novaRow = h.container.querySelector<HTMLButtonElement>('button[aria-label*="Nova"]');
    novaRow?.focus();
    expect(document.activeElement).toBe(novaRow);

    await act(async () => {
      queryClient.setQueryData(
        ["chat-agent-status", "chat-1"],
        [status("agent-atlas", { working: true, engagement: "active", activity: activity("agent-atlas") })],
      );
    });
    await h.flush();
    await waitForSettled(h, () =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Close agent activity"),
    );

    const atlasRow = h.container.querySelector<HTMLButtonElement>('button[aria-label*="Atlas"]');
    atlasRow?.focus();
    await act(async () => {
      queryClient.setQueryData(["chat-agent-status", "chat-1"], []);
    });
    await h.flush();
    await waitForSettled(h, () => expect(document.activeElement).toBe(fallbackRef.current));
    expect(h.container.querySelector("[data-compose-status-bar]")).toBeNull();
  });

  it("moves focus to Close when a focused row loses only its timeline anchor", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", { working: true, engagement: "active", activity: activity("agent-nova") }),
    ]);
    let hideAnchor: (() => void) | undefined;

    function AnchorHarness() {
      const [showAnchor, setShowAnchor] = useState(true);
      hideAnchor = () => setShowAnchor(false);
      return (
        <>
          {showAnchor ? <div data-working-agent="agent-nova" /> : null}
          <ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />
        </>
      );
    }

    h.render(withProviders(<AnchorHarness />));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Activity (1)"));
    await click(h, h.container.querySelector('button[aria-label^="Open agent activity"]'));
    const row = h.container.querySelector<HTMLButtonElement>('button[aria-label*="Nova"]');
    row?.focus();
    expect(document.activeElement).toBe(row);

    await act(async () => hideAnchor?.());
    await h.flush();

    await waitForSettled(h, () =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Close agent activity"),
    );
    expect(h.container.querySelector('button[aria-label*="Nova"]')).toBeNull();
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
