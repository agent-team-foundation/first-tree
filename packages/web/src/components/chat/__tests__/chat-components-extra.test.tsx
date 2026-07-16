// @vitest-environment happy-dom

import {
  type AgentChatStatus,
  type AgentChatStatusInput,
  buildAgentChatStatus,
  type ChatParticipantDetail,
  type LiveActivity,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
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
import { LiveTurnAgentsContext } from "../live-turn-context.js";

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

function withProviders(ui: ReactElement, liveTurnAgentIds: ReadonlySet<string> = new Set()): ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <LiveTurnAgentsContext.Provider value={liveTurnAgentIds}>{ui}</LiveTurnAgentsContext.Provider>
      </QueryClientProvider>
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
    expect(h.container.textContent).toBe("");
  });

  it("renders a working lead, expands full narration, and closes it on Escape", async () => {
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
      expect(h.container.textContent).toContain("Write extra DOM tests");
      expect(h.container.textContent).toContain("Bash");
      expect(h.container.textContent).toContain("doc-page.tsx");
    });

    await click(h, h.container.querySelector('button[aria-label="Expand full narration"]'));
    await waitForSettled(h, () => {
      expect(h.container.querySelector('section[aria-label*="full narration"]')).not.toBeNull();
      expect(h.container.textContent).toContain("Cover the status rail.");
    });

    await keyDown(h, document, "Escape");
    await waitForSettled(h, () =>
      expect(h.container.querySelector('section[aria-label*="full narration"]')).toBeNull(),
    );
  });

  it("shows status reasons and suppresses the narration expander for reason rows", async () => {
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
    expect(h.container.querySelector('[title="capacity queue"]')).not.toBeNull();
    expect(h.container.querySelector('button[aria-label="Expand full narration"]')).toBeNull();
  });

  it("expands the secondary rows without duplicating the lead row", async () => {
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
      expect(h.container.textContent).toContain("Atlas");
      expect(h.container.textContent).not.toContain("Nova");
    });

    await click(h, h.container.querySelector('button[aria-label="Expand activity"]'));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Nova"));

    const atlasCount = h.container.textContent?.match(/Atlas/g)?.length ?? 0;
    expect(atlasCount).toBe(1);
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

  it("upgrades a ready row with a live turn and offers Pause", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([status("agent-nova", { engagement: "active" })]);

    h.render(
      withProviders(
        <AgentStatusPanel chatId="chat-1" agents={[agent("agent-nova", "Nova")]} canManage={() => true} compact />,
        new Set(["agent-nova"]),
      ),
    );

    await waitForSettled(h, () => {
      expect(h.container.textContent).toContain("Nova");
      expect(h.container.textContent).toContain("Working");
    });

    await click(h, h.container.querySelector('button[aria-label="Pause agent"]'));
    await waitForSettled(h, () => expect(sessionApiMocks.suspendSession).toHaveBeenCalledWith("agent-nova", "chat-1"));
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
        new Set(["agent-worker", "agent-failed"]),
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
