// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  fetchChatAgentStatuses: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock("../../../api/chats.js", () => ({ getChat: mocks.getChat }));
vi.mock("../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId],
  fetchChatAgentStatuses: mocks.fetchChatAgentStatuses,
}));
vi.mock("../../../api/agents.js", () => ({ getAgent: mocks.getAgent }));
vi.mock("../../../lib/use-member-name-map.js", () => ({
  useMemberNameMap: () => (id: string | null | undefined) => (id === "m1" ? "Gandy" : "—"),
}));
vi.mock("../../../lib/use-client-map.js", () => ({
  useClientMap: () => ({
    resolve: (id: string | null | undefined) => (id === "c1" ? { hostname: "gandy-mbp" } : null),
  }),
}));

// Imported after the mocks are registered.
import { AgentHovercard } from "../agent-hovercard.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient;
let latestPath = "";

function LocationProbe(): null {
  latestPath = useLocation().pathname + useLocation().search;
  return null;
}

function render(ui: ReactElement): void {
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/start"]}>
          <LocationProbe />
          <Routes>
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 25; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
    }
    await flush();
  }
  throw lastErr;
}

// Pass A is read from the warm React Query cache (ChatView keeps it hot in the
// real app). Seed it directly so the test mirrors that warm-cache open.
function seedPassA(chatId: string, participants: unknown, statuses: unknown): void {
  queryClient.setQueryData(["chat-detail", chatId], { participants });
  queryClient.setQueryData(["chat-agent-status", chatId], statuses);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // staleTime: Infinity so the seeded Pass A cache (chat-detail / agent-status)
  // is never background-refetched; Pass B (getAgent) has no seed, so it still
  // fetches on open.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  mocks.getChat.mockReset();
  mocks.fetchChatAgentStatuses.mockReset();
  mocks.getAgent.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
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
  const trigger = container?.querySelector<HTMLButtonElement>("button");
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

  it("shows identity, Owner and Runs-on for an agent (Pass B)", async () => {
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
      <AgentHovercard agentId="a1" chatId="chat-1" name="Aria">
        <span>Aria</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    await waitFor(() => {
      expect(card.textContent).toContain("Aria");
      expect(card.textContent).toContain("@aria");
      expect(card.textContent).toContain("Owner");
      expect(card.textContent).toContain("Gandy");
      expect(card.textContent).toContain("Runs on");
      expect(card.textContent).toContain("claude-code");
      expect(card.textContent).toContain("gandy-mbp");
      expect(card.textContent).toContain("Open details");
      expect(card.textContent).toContain("Chat");
    });
    expect(mocks.getAgent).toHaveBeenCalledWith("a1");
  });

  it("renders a LIVE pill and Working row when the agent is working", async () => {
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
      expect(card.textContent).toContain("LIVE");
      expect(card.textContent).toContain("Working");
    });
  });

  it("navigates to agent details from the Open details action", async () => {
    seedPassA("chat-1", [AGENT_PARTICIPANT], []);
    mocks.getAgent.mockResolvedValue(AGENT_DTO);
    render(
      <AgentHovercard agentId="a1" chatId="chat-1" name="Aria">
        <span>Aria</span>
      </AgentHovercard>,
    );
    await flush();
    const card = await openCard();
    let openDetails: HTMLButtonElement | undefined;
    await waitFor(() => {
      openDetails = [...card.querySelectorAll("button")].find((b) => b.textContent?.includes("Open details"));
      if (!openDetails) throw new Error("Open details not rendered yet");
    });
    await act(async () => {
      openDetails?.click();
      await Promise.resolve();
    });
    expect(latestPath).toBe("/agents/a1/profile");
  });

  it("renders the human variant with only a Message action (no Pass B)", async () => {
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
      expect(card.textContent).toContain("Message");
    });
    expect(card.textContent).not.toContain("Owner");
    expect(card.textContent).not.toContain("Runs on");
    expect(mocks.getAgent).not.toHaveBeenCalled();
  });

  it("degrades to identity + Chat when the agent is not readable (Pass B 404)", async () => {
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
    // Wait for the degraded END state, not the loading state: while getAgent is
    // still pending, detailsAccessible is true and Owner/Runs-on/Open details
    // render (with skeletons). Fold the negatives + the Chat-only button set
    // into the waited condition so the assertions run only after the 404 lands.
    await waitFor(() => {
      expect(card.textContent).toContain("Aria");
      expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Chat"]);
      expect(card.textContent).not.toContain("Owner");
      expect(card.textContent).not.toContain("Runs on");
      expect(card.textContent).not.toContain("Open details");
    });
  });
});
