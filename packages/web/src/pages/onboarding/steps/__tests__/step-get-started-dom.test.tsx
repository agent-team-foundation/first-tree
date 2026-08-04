// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingFlowValue } from "../../onboarding-flow.js";
import { OnboardingFlowContext } from "../../onboarding-flow.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listMembers: vi.fn(),
  getContextTreeSetting: vi.fn(),
  listTeamResourcesForOrg: vi.fn(),
  getContextEnablementHandoff: vi.fn(),
  startOnboardingChat: vi.fn(),
}));
vi.mock("../../../../api/agents.js", () => ({ listAgents: mocks.listAgents }));
vi.mock("../../../../api/members.js", () => ({ listMembers: mocks.listMembers }));
vi.mock("../../../../api/org-settings.js", () => ({ getContextTreeSetting: mocks.getContextTreeSetting }));
vi.mock("../../../../api/resources.js", () => ({ listTeamResourcesForOrg: mocks.listTeamResourcesForOrg }));
vi.mock("../../../../api/context-enablement.js", () => ({
  getContextEnablementHandoff: mocks.getContextEnablementHandoff,
}));
vi.mock("../../tree-setup-chat.js", () => ({ startOnboardingChat: mocks.startOnboardingChat }));

// Imported after the mocks are registered.
import { StepGetStarted } from "../step-get-started.js";

const roots: Root[] = [];
let queryClient: QueryClient;
const writeText = vi.fn<(text: string) => Promise<void>>();

function flow(overrides: Partial<OnboardingFlowValue> = {}): OnboardingFlowValue {
  return {
    path: "invitee",
    sequence: ["get-started", "connect-computer", "create-agent", "start-chat"],
    activeIndex: 0,
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
      cliCommand: "first-tree login connect-token",
      tokenError: null,
      retry: vi.fn(),
    },
    prepareByoBootstrap: vi.fn(),
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

async function renderStep(value: OnboardingFlowValue): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const inner: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OnboardingFlowContext.Provider value={value}>
          <StepGetStarted />
        </OnboardingFlowContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => {
    root.render(inner);
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

async function openContinueWithout(container: HTMLElement): Promise<void> {
  await click(buttonByText(container, "Continue without my own agent"));
  await flushQueries();
}

async function openByo(container: HTMLElement): Promise<void> {
  await openContinueWithout(container);
  await click(buttonByText(container, "Use the Context Tree in Claude Code or Codex"));
  await flushQueries();
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  mocks.listAgents.mockReset().mockResolvedValue({
    items: [teammateAgent("agent-1", "Dev Assistant", "member-owner")],
    nextCursor: null,
  });
  mocks.listMembers
    .mockReset()
    .mockResolvedValue([{ id: "member-owner", displayName: "Zhang Wei", username: "zhangwei" }]);
  mocks.startOnboardingChat.mockReset().mockResolvedValue("chat-quick-start");
  mocks.getContextTreeSetting.mockReset().mockResolvedValue({ repo: "https://github.com/acme/context-tree" });
  mocks.listTeamResourcesForOrg
    .mockReset()
    .mockResolvedValue([{ id: "repo-1", type: "repo", scope: "team", status: "active" }]);
  mocks.getContextEnablementHandoff.mockReset().mockImplementation(async (_organizationId, provider) => ({
    protocolVersion: 1,
    organizationId: "org-1",
    teamDisplayName: "Acme",
    role: "member",
    provider,
    intent: "onboarding",
    command: `'first-tree' --json context enable --provider '${provider}' --team 'org-1' --plan`,
    workingDirectoryInstruction: "Run this once from the root of the code repository.",
  }));
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

describe("StepGetStarted", () => {
  it("shows one personal-agent recommendation before revealing alternatives", async () => {
    const value = flow({ offerTeamAgentStart: false });
    const container = await renderStep(value);
    expect(container.textContent).toContain("You've joined Acme");
    expect(container.textContent).toContain("Set up your First Tree agent");
    expect(container.textContent).toContain("Connect computer");
    expect(container.textContent).toContain("Meet your agent");
    expect(container.textContent).not.toContain("Pick a team agent");
    expect(container.textContent).not.toContain("Use the Context Tree in Claude Code or Codex");
    expect(mocks.listAgents).not.toHaveBeenCalled();
    await click(buttonByText(container, "Set up my agent"));
    expect(value.goNext).toHaveBeenCalledTimes(1);
  });

  it("skips the computer step when a supported coding tool is already ready", async () => {
    const value = flow({
      computer: {
        connectedClient: {
          id: "client-1",
          hostname: "caseys-mac",
        } as OnboardingFlowValue["computer"]["connectedClient"],
        capabilitiesLoaded: true,
        okRuntimes: ["claude-code"],
        selectedRuntime: "claude-code",
        setSelectedRuntime: vi.fn(),
        cliCommand: "",
        tokenError: null,
        retry: vi.fn(),
      },
    });
    const container = await renderStep(value);
    await flushQueries();
    expect(container.textContent).toContain("Your computer is connected");
    await click(buttonByText(container, "Create my agent"));
    expect(value.goTo).toHaveBeenCalledWith(2);
    expect(value.goNext).not.toHaveBeenCalled();
  });

  it("a failed roster read shows an error with retry, not a false empty state", async () => {
    mocks.listAgents.mockRejectedValueOnce(new Error("boom"));
    const value = flow();
    const container = await renderStep(value);
    await openContinueWithout(container);
    expect(container.textContent).toContain("Couldn't load your team's agents");
    expect(container.textContent).not.toContain("No team agent is available");
    // Retry refetches and renders the roster.
    await click(buttonByText(container, "Try again"));
    await flushQueries();
    expect(container.textContent).toContain("Dev Assistant");
  });

  it("does not expose a Team-agent start when owner disclosure cannot load", async () => {
    mocks.listMembers.mockRejectedValueOnce(new Error("boom"));
    const value = flow();
    const container = await renderStep(value);
    await openContinueWithout(container);

    expect(container.textContent).toContain("Couldn't load your team's agents");
    expect(container.textContent).not.toContain("Uses its owner's connected computer");
    expect(buttonByText(container, "Start chat")).toBeUndefined();
  });

  it("reveals Team-agent and Context access only after explicit continuation", async () => {
    const value = flow();
    const container = await renderStep(value);
    expect(container.textContent).not.toContain("Pick a team agent");
    expect(container.textContent).not.toContain("Use the Context Tree in Claude Code or Codex");
    await openContinueWithout(container);
    expect(container.textContent).toContain("Pick a team agent");
    expect(container.textContent).toContain("Dev Assistant");
    expect(container.textContent).toContain("Use the Context Tree in Claude Code or Codex");
  });

  it("Team-agent quick start stays resumable without requiring a personal Computer", async () => {
    const value = flow();
    const container = await renderStep(value);
    await openContinueWithout(container);
    expect(container.textContent).toContain("Pick a team agent");
    expect(container.textContent).toContain("Dev Assistant");
    expect(container.textContent).toContain("Run by Zhang Wei");
    expect(container.textContent).toContain("Uses Zhang Wei's connected computer and coding plan");
    const ownerDisclosure = Array.from(container.querySelectorAll(".text-caption")).find((element) =>
      element.textContent?.includes("Uses Zhang Wei's connected computer"),
    );
    expect(ownerDisclosure?.classList.contains("truncate")).toBe(false);
    expect(ownerDisclosure?.classList.contains("break-words")).toBe(true);
    // The picker asks the server for non-human agents only, so human mirrors
    // can never crowd eligible agents off a page.
    expect(mocks.listAgents).toHaveBeenCalledWith(expect.objectContaining({ type: "agent", addressableOnly: true }));
    await click(buttonByText(container, "Start chat"));
    expect(mocks.startOnboardingChat).toHaveBeenCalledTimes(1);
    const args = mocks.startOnboardingChat.mock.calls[0]?.[0];
    expect(args.agent.uuid).toBe("agent-1");
    expect(args.stamp).toBe("invitee_skip");
    expect(args.bootstrap).toContain("chose to start with a Team agent");
    expect(value.completeAndEnterChat).toHaveBeenCalledWith("chat-quick-start", "get-started", "invitee_skip");
  });

  it("BYO gives the member one prompt for computer connection and Team Context", async () => {
    const value = flow({ offerTeamAgentStart: false });
    const container = await renderStep(value);
    await openByo(container);
    expect(value.prepareByoBootstrap).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Set up in your coding agent");
    expect(container.textContent).toContain("Setup prompt");
    expect(container.textContent).toContain("Claude Code or Codex for Acme");
    expect(container.textContent).toContain("Connects this computer if needed");
    expect(container.textContent).toContain("enables Team Context for this local project");
    expect(container.textContent).toContain("zero, one, or many source repositories");
    expect(container.textContent).toContain("first-tree login connect-token");
    expect(container.textContent).toContain("context enable --provider 'claude-code'");
    expect(container.textContent).toContain("context enable --provider 'codex'");
    expect(buttonByText(container, "Copy setup prompt")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("pre")?.closest('[data-clarity-mask="true"]')).not.toBeNull();
    expect(container.textContent).toContain("View full prompt");
    expect(container.textContent).not.toContain("Run this command in your terminal");
    expect(container.textContent).toContain("does not create a First Tree agent");
    expect(container.textContent).not.toContain("Name your agent");
    expect(value.goNext).not.toHaveBeenCalled();
    expect(buttonByText(container, "Claude Code")).toBeUndefined();
    expect(buttonByText(container, "Codex")).toBeUndefined();

    await click(buttonByText(container, "Copy setup prompt"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("context enable --provider 'claude-code'"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("context enable --provider 'codex'"));
    expect(buttonByText(container, "Copied")).toBeTruthy();
    expect(container.textContent).toContain("Paste into Claude Code or Codex opened at the project");
    await flushQueries();
    expect(buttonByText(container, "Copied")).toBeTruthy();
  });

  it("keeps the prompt available when automatic copy fails", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    const container = await renderStep(flow({ offerTeamAgentStart: false }));
    await openByo(container);
    await click(buttonByText(container, "Copy setup prompt"));

    expect(container.textContent).toContain("Couldn't copy automatically");
    expect(container.textContent).toContain("View full prompt");
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  it("keeps one connection fallback even when another computer is already connected", async () => {
    const value = flow({
      offerTeamAgentStart: false,
      computer: {
        connectedClient: {
          id: "client-1",
          hostname: "caseys-mac",
        } as OnboardingFlowValue["computer"]["connectedClient"],
        capabilitiesLoaded: true,
        okRuntimes: ["claude-code"],
        selectedRuntime: "claude-code",
        setSelectedRuntime: vi.fn(),
        cliCommand: "first-tree login fresh-connect-token",
        tokenError: null,
        retry: vi.fn(),
      },
    });
    const container = await renderStep(value);
    await openByo(container);
    expect(container.textContent).toContain("Set up in your coding agent");
    expect(container.textContent).toContain("server-provided bootstrap");
    expect(container.textContent).toContain("first-tree login fresh-connect-token");
    expect(container.textContent).toContain("'first-tree' --json context enable");
    expect(container.textContent).not.toContain("--complete-onboarding");
    expect(container.textContent).toContain("First Tree Web owns onboarding completion separately");
    expect(container.textContent).toContain("does not create a First Tree agent");
    expect(buttonByText(container, "Finish onboarding")).toBeUndefined();
    expect(container.textContent).toContain("verifies setup automatically");
    expect(value.createAgent).not.toHaveBeenCalled();
  });

  it("does not infer BYO provider readiness from the globally connected Computer", async () => {
    const value = flow({
      computer: {
        connectedClient: {
          id: "client-1",
          hostname: "caseys-mac",
        } as OnboardingFlowValue["computer"]["connectedClient"],
        capabilitiesLoaded: true,
        okRuntimes: ["codex"],
        selectedRuntime: "codex",
        setSelectedRuntime: vi.fn(),
        cliCommand: "first-tree login connect-token",
        tokenError: null,
        retry: vi.fn(),
      },
    });
    const container = await renderStep(value);
    await openByo(container);

    expect(buttonByText(container, "Codex")).toBeUndefined();
    expect(buttonByText(container, "Claude Code")).toBeUndefined();
    expect(container.textContent).toContain("--provider 'codex'");
    expect(container.textContent).toContain("follow `data.nextActions`");
    expect(container.textContent).not.toContain("/hooks");
    expect(mocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "codex", "onboarding");
  });

  it("allows BYO from a Browser whose connected Computer reports only another runtime", async () => {
    const value = flow({
      computer: {
        connectedClient: {
          id: "client-1",
          hostname: "caseys-mac",
        } as OnboardingFlowValue["computer"]["connectedClient"],
        capabilitiesLoaded: true,
        okRuntimes: ["cursor"],
        selectedRuntime: "cursor",
        setSelectedRuntime: vi.fn(),
        cliCommand: "first-tree login connect-token",
        tokenError: null,
        retry: vi.fn(),
      },
    });
    const container = await renderStep(value);
    await openByo(container);

    expect(buttonByText(container, "Claude Code")).toBeUndefined();
    expect(buttonByText(container, "Codex")).toBeUndefined();
    expect(container.textContent).toContain("Claude Code or Codex for Acme");
    expect(mocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "claude-code", "onboarding");
  });

  it("returns to First Tree without treating BYO as onboarding completion", async () => {
    const value = flow({ offerTeamAgentStart: false });
    const container = await renderStep(value);
    await openByo(container);
    await click(buttonByText(container, "Return to First Tree"));
    expect(value.finishLater).toHaveBeenCalledTimes(1);
    expect(value.completeAndEnterChat).not.toHaveBeenCalled();
  });

  it("does not let the Browser stamp BYO completion", async () => {
    const value = flow();
    const container = await renderStep(value);
    await openByo(container);
    await click(buttonByText(container, "Copy setup prompt"));
    expect(container.textContent).toContain("Paste into Claude Code or Codex opened at the project");
    expect(buttonByText(container, "Finish onboarding")).toBeUndefined();
  });

  it("keeps BYO non-actionable when the Team has no ready Context Tree", async () => {
    mocks.getContextTreeSetting.mockResolvedValueOnce({ repo: null });
    mocks.listTeamResourcesForOrg.mockResolvedValueOnce([]);
    const value = flow();
    const container = await renderStep(value);
    await openContinueWithout(container);
    expect(container.textContent).not.toContain("Use the Context Tree in Claude Code or Codex");
  });

  it("offers a retry when Team Context readiness cannot be checked", async () => {
    mocks.getContextTreeSetting.mockRejectedValueOnce(new Error("temporary"));
    const value = flow();
    const container = await renderStep(value);
    await openContinueWithout(container);
    expect(container.textContent).toContain("Couldn't check this option");
    await click(buttonByText(container, "Try Context Tree access again"));
    await flushQueries();
    expect(buttonByText(container, "Use the Context Tree in Claude Code or Codex")).toBeTruthy();
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
    await openContinueWithout(container);
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
    await openContinueWithout(container);
    expect(container.textContent).toContain("Dev Assistant");
    expect(container.textContent).not.toContain("My Agent");
    expect(Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Start chat")).toHaveLength(
      1,
    );
  });

  it("empty picker returns to the recommended path and alternate choices", async () => {
    mocks.listAgents.mockResolvedValue({ items: [], nextCursor: null });
    const value = flow();
    const container = await renderStep(value);
    await openContinueWithout(container);
    expect(container.textContent).toContain("No Team agent is available right now");
    expect(container.textContent).toContain("Use the Context Tree in Claude Code or Codex");
    await click(buttonByText(container, "Back"));
    expect(container.textContent).toContain("Set up your First Tree agent");
    expect(container.textContent).not.toContain("Use the Context Tree in Claude Code or Codex");
    expect(value.goNext).not.toHaveBeenCalled();
  });
});
