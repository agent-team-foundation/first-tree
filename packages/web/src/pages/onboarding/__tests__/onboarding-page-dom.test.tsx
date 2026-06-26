// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingPage } from "../onboarding-page.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    meLoaded: true,
    role: "admin" as string | null,
    onboardingStep: "connect" as "connect" | "create_agent" | "completed" | null,
    onboardingDismissedAt: null as string | null,
    onboardingCompletedAt: null as string | null,
    currentOrgHasUsableAgent: false,
    currentOrgHasPersonalAgent: false,
  },
}));

const flowMock = vi.hoisted(() => ({
  activeStep: "team",
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../onboarding-flow.js", () => ({
  OnboardingFlowProvider: ({ path, children }: { path: string; children: ReactNode }) => (
    <section data-flow-path={path}>{children}</section>
  ),
  useOnboardingFlow: () => ({ activeStep: flowMock.activeStep }),
}));

vi.mock("../onboarding-shell.js", () => ({
  OnboardingShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("../steps/step-connect-code.js", () => ({
  StepConnectCode: () => <div>Connect Code Step</div>,
}));
vi.mock("../steps/step-connect-computer.js", () => ({
  StepConnectComputer: () => <div>Connect Computer Step</div>,
}));
vi.mock("../steps/step-create-agent.js", () => ({
  StepCreateAgent: () => <div>Create Agent Step</div>,
}));
vi.mock("../steps/step-kickoff.js", () => ({
  StepKickoff: () => <div>Kickoff Step</div>,
}));
vi.mock("../steps/step-team.js", () => ({
  StepTeam: () => <div>Team Step</div>,
}));
vi.mock("../steps/step-welcome.js", () => ({
  StepWelcome: () => <div>Welcome Step</div>,
}));

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderRoute(element: ReactElement, route = "/onboarding"): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/" element={<div>Workspace Home</div>} />
          <Route path="/onboarding" element={element} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
  return container;
}

async function cleanupRoot(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
}

beforeEach(() => {
  authMock.value = {
    meLoaded: true,
    role: "admin",
    onboardingStep: "connect",
    onboardingDismissedAt: null,
    onboardingCompletedAt: null,
    currentOrgHasUsableAgent: false,
    currentOrgHasPersonalAgent: false,
  };
  flowMock.activeStep = "team";
  document.body.innerHTML = "";
});

afterEach(async () => {
  await cleanupRoot();
});

describe("OnboardingPage", () => {
  it("renders a blank shell while auth is loading", async () => {
    authMock.value = { ...authMock.value, meLoaded: false };

    const container = await renderRoute(<OnboardingPage />);

    expect(container.textContent).toBe("");
    expect(container.querySelector(".min-h-screen")).toBeTruthy();
  });

  it("redirects terminally completed users back to the workspace", async () => {
    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      onboardingCompletedAt: "2026-05-31T00:00:00.000Z",
      currentOrgHasUsableAgent: true,
      currentOrgHasPersonalAgent: true,
    };

    const container = await renderRoute(<OnboardingPage />);

    expect(container.textContent).toContain("Workspace Home");
  });

  it("keeps a user in the flow on a hard reload after create-agent (no completion stamp yet)", async () => {
    // A full page reload builds a fresh OnboardingPage whose leave-decision ref
    // starts null and recomputes from /me. Post-create-agent the server reports
    // onboardingStep "completed" + a personal agent, but this membership's completion
    // stamp is still null (connect-code / kickoff haven't run). The route must
    // resume the remaining step, NOT bounce to the workspace.
    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      currentOrgHasUsableAgent: true,
      currentOrgHasPersonalAgent: true,
      onboardingCompletedAt: null,
    };
    flowMock.activeStep = "connect-code";

    const container = await renderRoute(<OnboardingPage />);

    expect(container.textContent).not.toContain("Workspace Home");
    expect(container.textContent).toContain("Connect Code Step");
  });

  it("does NOT eject a user whose org gains a personal agent mid-flow (created at create-agent)", async () => {
    // Entry: actively onboarding, no personal agent yet → on the create-agent step.
    authMock.value = {
      ...authMock.value,
      onboardingStep: "create_agent",
      currentOrgHasUsableAgent: false,
      currentOrgHasPersonalAgent: false,
    };
    flowMock.activeStep = "create-agent";

    // Fresh element each render so React actually reconciles on the flip
    // (re-rendering the same element object bails out). OnboardingPage stays
    // the same instance across renders, so its entry-time decision persists.
    const renderTree = () => (
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/" element={<div>Workspace Home</div>} />
          <Route path="/onboarding" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(renderTree()));
    await flush();
    expect(container.textContent).toContain("Create Agent Step");

    // Mid-flow: the just-created agent comes online → currentOrgHasPersonalAgent
    // flips true and the flow advances to connect-code. The route must NOT
    // bounce to the workspace — connect-code + kickoff are still ahead of
    // create-agent in the admin sequence. (Regression: the leave-gate used to
    // re-evaluate every render and eject here.)
    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      currentOrgHasUsableAgent: true,
      currentOrgHasPersonalAgent: true,
    };
    flowMock.activeStep = "connect-code";
    await act(async () => root?.render(renderTree()));
    await flush();

    expect(container.textContent).not.toContain("Workspace Home");
    expect(container.textContent).toContain("Connect Code Step");
  });

  it("renders every step from the active onboarding flow", async () => {
    const cases: Array<[step: string, label: string, role: string, path: string]> = [
      ["team", "Team Step", "admin", "admin"],
      ["connect-code", "Connect Code Step", "admin", "admin"],
      ["connect-computer", "Connect Computer Step", "admin", "admin"],
      ["create-agent", "Create Agent Step", "admin", "admin"],
      ["kickoff", "Kickoff Step", "admin", "admin"],
      ["welcome", "Welcome Step", "member", "invitee"],
    ];

    for (const [step, label, role, path] of cases) {
      flowMock.activeStep = step;
      authMock.value = { ...authMock.value, role };
      const container = await renderRoute(<OnboardingPage />);

      expect(container.textContent).toContain(label);
      expect(container.querySelector(`[data-flow-path="${path}"]`)).toBeTruthy();
      await cleanupRoot();
    }
  });

  it("renders no body for an unknown flow step", async () => {
    flowMock.activeStep = "unknown";

    const container = await renderRoute(<OnboardingPage />);

    expect(container.textContent).not.toContain("Step");
  });
});
