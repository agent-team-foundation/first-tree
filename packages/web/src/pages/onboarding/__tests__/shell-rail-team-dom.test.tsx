// @vitest-environment happy-dom

import type { OrgBrief } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  organizationId: "org-1",
  currentOrgHasUsableAgent: false,
  role: "admin" as "admin" | "member",
  teamDisplayName: "Acme",
  user: { id: "user-1", displayName: "Gandy", username: "gandy", avatarUrl: null },
  selectOrganization: vi.fn(async () => undefined),
  switchingOrg: null as OrgBrief | null,
  setSwitchingOrg: vi.fn(),
  // Shell only reads memberships.length; keep the shape minimal.
  memberships: [{ organizationId: "org-1" }] as Array<{ organizationId: string }>,
}));

const toastMock = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

const flowMock = vi.hoisted(() => ({
  value: {
    activeStep: "create-team",
    activeIndex: 1,
    sequence: ["create-team", "connect-computer", "create-agent", "start-chat"],
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

vi.mock("../../../components/avatar.js", () => ({
  Avatar: ({ name }: { name?: string }) => <span data-testid="avatar">{name ?? ""}</span>,
}));

vi.mock("../../../components/invite-dialog.js", () => ({
  InviteDialog: () => null,
}));

vi.mock("../../../components/team-setup-modal.js", () => ({
  TeamSetupModal: ({ action }: { action: "create" | "join" | null }) =>
    action ? <div role="dialog">Team setup modal: {action}</div> : null,
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{element}</MemoryRouter>
      </QueryClientProvider>,
    );
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

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
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
  authMock.memberships = [{ organizationId: "org-1" }];
  authMock.organizationId = "org-1";
  authMock.role = "admin";
  authMock.teamDisplayName = "Acme";
  authMock.switchingOrg = null;
  authMock.currentOrgHasUsableAgent = false;
  document.body.innerHTML = "";
  flowMock.value = {
    activeStep: "create-team",
    activeIndex: 1,
    sequence: ["create-team", "connect-computer", "create-agent", "start-chat"],
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
    // The prominent progress bar shows only setup steps; start-chat is the
    // payoff screen after setup, not a fourth configuration chore.
    expect(container.textContent).toContain("Step 2 of 3");
    expect(container.textContent).toContain("Connect this computer");
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
    // Invitee path also shows only the 3 setup milestones.
    expect(container.textContent).toContain("Step 2 of 3");
  });

  it("keeps finish-later for a quick-start member (no personal agent, usable team agent)", async () => {
    // The team-agent quick-start case: Settings -> Setup resume cleared the
    // suppressor, the member has no personal agent, but the org has a usable
    // team agent — leaving is NOT a dead end, so the pause stays available.
    authMock.currentOrgHasUsableAgent = true;
    flowMock.value = {
      ...flowMock.value,
      activeStep: "connect-computer",
      path: "invitee",
      hasAgent: false,
    };
    const { OnboardingShell } = await import("../onboarding-shell.js");

    const container = await renderDom(<OnboardingShell>Body</OnboardingShell>);

    expect(container.textContent).toContain("I'll finish later");
  });

  it("renders the opening step with the same progress and heading layout as setup steps", async () => {
    flowMock.value = { ...flowMock.value, activeStep: "create-team", path: "admin", hasAgent: false };
    const { OnboardingShell } = await import("../onboarding-shell.js");

    const container = await renderDom(
      <OnboardingShell>
        <div>Opening body</div>
      </OnboardingShell>,
    );

    expect(container.textContent).toContain("Step 1 of 3");
    expect(container.textContent).toContain("Create a First Tree team");
    expect(container.textContent).toContain("Opening body");
  });

  it("does not show setup progress on the start-chat payoff screen", async () => {
    flowMock.value = { ...flowMock.value, activeStep: "start-chat", path: "admin", hasAgent: true };
    const { OnboardingShell } = await import("../onboarding-shell.js");

    const container = await renderDom(<OnboardingShell>Start chat body</OnboardingShell>);

    expect(container.textContent).toContain("Start chat body");
    expect(container.textContent).not.toContain("Step 4 of 4");
    expect(container.textContent).not.toContain("Step 3 of 3");
  });

  it("mounts a real team switcher for multi-team users in place of the bare sign-out link", async () => {
    // The trapped-user scenario: routed into onboarding for a second org with
    // no agent here (finish-later hidden) — the team switcher is the way
    // back to their other team.
    flowMock.value = { ...flowMock.value, activeStep: "connect-computer", hasAgent: false, organizationId: "org-2" };
    authMock.organizationId = "org-2";
    authMock.teamDisplayName = "Globex";
    authMock.memberships = [{ organizationId: "org-2" }, { organizationId: "org-1" }];
    apiMock.get.mockResolvedValueOnce([
      org({ id: "org-2", name: "globex", displayName: "Globex", role: "member" }),
      org({ id: "org-1", name: "acme", displayName: "Acme", role: "admin" }),
    ]);
    const { OnboardingShell } = await import("../onboarding-shell.js");

    const container = await renderDom(<OnboardingShell>Body</OnboardingShell>);

    const anchor = container.querySelector<HTMLButtonElement>(
      "[data-testid='team-switcher'] button[aria-haspopup='menu']",
    );
    expect(anchor).not.toBeNull();
    expect(anchor?.textContent).toContain("Globex");
    expect(container.textContent).toContain("Sign out");

    await click(anchor);
    const acmeRow = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Acme"));
    expect(acmeRow).not.toBeNull();

    await click(acmeRow ?? null);
    expect(authMock.selectOrganization).toHaveBeenCalledWith("org-1");

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign out")) ?? null,
    );
    expect(authMock.logout).toHaveBeenCalled();
  });

  it("keeps the minimal sign-out chrome for first-run single-team users", async () => {
    flowMock.value = { ...flowMock.value, activeStep: "connect-computer", hasAgent: false };
    authMock.memberships = [{ organizationId: "org-1" }];
    const { OnboardingShell } = await import("../onboarding-shell.js");

    const container = await renderDom(<OnboardingShell>Body</OnboardingShell>);

    expect(container.querySelector("[data-testid='team-switcher']")).toBeNull();
    expect(container.textContent).toContain("Sign out");
  });

  it("shows create and join recovery actions when the user has no active team", async () => {
    flowMock.value = {
      ...flowMock.value,
      activeStep: "create-agent",
      hasAgent: false,
      organizationId: null as unknown as string,
    };
    authMock.organizationId = null as unknown as string;
    authMock.role = null as unknown as "admin";
    authMock.teamDisplayName = null as unknown as string;
    authMock.memberships = [];
    const { OnboardingShell } = await import("../onboarding-shell.js");

    const container = await renderDom(<OnboardingShell>Stranded setup step</OnboardingShell>);

    expect(container.textContent).toContain("Create or join a team");
    expect(container.textContent).toContain("You need an active team to continue");
    expect(container.textContent).not.toContain("Stranded setup step");

    await click(buttonByText(container, "Create new team"));
    expect(document.body.textContent).toContain("Team setup modal: create");

    await click(buttonByText(container, "Join with invite link"));
    expect(document.body.textContent).toContain("Team setup modal: join");
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
