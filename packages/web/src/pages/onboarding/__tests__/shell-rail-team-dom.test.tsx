// @vitest-environment happy-dom

import type { OrgBrief } from "@first-tree/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

const eventMock = vi.hoisted(() => ({
  reportOnboardingEvent: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  logout: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

const flowMock = vi.hoisted(() => ({
  value: {
    activeStep: "team",
    activeIndex: 1,
    sequence: ["team", "connect-computer", "create-agent"],
    path: "admin",
    goTo: vi.fn(),
    goNext: vi.fn(),
    finishLater: vi.fn(async () => undefined),
    hasAgent: true,
    organizationId: "org-1",
  },
}));

vi.mock("../../../api/client.js", () => ({
  api: apiMock,
}));

vi.mock("../../../api/onboarding-events.js", () => eventMock);

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock,
}));

vi.mock("../../../components/ui/toast.js", () => ({
  useToast: () => toastMock,
}));

vi.mock("../onboarding-flow.js", () => ({
  useOnboardingFlow: () => flowMock.value,
}));

let root: Root | null = null;

function org(overrides: Partial<OrgBrief> = {}): OrgBrief {
  return {
    id: overrides.id ?? "org-1",
    name: overrides.name ?? "acme",
    displayName: overrides.displayName ?? "Acme",
    role: overrides.role ?? "admin",
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<MemoryRouter>{element}</MemoryRouter>);
  });
  await flush();
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected clickable element");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  });
  await flush();
}

async function submit(form: HTMLFormElement | null): Promise<void> {
  if (!form) throw new Error("Expected form");
  await act(async () => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  flowMock.value = {
    activeStep: "team",
    activeIndex: 1,
    sequence: ["team", "connect-computer", "create-agent"],
    path: "admin",
    goTo: vi.fn(),
    goNext: vi.fn(),
    finishLater: vi.fn(async () => undefined),
    hasAgent: true,
    organizationId: "org-1",
  };
  apiMock.get.mockResolvedValue([org()]);
  apiMock.patch.mockResolvedValue({});
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("onboarding shell and team step", () => {
  it("renders progress + finish-later chrome, pauses setup, and signs out", async () => {
    flowMock.value = { ...flowMock.value, activeStep: "connect-computer", path: "admin", hasAgent: true };
    const { OnboardingShell } = await import("../onboarding-shell.js");

    const container = await renderDom(
      <OnboardingShell>
        <div>Step body</div>
      </OnboardingShell>,
    );

    expect(container.textContent).toContain("First Tree");
    // config step → top segmented progress shows position (admin has 3)
    expect(container.textContent).toContain("Step 1 of 3");
    expect(container.textContent).toContain("Set up where your agent runs");
    expect(container.textContent).toContain("Step body");

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("finish later")) ?? null,
    );
    expect(toastMock.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Setup paused", action: expect.objectContaining({ label: "Open Settings" }) }),
    );
    expect(flowMock.value.finishLater).toHaveBeenCalled();

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign out")) ?? null,
    );
    expect(authMock.logout).toHaveBeenCalled();
  });

  it("hides finish-later when no agent exists and counts invitee config steps", async () => {
    flowMock.value = {
      ...flowMock.value,
      activeStep: "connect-computer",
      path: "invitee",
      hasAgent: false,
    };
    const { OnboardingShell } = await import("../onboarding-shell.js");

    const container = await renderDom(<OnboardingShell>Body</OnboardingShell>);

    expect(container.textContent).not.toContain("I'll finish later");
    // invitee has 2 config steps → connect-computer is step 1 of 2
    expect(container.textContent).toContain("Step 1 of 2");
  });

  it("loads the team name, saves changes, and skips unchanged submissions", async () => {
    const { StepTeam } = await import("../steps/step-team.js");
    const container = await renderDom(<StepTeam />);
    const input = container.querySelector<HTMLInputElement>("#onboarding-team-name");
    if (!input) throw new Error("Expected team input");

    expect(input.value).toBe("Acme");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);

    await submit(container.querySelector("form"));
    expect(apiMock.patch).not.toHaveBeenCalled();
    expect(flowMock.value.goNext).toHaveBeenCalledTimes(1);

    await setInputValue(input, "Acme Labs");
    await submit(container.querySelector("form"));
    expect(apiMock.patch).toHaveBeenCalledWith("/orgs/org-1", { displayName: "Acme Labs" });
    expect(eventMock.reportOnboardingEvent).toHaveBeenCalledWith("team_renamed");
    expect(flowMock.value.goNext).toHaveBeenCalledTimes(2);
  });

  it("shows load and save failures and blocks empty submissions", async () => {
    apiMock.get.mockRejectedValueOnce(new Error("offline"));
    const { StepTeam } = await import("../steps/step-team.js");
    let container = await renderDom(<StepTeam />);
    expect(container.textContent).toContain("Couldn't load your team");

    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    apiMock.get.mockResolvedValueOnce([org()]);
    apiMock.patch.mockRejectedValueOnce(new Error("rename failed"));
    container = await renderDom(<StepTeam />);
    const input = container.querySelector<HTMLInputElement>("#onboarding-team-name");
    if (!input) throw new Error("Expected team input");
    await setInputValue(input, "");
    await submit(container.querySelector("form"));
    expect(apiMock.patch).not.toHaveBeenCalled();

    await setInputValue(input, "New Name");
    await submit(container.querySelector("form"));
    expect(container.textContent).toContain("rename failed");
  });
});
