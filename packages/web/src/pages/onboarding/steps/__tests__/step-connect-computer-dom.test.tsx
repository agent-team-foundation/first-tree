// @vitest-environment happy-dom

import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerConnection } from "../../../../features/agent-setup/use-computer-connection.js";
import type { OnboardingFlowValue } from "../../onboarding-flow.js";
import { OnboardingFlowContext } from "../../onboarding-flow.js";
import { StepConnectComputer } from "../step-connect-computer.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const BOOTSTRAP_COMMAND =
  "curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh\n" + "~/.local/bin/first-tree login abc123";

function computer(overrides: Partial<ComputerConnection> = {}): ComputerConnection {
  return {
    connectedClient: null,
    capabilitiesLoaded: false,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: vi.fn(),
    cliCommand: BOOTSTRAP_COMMAND,
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
    offerTeamAgentStart: false,
    completeAndEnterChat: vi.fn(),
    skipAndEnterChat: vi.fn(),
    finishLater: vi.fn(),
    ...overrides,
  };
}

async function renderStep(value: OnboardingFlowValue): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const ui: ReactElement = (
    <OnboardingFlowContext.Provider value={value}>
      <StepConnectComputer />
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

beforeEach(() => {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("StepConnectComputer", () => {
  it("renders and copies the server bootstrap command while waiting", async () => {
    const value = flow();

    const container = await renderStep(value);

    expect(container.textContent).toContain("https://download.first-tree.ai/releases/prod/install.sh");
    expect(container.textContent).toContain("~/.local/bin/first-tree login abc123");
    expect(container.textContent).not.toContain("npm install");
    expect(container.textContent).not.toContain("Node.js");
    await click(buttonByText(container, "Copy"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(BOOTSTRAP_COMMAND);
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
