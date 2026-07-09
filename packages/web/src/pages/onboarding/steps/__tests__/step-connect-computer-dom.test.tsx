// @vitest-environment happy-dom

import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerConnection } from "../../../../features/agent-setup/use-computer-connection.js";
import type { OnboardingFlowValue } from "../../onboarding-flow.js";
import { OnboardingFlowContext } from "../../onboarding-flow.js";
import { StepConnectComputer } from "../step-connect-computer.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function computer(overrides: Partial<ComputerConnection> = {}): ComputerConnection {
  return {
    connectedClient: null,
    capabilitiesLoaded: false,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: vi.fn(),
    cliCommand: "first-tree connect --token abc123",
    tokenError: null,
    retry: vi.fn(),
    ...overrides,
  };
}

function flow(overrides: Partial<OnboardingFlowValue> = {}): OnboardingFlowValue {
  return {
    path: "admin",
    sequence: ["connect-computer", "create-agent", "start-chat"],
    activeIndex: 0,
    activeStep: "connect-computer",
    goNext: vi.fn(),
    goTo: vi.fn(),
    organizationId: "org-1",
    memberId: "member-1",
    role: "admin",
    username: "gandy",
    teamDisplayName: "Acme",
    orgHasOtherMembers: false,
    computer: computer(),
    agentDisplayName: "Build Agent",
    setAgentDisplayName: vi.fn(),
    visibility: "private",
    setVisibility: vi.fn(),
    agentPhase: "idle",
    agentError: null,
    createAgent: vi.fn(),
    retryAgent: vi.fn(),
    createdAgentUuid: null,
    hasAgent: false,
    selectedRepoUrls: [],
    setSelectedRepoUrls: vi.fn(),
    hasRepoDraft: false,
    treeBindingPlan: "agentSeed",
    setTreeBindingPlan: vi.fn(),
    treeUrl: "",
    setTreeUrl: vi.fn(),
    treeAutoDetectDone: false,
    markTreeAutoDetectDone: vi.fn(),
    completeAndEnterChat: vi.fn(),
    finishLater: vi.fn(),
    ...overrides,
  };
}

async function renderStep(value: OnboardingFlowValue, initialStuck = false): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const ui: ReactElement = (
    <OnboardingFlowContext.Provider value={value}>
      <StepConnectComputer initialStuck={initialStuck} />
    </OnboardingFlowContext.Provider>
  );
  await act(async () => {
    root.render(ui);
  });
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("StepConnectComputer", () => {
  it("renders both connect command paths, stuck recovery, and a disabled continue while waiting", async () => {
    const value = flow();

    const container = await renderStep(value, true);

    expect(container.textContent).toContain("first-tree connect --token abc123");
    expect(container.textContent).toContain("Node.js");
    expect(buttonByText(container, "Continue")?.disabled).toBe(true);
  });

  it("switches the primary action to retry when token minting fails", async () => {
    const retry = vi.fn();
    const value = flow({ computer: computer({ tokenError: "token failed", retry }) });

    const container = await renderStep(value);
    await click(buttonByText(container, "Try again"));

    expect(container.textContent).toContain("couldn't prepare your setup command");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders connected, detecting, no-runtime, and ready runtime states", async () => {
    const connectedClient = {
      id: "client-1",
      userId: "user-1",
      hostname: "workstation",
      status: "connected",
      authState: "ok",
      binName: "first-tree",
      sdkVersion: "0.1.0",
      os: "linux",
      agentCount: 0,
      connectedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      capabilities: {},
    } satisfies NonNullable<ComputerConnection["connectedClient"]>;

    const detecting = await renderStep(flow({ computer: computer({ connectedClient }) }));
    expect(detecting.textContent).toContain("workstation");
    expect(detecting.textContent).toContain("Looking for coding agents");
    expect(buttonByText(detecting, "Continue")?.disabled).toBe(true);

    const noRuntime = await renderStep(
      flow({ computer: computer({ connectedClient, capabilitiesLoaded: true, okRuntimes: [] }) }),
    );
    expect(noRuntime.textContent).toContain("No coding agent found yet");

    const goNext = vi.fn();
    const ready = await renderStep(
      flow({
        goNext,
        computer: computer({ connectedClient, capabilitiesLoaded: true, okRuntimes: ["codex", "claude-code"] }),
      }),
    );
    expect(ready.textContent).toContain("Codex");
    expect(ready.textContent).toContain("Claude Code");
    expect(buttonByText(ready, "Continue")?.disabled).toBe(false);
    await click(buttonByText(ready, "Continue"));
    expect(goNext).toHaveBeenCalledTimes(1);
  });
});
