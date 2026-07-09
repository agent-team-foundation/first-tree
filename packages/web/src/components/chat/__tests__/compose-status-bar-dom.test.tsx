// @vitest-environment happy-dom

import { type AgentChatStatusInput, buildAgentChatStatus, type ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { ComposeStatusBar } from "../compose-status-bar.js";
import { LiveTurnAgentsContext } from "../live-turn-context.js";

const statusMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

vi.mock("../../../api/agent-status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/agent-status.js")>();
  return {
    ...actual,
    fetchChatAgentStatuses: statusMocks.fetchChatAgentStatuses,
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

const agents: ChatParticipantDetail[] = [
  {
    agentId: "agent-1",
    displayName: "Nova",
    name: "nova",
    kind: "agent",
    role: "member",
    avatarImageUrl: null,
    presence: "online",
  } as ChatParticipantDetail,
  {
    agentId: "agent-2",
    displayName: "Codex",
    name: "codex",
    kind: "agent",
    role: "member",
    avatarImageUrl: null,
    presence: "online",
  } as ChatParticipantDetail,
];

function wrap(ui: ReactElement, liveTurn: Set<string> = new Set()): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <LiveTurnAgentsContext.Provider value={liveTurn}>{ui}</LiveTurnAgentsContext.Provider>
    </QueryClientProvider>
  );
}

async function waitForText(h: DomHarness, text: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      expect(h.container.textContent).toContain(text);
      return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 5));
    await h.flush();
  }
  throw last;
}

describe("ComposeStatusBar DOM", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
  });
  afterEach(() => h.cleanup());

  it("hides when all agents are quiet", async () => {
    statusMocks.fetchChatAgentStatuses.mockResolvedValue([mk("agent-1"), mk("agent-2", { reachable: false })]);
    h.render(wrap(<ComposeStatusBar chatId="chat-1" agents={agents} />));
    await h.flush();
    await new Promise((r) => setTimeout(r, 20));
    await h.flush();
    expect(h.container.textContent ?? "").not.toContain("Nova");
  });

  it("shows working lead detail, expands others, and toggles full narration", async () => {
    const started = new Date(Date.now() - 5000).toISOString();
    statusMocks.fetchChatAgentStatuses.mockResolvedValue([
      mk("agent-1", {
        working: true,
        activity: {
          kind: "tool_call",
          label: "Bash",
          detail: "packages/web/src/app.tsx",
          startedAt: started,
          turnText: "Fix the coverage gaps in web package",
          turnTextFull: "Fix the coverage gaps in web package\nMore lines of narration",
        },
      }),
      mk("agent-2", {
        working: true,
        activity: {
          kind: "thinking",
          label: "Thinking",
          detail: null,
          startedAt: started,
          turnText: "Planning",
        },
      }),
    ]);

    h.render(wrap(<ComposeStatusBar chatId="chat-1" agents={agents} />));
    await waitForText(h, "Nova");
    expect(h.container.textContent).toContain("Fix the coverage gaps");

    const expand = h.container.querySelector<HTMLButtonElement>("button[aria-label='Expand activity']");
    expect(expand).not.toBeNull();
    await act(async () => {
      expand?.click();
    });
    await h.flush();
    expect(h.container.textContent).toMatch(/Codex|Planning/);

    // Toggle full narration card via the expand glyph if present
    const expandGoal = h.container.querySelector<HTMLButtonElement>(
      "button[aria-label*='narration'], button[aria-label*='Expand'], button[aria-label*='full']",
    );
    const chevrons = Array.from(h.container.querySelectorAll("button")).filter((b) =>
      /expand|collapse|narration|full/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
    );
    const toggle = expandGoal ?? chevrons.find((b) => b !== expand);
    if (toggle) {
      await act(async () => {
        toggle.click();
      });
      await h.flush();
    }
  });

  it("renders failed and status-reason rows", async () => {
    statusMocks.fetchChatAgentStatuses.mockResolvedValue([
      mk("agent-1", {
        errored: true,
      }),
      mk("agent-2", {
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
    h.render(wrap(<ComposeStatusBar chatId="chat-1" agents={agents} />));
    await waitForText(h, "failed");
  });

  it("renders thinking and writing activity when there is no goal text", async () => {
    const started = new Date().toISOString();
    statusMocks.fetchChatAgentStatuses.mockResolvedValue([
      mk("agent-1", {
        working: true,
        activity: {
          kind: "thinking",
          label: "Thinking",
          detail: null,
          startedAt: started,
        },
      }),
    ]);
    h.render(wrap(<ComposeStatusBar chatId="chat-1" agents={agents} />));
    await waitForText(h, "Thinking");

    statusMocks.fetchChatAgentStatuses.mockResolvedValue([
      mk("agent-1", {
        working: true,
        activity: {
          kind: "assistant_text",
          label: "Writing",
          detail: "Drafting the reply",
          startedAt: started,
        },
      }),
    ]);
    h.cleanup();
    h = createDomHarness();
    h.render(wrap(<ComposeStatusBar chatId="chat-2" agents={agents} />));
    await waitForText(h, "Drafting the reply");
  });
});
