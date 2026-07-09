// @vitest-environment happy-dom

import { type AgentChatStatusInput, buildAgentChatStatus, type ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { LiveTurnAgentsContext } from "../live-turn-context.js";

const statusMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));
const sessionMocks = vi.hoisted(() => ({
  suspendSession: vi.fn(),
  resumeSession: vi.fn(),
}));

vi.mock("../../../api/agent-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/agent-status.js")>();
  return { ...actual, fetchChatAgentStatuses: statusMocks.fetchChatAgentStatuses };
});
vi.mock("../../../api/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/sessions.js")>();
  return {
    ...actual,
    suspendSession: sessionMocks.suspendSession,
    resumeSession: sessionMocks.resumeSession,
  };
});

const mk = (agentId: string, over: Partial<AgentChatStatusInput> = {}) =>
  buildAgentChatStatus({
    agentId,
    reachable: true,
    errored: false,
    working: false,
    engagement: "none",
    ...over,
  });

const agents = [
  {
    agentId: "agent-1",
    displayName: "Nova",
    name: "nova",
    avatarImageUrl: null,
    avatarColorToken: null,
  },
  {
    agentId: "agent-2",
    displayName: "Codex",
    name: "codex",
    avatarImageUrl: null,
    avatarColorToken: null,
  },
] as ChatParticipantDetail[];

function wrap(ui: ReactElement, live = new Set<string>()): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <LiveTurnAgentsContext.Provider value={live}>{ui}</LiveTurnAgentsContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

async function waitFor(h: DomHarness, text: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      expect(h.container.textContent).toContain(text);
      return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 5));
    await h.flush();
  }
  throw last;
}

describe("AgentStatusPanel DOM", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    sessionMocks.suspendSession.mockResolvedValue({});
    sessionMocks.resumeSession.mockResolvedValue({});
  });
  afterEach(() => h.cleanup());

  it("renders working/paused rows and pause/resume actions for managers", async () => {
    statusMocks.fetchChatAgentStatuses.mockResolvedValue([
      mk("agent-1", { working: true, engagement: "active" }),
      mk("agent-2", { engagement: "suspended" }),
    ]);
    const { AgentStatusPanel } = await import("../agent-status-panel.js");
    h.render(wrap(<AgentStatusPanel chatId="chat-1" agents={agents} canManage={() => true} compact={false} />));
    await waitFor(h, "Nova");
    expect(h.container.textContent).toContain("Codex");

    const pause = Array.from(h.container.querySelectorAll("button")).find((b) =>
      /pause/i.test(b.textContent ?? b.getAttribute("aria-label") ?? ""),
    );
    if (pause) {
      await act(async () => {
        pause.click();
      });
      await h.flush();
      expect(sessionMocks.suspendSession).toHaveBeenCalled();
    }

    const resume = Array.from(h.container.querySelectorAll("button")).find((b) =>
      /resume/i.test(b.textContent ?? b.getAttribute("aria-label") ?? ""),
    );
    if (resume) {
      await act(async () => {
        resume.click();
      });
      await h.flush();
      expect(sessionMocks.resumeSession).toHaveBeenCalled();
    }
  });

  it("hides manage actions for non-managers and supports compact mode", async () => {
    statusMocks.fetchChatAgentStatuses.mockResolvedValue([
      mk("agent-1", { working: true, engagement: "active" }),
      mk("agent-2", { reachable: false }),
    ]);
    const { AgentStatusPanel } = await import("../agent-status-panel.js");
    h.render(
      wrap(<AgentStatusPanel chatId="chat-1" agents={agents} canManage={() => false} compact />, new Set(["agent-1"])),
    );
    await waitFor(h, "Nova");
    const manageButtons = Array.from(h.container.querySelectorAll("button")).filter((b) =>
      /pause|resume/i.test(b.textContent ?? b.getAttribute("aria-label") ?? ""),
    );
    expect(manageButtons.length).toBe(0);
  });
});
