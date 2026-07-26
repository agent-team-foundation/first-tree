// @vitest-environment happy-dom

import { type AgentChatStatus, buildAgentChatStatus, type ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";

const mocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
  useOrgAgents: vi.fn(),
}));
vi.mock("../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId],
  fetchChatAgentStatuses: mocks.fetchChatAgentStatuses,
}));
// The container resolves "does this agent run on a teammate's computer?" from
// the auth memberId + the shared org roster cache; both are mocked so these
// tests stay focused on notice behavior.
vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ memberId: "member-me" }),
}));
vi.mock("../../../lib/use-org-agents.js", () => ({
  useOrgAgents: mocks.useOrgAgents,
}));

// Imported after the mock is registered.
import { awaitedAgentsFromMessage, ChatOfflineNotice, OfflineNotice } from "../chat-offline-notice.js";

let h: DomHarness;
let queryClient: QueryClient;
let latestPath = "";

function LocationProbe(): null {
  latestPath = useLocation().pathname;
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
const notice = (): Element | null => h.container.querySelector('[role="status"]');

function agent(agentId: string, displayName: string): ChatParticipantDetail {
  return {
    agentId,
    role: "member",
    mode: "auto",
    joinedAt: "2026-01-01T00:00:00.000Z",
    name: displayName,
    displayName,
    type: "agent",
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

const status = (agentId: string, reachable: boolean): AgentChatStatus =>
  buildAgentChatStatus({ agentId, reachable, errored: false, working: false, engagement: "active" });

const ARIA = agent("a1", "Aria");

describe("awaitedAgentsFromMessage", () => {
  it("returns the routed non-human agents (addressedAgentIds intersect chat agents)", () => {
    const bee = agent("b", "Bee");
    expect(awaitedAgentsFromMessage({ addressedAgentIds: ["a1"] }, [ARIA, bee])).toEqual([ARIA]);
  });
  it("covers legacy system-routed messages (systemSender + addressedAgentIds, no mentions)", () => {
    const meta = { systemSender: "github", addressedAgentIds: ["a1"] };
    expect(awaitedAgentsFromMessage(meta, [ARIA])).toEqual([ARIA]);
  });
  it("returns [] when no agent was routed (empty / missing metadata)", () => {
    expect(awaitedAgentsFromMessage({}, [ARIA])).toEqual([]);
    expect(awaitedAgentsFromMessage(undefined, [ARIA])).toEqual([]);
  });
  it("ignores addressed ids that are not chat agents", () => {
    expect(awaitedAgentsFromMessage({ addressedAgentIds: ["ghost"] }, [ARIA])).toEqual([]);
  });
});

beforeEach(() => {
  h = createDomHarness();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  latestPath = "";
  mocks.fetchChatAgentStatuses.mockReset().mockResolvedValue([]);
  // Default: roster unknown (empty) → the reconnect action is preserved.
  mocks.useOrgAgents.mockReset().mockReturnValue({ data: { items: [] } });
});

afterEach(() => {
  h.cleanup();
  vi.useRealTimers();
});

describe("OfflineNotice (presentational)", () => {
  it("starting phase shows a coming-online line with no action", async () => {
    let clicks = 0;
    render(<OfflineNotice phase="starting" agentName="Aria" onReconnect={() => clicks++} />);
    await flush();
    expect(notice()?.textContent).toContain("Aria is coming online");
    expect(h.container.querySelector("button")).toBeNull();
    expect(clicks).toBe(0);
  });

  it("offline phase invites a queued task and exposes a working Reconnect", async () => {
    let clicks = 0;
    render(<OfflineNotice phase="offline" agentName="Aria" onReconnect={() => clicks++} />);
    await flush();
    expect(notice()?.textContent).toContain("anything you send will start once its computer reconnects");
    const btn = h.container.querySelector<HTMLButtonElement>("button");
    expect(btn?.textContent).toContain("Reconnect");
    await act(async () => {
      btn?.click();
      await Promise.resolve();
    });
    expect(clicks).toBe(1);
  });
});

describe("ChatOfflineNotice (container)", () => {
  it("renders nothing when no agent is awaited this turn", async () => {
    queryClient.setQueryData(["chat-agent-status", "c1"], [status("a1", false)]);
    render(<ChatOfflineNotice chatId="c1" agents={[]} />);
    await flush();
    expect(notice()).toBeNull();
  });

  it("renders nothing when the awaited agent is online", async () => {
    queryClient.setQueryData(["chat-agent-status", "c1"], [status("a1", true)]);
    render(<ChatOfflineNotice chatId="c1" agents={[ARIA]} />);
    await flush();
    expect(notice()).toBeNull();
  });

  it("does not read a still-loading status query as offline (no premature notice)", async () => {
    // queryFn pending → not isSuccess → must not flash "coming online" on a chat
    // whose agent may well be online (R2).
    mocks.fetchChatAgentStatuses.mockReturnValue(new Promise<AgentChatStatus[]>(() => {}));
    render(<ChatOfflineNotice chatId="c-loading" agents={[ARIA]} />);
    await flush();
    expect(notice()).toBeNull();
  });

  it("holds 'coming online' during the grace window, then escalates to offline + reconnect", async () => {
    vi.useFakeTimers();
    queryClient.setQueryData(["chat-agent-status", "c1"], [status("a1", false)]); // explicit offline row
    render(<ChatOfflineNotice chatId="c1" agents={[ARIA]} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(notice()?.textContent).toContain("Aria is coming online");

    await act(async () => {
      vi.advanceTimersByTime(8100);
      await Promise.resolve();
    });
    expect(notice()?.textContent).toContain("anything you send will start");

    const btn = h.container.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      btn?.click();
      await Promise.resolve();
    });
    expect(latestPath).toBe("/settings/computers");
  });

  it("a teammate-run agent shows where it runs and offers no Reconnect", async () => {
    vi.useFakeTimers();
    queryClient.setQueryData(["chat-agent-status", "c1"], [status("a1", false)]);
    // Roster resolves a1 to an agent managed by ANOTHER member.
    mocks.useOrgAgents.mockReturnValue({ data: { items: [{ uuid: "a1", managerId: "member-other" }] } });
    render(<ChatOfflineNotice chatId="c1" agents={[ARIA]} />);
    await act(async () => {
      vi.advanceTimersByTime(8100);
      await Promise.resolve();
    });
    expect(notice()?.textContent).toContain("runs on a teammate's computer");
    expect(h.container.querySelector("button")).toBeNull();
  });

  it("an agent the viewer manages keeps the Reconnect action", async () => {
    vi.useFakeTimers();
    queryClient.setQueryData(["chat-agent-status", "c1"], [status("a1", false)]);
    mocks.useOrgAgents.mockReturnValue({ data: { items: [{ uuid: "a1", managerId: "member-me" }] } });
    render(<ChatOfflineNotice chatId="c1" agents={[ARIA]} />);
    await act(async () => {
      vi.advanceTimersByTime(8100);
      await Promise.resolve();
    });
    expect(notice()?.textContent).toContain("anything you send will start");
    expect(h.container.querySelector<HTMLButtonElement>("button")?.textContent).toContain("Reconnect");
  });
});
