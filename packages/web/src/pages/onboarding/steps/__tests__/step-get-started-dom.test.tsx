// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingFlowValue } from "../../onboarding-flow.js";
import { OnboardingFlowContext } from "../../onboarding-flow.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listMembers: vi.fn(),
  startOnboardingChat: vi.fn(),
}));
vi.mock("../../../../api/agents.js", () => ({ listAgents: mocks.listAgents }));
vi.mock("../../../../api/members.js", () => ({ listMembers: mocks.listMembers }));
vi.mock("../../tree-setup-chat.js", () => ({ startOnboardingChat: mocks.startOnboardingChat }));

// Imported after the mocks are registered.
import { StepGetStarted } from "../step-get-started.js";

const roots: Root[] = [];
let queryClient: QueryClient;

function flow(overrides: Partial<OnboardingFlowValue> = {}): OnboardingFlowValue {
  return {
    path: "invitee",
    sequence: ["join-team", "get-started", "connect-computer", "create-agent", "start-chat"],
    activeIndex: 1,
    activeStep: "get-started",
    goNext: vi.fn(),
    goTo: vi.fn(),
    reportStepFailure: vi.fn(),
    organizationId: "org-1",
    memberId: "member-me",
    role: "member",
    username: "casey",
    teamDisplayName: "Acme",
    orgHasOtherMembers: true,
    computer: {
      connectedClient: null,
      capabilitiesLoaded: false,
      okRuntimes: [],
      selectedRuntime: null,
      setSelectedRuntime: vi.fn(),
      cliCommand: "",
      tokenError: null,
      retry: vi.fn(),
    },
    agentDisplayName: "Assistant",
    setAgentDisplayName: vi.fn(),
    visibility: "organization",
    setVisibility: vi.fn(),
    agentPhase: "idle",
    agentError: null,
    createAgent: vi.fn(),
    retryAgent: vi.fn(),
    createdAgentUuid: null,
    hasAgent: false,
    offerTeamAgentStart: true,
    selectedRepoUrls: [],
    setSelectedRepoUrls: vi.fn(),
    hasRepoDraft: false,
    treeBindingPlan: "agentSeed",
    setTreeBindingPlan: vi.fn(),
    treeUrl: "",
    setTreeUrl: vi.fn(),
    treeAutoDetectDone: false,
    markTreeAutoDetectDone: vi.fn(),
    completeAndEnterChat: vi.fn(async () => undefined),
    skipAndEnterChat: vi.fn(async () => undefined),
    finishLater: vi.fn(async () => undefined),
    ...overrides,
  };
}

function teammateAgent(uuid: string, displayName: string, managerId: string) {
  return {
    uuid,
    name: displayName.toLowerCase().replace(/\s+/g, "-"),
    displayName,
    type: "agent",
    managerId,
    avatarImageUrl: null,
    avatarColorToken: null,
  };
}

async function renderStep(value: OnboardingFlowValue, opts: { strict?: boolean } = {}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const inner: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <OnboardingFlowContext.Provider value={value}>
        <StepGetStarted />
      </OnboardingFlowContext.Provider>
    </QueryClientProvider>
  );
  const ui: ReactElement = opts.strict ? <StrictMode>{inner}</StrictMode> : inner;
  await act(async () => {
    root.render(ui);
    await Promise.resolve();
  });
  return container;
}

function click(el: Element | null | undefined): Promise<void> {
  return act(async () => {
    (el as HTMLElement | null)?.click();
    await Promise.resolve();
  });
}

/** Let React Query settle an async queryFn (macrotask + microtask). */
function flushQueries(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  mocks.listAgents.mockReset().mockResolvedValue({
    items: [teammateAgent("agent-1", "Dev Assistant", "member-owner")],
    nextCursor: null,
  });
  mocks.listMembers
    .mockReset()
    .mockResolvedValue([{ id: "member-owner", displayName: "Zhang Wei", username: "zhangwei" }]);
  mocks.startOnboardingChat.mockReset().mockResolvedValue("chat-quick-start");
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

describe("StepGetStarted", () => {
  it("self-skips (advances exactly once) when the org offers no team-agent start", async () => {
    const value = flow({ offerTeamAgentStart: false });
    const container = await renderStep(value);
    // Idempotent even under a double-invoked mount effect (StrictMode): the
    // one-shot ref guards the relative goNext.
    expect(value.goNext).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
    expect(mocks.listAgents).not.toHaveBeenCalled();
  });

  it("self-skip advances exactly once under StrictMode's double-invoked mount effect", async () => {
    // The original defect existed only under StrictMode: goNext is a relative
    // increment, so a double-fired mount effect without the one-shot ref would
    // advance twice and skip connect-computer. Render under REAL StrictMode so
    // removing the guard fails this test.
    const value = flow({ offerTeamAgentStart: false });
    await renderStep(value, { strict: true });
    expect(value.goNext).toHaveBeenCalledTimes(1);
  });

  it("a failed roster read shows an error with retry, not a false empty state", async () => {
    mocks.listAgents.mockRejectedValueOnce(new Error("boom"));
    const value = flow();
    const container = await renderStep(value);
    await click(buttonByText(container, "Quick start"));
    await flushQueries();
    expect(container.textContent).toContain("Couldn't load your team's agents");
    expect(container.textContent).not.toContain("No team agent is available");
    // Retry refetches and renders the roster.
    await click(buttonByText(container, "Try again"));
    await flushQueries();
    expect(container.textContent).toContain("Dev Assistant");
  });

  it("offers both choices; the primary continues the standard setup", async () => {
    const value = flow();
    const container = await renderStep(value);
    expect(container.textContent).toContain("Set up my own agent");
    expect(container.textContent).toContain("Take a quick look with a team agent");
    await click(buttonByText(container, "Continue setup"));
    expect(value.goNext).toHaveBeenCalledTimes(1);
  });

  it("quick start lists teammate agents with their owner and starts the kickoff with invitee_skip", async () => {
    const value = flow();
    const container = await renderStep(value);
    await click(buttonByText(container, "Quick start"));
    await flushQueries();
    expect(container.textContent).toContain("Pick a team agent");
    expect(container.textContent).toContain("Dev Assistant");
    expect(container.textContent).toContain("Run by Zhang Wei");
    // The picker asks the server for non-human agents only, so human mirrors
    // can never crowd eligible agents off a page.
    expect(mocks.listAgents).toHaveBeenCalledWith(expect.objectContaining({ type: "agent", addressableOnly: true }));
    // The footnote keeps expectations honest: quick start ≠ finished setup.
    expect(container.textContent).toContain("won't finish your setup");

    await click(buttonByText(container, "Start chat"));
    expect(mocks.startOnboardingChat).toHaveBeenCalledTimes(1);
    const args = mocks.startOnboardingChat.mock.calls[0]?.[0];
    expect(args.agent.uuid).toBe("agent-1");
    expect(args.stamp).toBe("invitee_skip");
    expect(args.bootstrap).toContain("Dev Assistant");
    // Enters the chat WITHOUT stamping completion.
    expect(value.skipAndEnterChat).toHaveBeenCalledWith("chat-quick-start");
    expect(value.completeAndEnterChat).not.toHaveBeenCalled();
  });

  it("pages through every roster page so a later-page agent still shows", async () => {
    mocks.listAgents
      .mockResolvedValueOnce({
        items: [teammateAgent("agent-1", "Dev Assistant", "member-owner")],
        nextCursor: "2026-01-01T00:00:00.000Z",
      })
      .mockResolvedValueOnce({
        items: [teammateAgent("agent-2", "Docs Helper", "member-owner")],
        nextCursor: null,
      });
    const value = flow();
    const container = await renderStep(value);
    await click(buttonByText(container, "Quick start"));
    await flushQueries();
    expect(mocks.listAgents).toHaveBeenCalledTimes(2);
    expect(mocks.listAgents.mock.calls[1]?.[0]).toMatchObject({ cursor: "2026-01-01T00:00:00.000Z" });
    expect(container.textContent).toContain("Dev Assistant");
    expect(container.textContent).toContain("Docs Helper");
  });

  it("excludes the member's own agents from the picker", async () => {
    mocks.listAgents.mockResolvedValue({
      items: [
        teammateAgent("mine-1", "My Agent", "member-me"),
        teammateAgent("agent-1", "Dev Assistant", "member-owner"),
      ],
      nextCursor: null,
    });
    const value = flow();
    const container = await renderStep(value);
    await click(buttonByText(container, "Quick start"));
    await flushQueries();
    expect(container.textContent).toContain("Dev Assistant");
    expect(container.textContent).not.toContain("My Agent");
    expect(Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Start chat")).toHaveLength(
      1,
    );
  });

  it("empty picker offers the standard setup instead", async () => {
    mocks.listAgents.mockResolvedValue({ items: [], nextCursor: null });
    const value = flow();
    const container = await renderStep(value);
    await click(buttonByText(container, "Quick start"));
    await flushQueries();
    expect(container.textContent).toContain("No team agent is available right now");
    await click(buttonByText(container, "Continue setup"));
    expect(value.goNext).toHaveBeenCalledTimes(1);
  });
});
