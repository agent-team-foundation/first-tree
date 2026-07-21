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

  it("keeps the compact row concise and expands the existing full narration inline", async () => {
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
    });
    expect(h.container.textContent).not.toContain("Bash");
    expect(h.container.textContent).not.toContain("Cover the status rail.");
    expect(h.container.textContent).not.toContain("Activity");

    const trigger = h.container.querySelector('button[aria-label^="Expand current agent output"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Expand current agent output, 1 actionable agent, Nova, Working");
    const liveStatus = h.container.querySelector('[role="status"]');
    expect(liveStatus?.textContent).toContain("1 actionable agent");
    expect(liveStatus?.textContent).toContain("Nova Working");
    expect(liveStatus?.textContent).not.toContain("Bash");
    expect(liveStatus?.textContent).not.toContain("Write extra DOM tests");

    await click(h, trigger);
    await waitForSettled(h, () => {
      expect(h.container.querySelector('section[aria-label="Current agent output"]')).not.toBeNull();
      expect(h.container.textContent).toContain("Cover the status rail.");
    });
    expect(h.container.querySelector('section[aria-label="Current agent output"]')?.getAttribute("tabindex")).toBe("0");
    expect(h.container.textContent).not.toContain("Bash");
    expect(h.container.textContent).not.toContain("doc-page.tsx");
    expect(trigger?.textContent).not.toContain("Write extra DOM tests");
    expect(trigger?.querySelector(".compose-status-state-expanded")?.textContent).toContain("Working");
    expect(trigger?.getAttribute("aria-label")).toBe(
      "Collapse current agent output, 1 actionable agent, Nova, Working",
    );
    expect(h.container.querySelector("[data-current-output-identity]")).toBeNull();
    expect(h.container.querySelector("[data-current-agent-output]")?.textContent).not.toContain("Nova");
    expect(h.container.querySelector("[data-current-agent-output]")?.textContent).not.toContain("Working");
    expect(h.container.querySelector(".compose-status-narration strong")?.textContent).toBe("extra");

    await click(h, trigger);
    await waitForSettled(h, () =>
      expect(h.container.querySelector('section[aria-label="Current agent output"]')).toBeNull(),
    );
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

    const trigger = h.container.querySelector('button[aria-label^="Expand current agent output"]');
    await click(h, trigger);
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Offline Agent"));
    expect(h.container.textContent).toContain("Offline");
    expect(trigger?.textContent).toContain("2 status updates");
    expect(trigger?.textContent).not.toContain("failed");
  });

  it("shows a current reason in the compact row and its detail inline", async () => {
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
    const trigger = h.container.querySelector('button[aria-label^="Expand current agent output"]');
    expect(trigger?.getAttribute("aria-label")).toContain("Beacon, Idle, Waiting for provider capacity");
    await click(h, trigger);
    await waitForSettled(h, () => expect(h.container.querySelector('[title="capacity queue"]')).not.toBeNull());
    expect(trigger?.getAttribute("aria-label")).toContain("Beacon, Idle, Waiting for provider capacity");
    expect(h.container.querySelector('[title="capacity queue"]')).not.toBeNull();
    expect(h.container.querySelector('.compose-status-jump[aria-label*="timeline"]')).toBeNull();
  });

  it("opens all agents in one lightly divided inline region without duplicating the lead", async () => {
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
        <>
          <div data-error-agent="agent-atlas" />
          <div data-working-agent="agent-nova" />
          <ComposeStatusBar chatId="chat-1" agents={[agent("agent-atlas", "Atlas"), agent("agent-nova", "Nova")]} />
        </>,
      ),
    );

    await waitForSettled(h, () => {
      expect(h.container.querySelector(".compose-status-agent-name")?.textContent).toBe("Atlas");
    });

    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Nova"));

    const inspector = h.container.querySelector("[data-current-agent-output]");
    const atlasCount = inspector?.textContent?.match(/Atlas/g)?.length ?? 0;
    expect(atlasCount).toBe(1);
    expect(h.container.querySelector('button[aria-label^="Collapse current agent output"]')?.textContent).toContain(
      "2 agents",
    );
    expect(h.container.querySelector('button[aria-label^="Collapse current agent output"]')?.textContent).toContain(
      "1 failed",
    );
    expect(
      h.container.querySelector('button[aria-label^="Collapse current agent output"]')?.getAttribute("aria-label"),
    ).toContain("1 failed");
    expect(h.container.querySelector('button[aria-label^="Collapse current agent output"]')?.textContent).not.toContain(
      "Atlas",
    );
    expect(h.container.querySelectorAll("[data-current-agent-output]")).toHaveLength(1);
    expect(h.container.querySelectorAll("[data-current-output-agent]")).toHaveLength(2);
    expect(h.container.querySelectorAll("[data-current-output-identity]")).toHaveLength(2);
    expect(h.container.querySelectorAll(".compose-status-narration-with-jump")).toHaveLength(2);
  });

  it("keeps a quiet timeline jump inside the expanded output", async () => {
    const fullNarration = `Run the focused suite\n\n${"Detailed result. ".repeat(110)}`;
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Run the focused suite", turnTextFull: fullNarration }),
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

    await waitForSettled(h, () => expect(h.container.querySelector("[data-compose-status-bar]")).not.toBeNull());
    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    await waitForSettled(h, () =>
      expect(h.container.querySelector('.compose-status-jump[aria-label*="Nova"]')).not.toBeNull(),
    );
    const jump = h.container.querySelector<HTMLButtonElement>('.compose-status-jump[aria-label*="Nova"]');
    if (!jump) throw new Error("Expected timeline jump");
    expect(jump?.getAttribute("aria-label")).toBe("View Nova in the timeline");
    expect(jump?.getAttribute("aria-label")).not.toContain(fullNarration);

    await click(h, jump);

    expect(timelineMocks.scrollToAgentTimeline).toHaveBeenCalledWith("agent-nova", "working", { focus: true });
    expect(h.container.querySelector("[data-current-agent-output]")).not.toBeNull();
  });

  it("places inline output after its trigger and keeps focus on the disclosure", async () => {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([
      status("agent-nova", {
        working: true,
        engagement: "active",
        activity: activity("agent-nova", { turnText: "Check keyboard focus" }),
      }),
    ]);

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />));
    await waitForSettled(h, () => expect(h.container.querySelector("[data-compose-status-bar]")).not.toBeNull());

    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Expand current agent output"]');
    trigger?.focus();
    await click(h, trigger);
    const inspector = h.container.querySelector<HTMLElement>("[data-current-agent-output]");
    expect(inspector).not.toBeNull();
    const domPosition = trigger?.compareDocumentPosition(inspector ?? document.body) ?? 0;
    expect(domPosition & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(document.activeElement).toBe(trigger);

    await click(h, trigger);
    expect(h.container.querySelector("[data-current-agent-output]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves Escape to a later focused keyboard layer outside the inline output", async () => {
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
    await waitForSettled(h, () => expect(h.container.querySelector("[data-compose-status-bar]")).not.toBeNull());
    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    const laterLayer = h.container.querySelector<HTMLInputElement>('input[aria-label="Mention autocomplete"]');
    if (!laterLayer) throw new Error("Expected later keyboard layer");
    laterLayer.focus();

    await keyDown(h, laterLayer, "Escape");

    expect(externalEscape).toHaveBeenCalledTimes(1);
    expect(h.container.querySelector("[data-current-agent-output]")).not.toBeNull();
    expect(document.activeElement).toBe(laterLayer);
  });

  it("does not steal focus after a pointer leaves the status surface", async () => {
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

    await waitForSettled(h, () => expect(h.container.querySelector("[data-compose-status-bar]")).not.toBeNull());
    const trigger = h.container.querySelector<HTMLButtonElement>('button[aria-label^="Expand current agent output"]');
    trigger?.focus();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      queryClient.setQueryData(["chat-agent-status", "chat-1"], []);
    });
    await h.flush();

    await waitForSettled(h, () => expect(h.container.querySelector("[data-compose-status-bar]")).toBeNull());
    expect(document.activeElement).not.toBe(fallbackRef.current);
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
    await waitForSettled(h, () => expect(h.container.querySelector("[data-compose-status-bar]")).not.toBeNull());
    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    const row = h.container.querySelector('.compose-status-jump[aria-label="View Terminal Agent in the timeline"]');
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
    await waitForSettled(h, () => expect(h.container.textContent).toContain("3 agents"));
    const trigger = h.container.querySelector('button[aria-label^="Expand current agent output"]');
    await click(h, trigger);
    expect(trigger?.textContent).toContain("3 status updates");
    expect(trigger?.getAttribute("aria-label")).toContain("3 status updates");
    expect(trigger?.textContent).not.toContain("needs attention");

    for (const [agentId, name] of [
      ["agent-waiting", "Waiting Agent"],
      ["agent-retrying", "Retrying Agent"],
      ["agent-warning", "Warning Agent"],
    ]) {
      await click(h, h.container.querySelector(`.compose-status-jump[aria-label*="${name}"][aria-label*="timeline"]`));
      expect(timelineMocks.scrollToAgentTimeline).toHaveBeenLastCalledWith(agentId, "reason", { focus: true });
    }
  });

  it("recovers focus from live-updating output, then returns it to the composer fallback", async () => {
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

    await waitForSettled(h, () => expect(h.container.textContent).toContain("2 agents"));
    const trigger = h.container.querySelector('button[aria-label^="Expand current agent output"]');
    await click(h, trigger);
    const novaRow = h.container.querySelector<HTMLButtonElement>('.compose-status-jump[aria-label*="Nova"]');
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
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Collapse current agent output, 1 actionable agent, Atlas, Working",
      ),
    );

    const atlasRow = h.container.querySelector<HTMLButtonElement>('.compose-status-jump[aria-label*="Atlas"]');
    if (!atlasRow) throw new Error("Expected Atlas timeline jump");
    atlasRow.focus();
    expect(document.activeElement).toBe(atlasRow);
    await act(async () => {
      queryClient.setQueryData(["chat-agent-status", "chat-1"], []);
    });
    await h.flush();
    await waitForSettled(h, () => expect(document.activeElement).toBe(fallbackRef.current));
    expect(h.container.querySelector("[data-compose-status-bar]")).toBeNull();
  });

  it("keeps a focused surviving timeline jump mounted when a group becomes one agent", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(
      ["chat-agent-status", "chat-1"],
      [
        status("agent-nova", { working: true, engagement: "active", activity: activity("agent-nova") }),
        status("agent-atlas", { working: true, engagement: "active", activity: activity("agent-atlas") }),
      ],
    );

    h.render(
      withProviders(
        <>
          <div data-working-agent="agent-nova" />
          <div data-working-agent="agent-atlas" />
          <ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova"), agent("agent-atlas", "Atlas")]} />
        </>,
        queryClient,
      ),
    );

    await waitForSettled(h, () => expect(h.container.textContent).toContain("2 agents"));
    const trigger = h.container.querySelector('button[aria-label^="Expand current agent output"]');
    await click(h, trigger);
    const atlasJump = h.container.querySelector<HTMLButtonElement>('.compose-status-jump[aria-label*="Atlas"]');
    if (!atlasJump) throw new Error("Expected Atlas timeline jump");
    atlasJump.focus();

    await act(async () => {
      queryClient.setQueryData(
        ["chat-agent-status", "chat-1"],
        [status("agent-atlas", { working: true, engagement: "active", activity: activity("agent-atlas") })],
      );
    });
    await h.flush();

    await waitForSettled(h, () =>
      expect(trigger?.getAttribute("aria-label")).toBe(
        "Collapse current agent output, 1 actionable agent, Atlas, Working",
      ),
    );
    expect(h.container.querySelector('.compose-status-jump[aria-label*="Atlas"]')).toBe(atlasJump);
    expect(document.activeElement).toBe(atlasJump);
    expect(h.container.querySelector("[data-current-output-identity]")).toBeNull();
  });

  it("keeps focus on a surviving Markdown link without a timeline anchor during a status update", async () => {
    const queryClient = createQueryClient();
    const linkedActivity = activity("agent-nova", {
      label: "Drafting",
      turnText: "Review the [implementation notes](https://example.com/notes).",
    });
    queryClient.setQueryData(
      ["chat-agent-status", "chat-1"],
      [status("agent-nova", { working: true, engagement: "active", activity: linkedActivity })],
    );

    h.render(withProviders(<ComposeStatusBar chatId="chat-1" agents={[agent("agent-nova", "Nova")]} />, queryClient));

    await waitForSettled(h, () => expect(h.container.querySelector("[data-compose-status-bar]")).not.toBeNull());
    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    const link = h.container.querySelector<HTMLAnchorElement>(
      '.compose-status-narration a[href="https://example.com/notes"]',
    );
    if (!link) throw new Error("Expected Markdown link");
    expect(h.container.querySelector(".compose-status-jump")).toBeNull();
    link.focus();

    await act(async () => {
      queryClient.setQueryData(
        ["chat-agent-status", "chat-1"],
        [
          status("agent-nova", {
            working: true,
            engagement: "active",
            activity: { ...linkedActivity, detail: "Refreshing status" },
          }),
        ],
      );
    });
    await h.flush();

    expect(document.activeElement).toBe(link);
  });

  it("moves focus to the disclosure when a focused jump loses its timeline anchor", async () => {
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
    await waitForSettled(h, () => expect(h.container.querySelector("[data-compose-status-bar]")).not.toBeNull());
    await click(h, h.container.querySelector('button[aria-label^="Expand current agent output"]'));
    const row = h.container.querySelector<HTMLButtonElement>('.compose-status-jump[aria-label*="Nova"]');
    row?.focus();
    expect(document.activeElement).toBe(row);

    await act(async () => hideAnchor?.());
    await h.flush();

    await waitForSettled(h, () =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Collapse current agent output, 1 actionable agent, Nova, Working",
      ),
    );
    expect(h.container.querySelector('.compose-status-jump[aria-label*="Nova"]')).toBeNull();
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
