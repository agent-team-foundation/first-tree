// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";

const mocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  fetchChatAgentStatuses: vi.fn(),
  getAgent: vi.fn(),
  authAgentId: "self-human",
}));

vi.mock("../../../api/chats.js", () => ({ getChat: mocks.getChat }));
vi.mock("../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId],
  fetchChatAgentStatuses: mocks.fetchChatAgentStatuses,
}));
vi.mock("../../../api/agents.js", () => ({ getAgent: mocks.getAgent }));
vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ agentId: mocks.authAgentId }),
}));

// Imported after the mocks are registered.
import { AgentHovercard } from "../agent-hovercard.js";

let h: DomHarness;
let queryClient: QueryClient;
let latestPath = "";

function LocationProbe(): null {
  latestPath = useLocation().pathname + useLocation().search;
  return null;
}

function render(ui: ReactElement): void {
  h.render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/start"]}>
        <LocationProbe />
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const flush = (): Promise<void> => h.flush();
const waitFor = (assertion: () => void): Promise<void> => h.waitFor(assertion);

// Pass A is read from the warm React Query cache (ChatView keeps it hot in the
// real app). Seed it directly so the test mirrors that warm-cache open.
function seedPassA(chatId: string, participants: unknown, statuses: unknown): void {
  queryClient.setQueryData(["chat-detail", chatId], { participants });
  queryClient.setQueryData(["chat-agent-status", chatId], statuses);
}

beforeEach(() => {
  h = createDomHarness();
  // staleTime: Infinity so the seeded Pass A cache (chat-detail / agent-status)
  // is never background-refetched; Pass B (getAgent) has no seed, so it still
  // fetches on open.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  mocks.getChat.mockReset();
  mocks.fetchChatAgentStatuses.mockReset();
  mocks.getAgent.mockReset();
  mocks.authAgentId = "self-human";
});

afterEach(() => {
  queryClient.clear();
  h.cleanup();
});

const AGENT_PARTICIPANT = {
  agentId: "a1",
  role: "member",
  mode: "active",
  joinedAt: "2026-01-01T00:00:00.000Z",
  name: "aria",
  displayName: "Aria",
  type: "agent",
  avatarColorToken: null,
  avatarImageUrl: null,
};

const HUMAN_PARTICIPANT = {
  agentId: "h1",
  role: "owner",
  mode: "active",
  joinedAt: "2026-01-01T00:00:00.000Z",
  name: "gandy",
  displayName: "Gandy",
  type: "human",
  avatarColorToken: null,
  avatarImageUrl: null,
};

const AGENT_DTO = {
  uuid: "a1",
  name: "aria",
  displayName: "Aria",
  type: "agent",
  managerId: "m1",
  clientId: "c1",
  runtimeProvider: "claude-code",
  avatarColorToken: null,
  avatarImageUrl: null,
};

async function openCard(): Promise<HTMLElement> {
  const trigger = h.container.querySelector<HTMLButtonElement>("button");
  if (!trigger) throw new Error("trigger not found");
  await act(async () => {
    trigger.click();
    await Promise.resolve();
  });
  await flush();
  const card = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (!card) throw new Error("card did not open");
  return card;
}

describe("AgentHovercard", () => {
  it("is closed until the trigger is activated", async () => {
    seedPassA("chat-1", [AGENT_PARTICIPANT], []);
    mocks.getAgent.mockResolvedValue(AGENT_DTO);
    render(
      <AgentHovercard agentId="a1" chatId="chat-1" name="Aria">
        <span>Aria</span>
      </AgentHovercard>,
    );
    await flush();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a server-ready status Idle despite residual timeline evidence", async () => {
    seedPassA(
      "chat-1",
      [AGENT_PARTICIPANT],
      [
        {
          agentId: "a1",
          main: "ready",
          reachable: true,
          engagement: "active",
          working: false,
          errored: false,
          activity: null,
        },
      ],
    );
    mocks.getAgent.mockResolvedValue(AGENT_DTO);
    render(
      <>
        <div data-working-agent="a1" />
        <AgentHovercard agentId="a1" chatId="chat-1" name="Aria">
          <span>Aria</span>
        </AgentHovercard>
      </>,
    );
    await flush();
    const card = await openCard();
    await waitFor(() => {
      expect(card.textContent).toContain("Aria");
      expect(card.textContent).toContain("@aria");
      expect(card.textContent).toContain("Idle");
      expect(card.textContent).toContain("New chat");
      expect(card.textContent).toContain("View profile");
    });
    expect(card.textContent).not.toContain("Owner");
    expect(card.textContent).not.toContain("Runs on");
    expect(card.textContent).not.toContain("claude-code");
    expect(card.textContent).not.toContain("gandy-mbp");
    const actions = card.querySelector<HTMLElement>("[data-participant-actions]");
    expect(actions?.classList.contains("flex")).toBe(true);
    expect(actions?.style.border).toBe("");
    expect(actions?.style.background).toBe("");
    expect([...card.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["New chat", "View profile"]);
    expect(mocks.getAgent).toHaveBeenCalledWith("a1");
  });

  it("renders one Working label without LIVE or activity detail", async () => {
    seedPassA(
      "chat-1",
      [AGENT_PARTICIPANT],
      [
        {
          agentId: "a1",
          main: "working",
          reachable: true,
          engagement: "active",
          working: true,
          errored: false,
          activity: {
            agentId: "a1",
            kind: "tool_call",
            label: "Bash",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    );
    mocks.getAgent.mockResolvedValue(AGENT_DTO);
    render(
      <AgentHovercard agentId="a1" chatId="chat-1" name="Aria">
        <span>Aria</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    await waitFor(() => {
      expect(card.textContent).toContain("Working");
    });
    expect(card.textContent?.match(/Working/g)).toHaveLength(1);
    expect(card.textContent).not.toContain("LIVE");
    expect(card.textContent).not.toContain("Bash");
  });

  it("navigates to agent details from the View profile link", async () => {
    seedPassA("chat-1", [AGENT_PARTICIPANT], []);
    // This case verifies routing, not the lazy permission probe covered by the
    // surrounding tests. Seed Pass B so unrelated query scheduling cannot
    // hide the link before the click assertion runs.
    queryClient.setQueryData(["agent", "a1"], AGENT_DTO);
    render(
      <AgentHovercard agentId="a1" chatId="chat-1" name="Aria">
        <span>Aria</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    let viewProfile: HTMLAnchorElement | undefined;
    await waitFor(() => {
      viewProfile = [...card.querySelectorAll("a")].find((a) => a.textContent?.includes("View profile"));
      if (!viewProfile) throw new Error("View profile not rendered yet");
    });
    await act(async () => {
      viewProfile?.click();
      await Promise.resolve();
    });
    expect(latestPath).toBe("/agents/a1/profile");
  });

  it("does not flash View profile while the lazy permission probe is pending", async () => {
    seedPassA("chat-1", [AGENT_PARTICIPANT], []);
    mocks.getAgent.mockReturnValue(new Promise(() => undefined));
    render(
      <AgentHovercard agentId="a1" chatId="chat-1" name="Aria">
        <span>Aria</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    expect([...card.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["New chat"]);
    expect(card.textContent).not.toContain("View profile");
  });

  it("renders the human variant with a Human label and only New chat (no Pass B)", async () => {
    seedPassA("chat-1", [HUMAN_PARTICIPANT], []);
    render(
      <AgentHovercard agentId="h1" chatId="chat-1" name="Gandy">
        <span>Gandy</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    await waitFor(() => {
      expect(card.textContent).toContain("Gandy");
      expect(card.textContent).toContain("@gandy");
      expect(card.textContent).toContain("Human");
      expect(card.textContent).toContain("New chat");
    });
    expect([...card.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["New chat"]);
    expect(card.textContent).not.toContain("Owner");
    expect(card.textContent).not.toContain("Runs on");
    expect(mocks.getAgent).not.toHaveBeenCalled();
  });

  it("removes the self-chat entry point for the current human", async () => {
    mocks.authAgentId = "h1";
    seedPassA("chat-1", [HUMAN_PARTICIPANT], []);
    render(
      <AgentHovercard agentId="h1" chatId="chat-1" name="Gandy">
        <span>Gandy</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    expect(card.textContent).toContain("You");
    expect(card.querySelector("[data-participant-actions]")).toBeNull();
  });

  it("degrades to identity + New chat when the agent is not readable (Pass B 404)", async () => {
    // A private agent visible via chat membership but not via GET /agents/:uuid.
    seedPassA(
      "chat-1",
      [AGENT_PARTICIPANT],
      [
        {
          agentId: "a1",
          main: "ready",
          reachable: true,
          engagement: "active",
          working: false,
          errored: false,
          activity: null,
        },
      ],
    );
    mocks.getAgent.mockRejectedValue(new Error("404"));
    render(
      <AgentHovercard agentId="a1" chatId="chat-1" name="Aria">
        <span>Aria</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    // A failed permission probe never exposes a route that would immediately
    // land on a 404; the chat-scoped route remains valid.
    await waitFor(() => {
      expect(card.textContent).toContain("Aria");
      expect([...card.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["New chat"]);
      expect(card.textContent).not.toContain("Owner");
      expect(card.textContent).not.toContain("Runs on");
      expect(card.textContent).not.toContain("View profile");
    });
  });

  it("does not invent an @handle from the participant id", async () => {
    seedPassA("chat-1", [{ ...HUMAN_PARTICIPANT, name: null }], []);
    render(
      <AgentHovercard agentId="h1" chatId="chat-1" name="Gandy">
        <span>Gandy</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    expect(card.textContent).not.toContain("@h1");
  });
});
