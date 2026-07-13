// @vitest-environment happy-dom

import type { OrgContextTreeFeaturesOutput, OrgContextTreeOutput, OrgSourceReposOutput } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    role: "admin" as "admin" | "member",
    organizationId: "org-1" as string | null,
    onboardingCompletedAt: null as string | null,
    meLoaded: true,
  },
}));

const settingsMocks = vi.hoisted(() => ({
  getContextTreeFeaturesSetting: vi.fn(),
  getContextTreeSetting: vi.fn(),
  putContextTreeFeaturesSetting: vi.fn(),
  getSourceReposSetting: vi.fn(),
  putContextTreeSetting: vi.fn(),
  putSourceReposSetting: vi.fn(),
}));

const agentApiMocks = vi.hoisted(() => ({
  listAllAgents: vi.fn(),
}));

const onboardingEventMocks = vi.hoisted(() => ({
  getTreeSetupStatus: vi.fn(),
}));

const contextApiMocks = vi.hoisted(() => ({
  initializeContextTree: vi.fn(),
}));

const viewportMock = vi.hoisted(() => ({
  value: "xl" as "xl" | "md" | "narrow",
}));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../api/org-settings.js", () => settingsMocks);

vi.mock("../../api/agents.js", () => agentApiMocks);

vi.mock("../../api/onboarding-events.js", () => onboardingEventMocks);

vi.mock("../../api/context-tree.js", () => contextApiMocks);

vi.mock("../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => viewportMock.value,
}));

const NOW = "2026-05-28T12:00:00.000Z";

function contextTree(overrides: Partial<OrgContextTreeOutput> = {}): OrgContextTreeOutput {
  return {
    repo: overrides.repo ?? "https://github.com/acme/context",
    branch: overrides.branch ?? "main",
  };
}

function sourceRepos(overrides: Partial<OrgSourceReposOutput> = {}): OrgSourceReposOutput {
  return {
    repos: overrides.repos ?? [
      { url: "https://github.com/acme/web", defaultBranch: "main" },
      { url: "https://github.com/acme/api" },
    ],
  };
}

function contextTreeFeatures(overrides: Partial<OrgContextTreeFeaturesOutput["contextReviewer"]> = {}) {
  return {
    contextReviewer: {
      enabled: overrides.enabled ?? false,
      agentUuid: overrides.agentUuid ?? null,
      reviewerAgent: overrides.reviewerAgent ?? null,
    },
  } satisfies OrgContextTreeFeaturesOutput;
}

function managedAgent(overrides: {
  uuid: string;
  displayName?: string;
  name?: string | null;
  organizationId?: string;
  type?: string;
  status?: string;
}) {
  return {
    uuid: overrides.uuid,
    name: overrides.name ?? overrides.uuid,
    displayName: overrides.displayName ?? overrides.name ?? overrides.uuid,
    type: overrides.type ?? "agent",
    organizationId: overrides.organizationId ?? "org-1",
    inboxId: `inbox-${overrides.uuid}`,
    visibility: "private",
    runtimeProvider: "claude-code",
    clientId: `client-${overrides.uuid}`,
    status: overrides.status ?? "active",
    avatarImageUrl: null,
  };
}

function paginatedAgents(items: ReturnType<typeof managedAgent>[], nextCursor: string | null = null) {
  return { items, nextCursor };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(
  element: ReactElement,
  route = "/settings/context",
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <QueryClientProvider client={createClient()}>
          <Routes>
            <Route path="/settings/*" element={element}>
              <Route path="context" element={<div>Settings child</div>} />
              <Route path="github" element={<div>GitHub child</div>} />
            </Route>
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function renderPanel(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={createClient()}>
          <LocationProbe />
          {element}
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function selectOption(container: ParentNode, label: string): Promise<void> {
  await click(container.querySelector('[aria-label="Context Reviewer agent"]'));
  await waitForCondition(
    () => [...document.body.querySelectorAll('[role="option"]')].some((option) => option.textContent?.includes(label)),
    `Expected select option "${label}"`,
  );
  const option =
    [...document.body.querySelectorAll('[role="option"]')].find((node) => node.textContent?.includes(label)) ?? null;
  await click(option);
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
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

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text)) ??
    null
  );
}

function inputByLabel(container: ParentNode, label: string): HTMLInputElement | null {
  const labelElement = [...container.querySelectorAll<HTMLLabelElement>("label")].find((node) =>
    node.textContent?.includes(label),
  );
  const control = labelElement?.control;
  return control instanceof HTMLInputElement ? control : null;
}

/** The Context Reviewer on/off Switch — the only ARIA switch in this panel. */
function reviewerSwitch(container: ParentNode): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[role="switch"]');
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { role: "admin", organizationId: "org-1", onboardingCompletedAt: null, meLoaded: true };
  viewportMock.value = "xl";
  settingsMocks.getContextTreeSetting.mockResolvedValue(contextTree());
  settingsMocks.getContextTreeFeaturesSetting.mockResolvedValue(contextTreeFeatures());
  settingsMocks.putContextTreeSetting.mockImplementation(async (_id: string, body: Partial<OrgContextTreeOutput>) =>
    contextTree(body),
  );
  settingsMocks.putContextTreeFeaturesSetting.mockImplementation(
    async (_id: string, body: OrgContextTreeFeaturesOutput) => body,
  );
  agentApiMocks.listAllAgents.mockResolvedValue(
    paginatedAgents([
      managedAgent({ uuid: "agent-beta", displayName: "Beta Reviewer", name: "beta" }),
      managedAgent({ uuid: "agent-alpha", displayName: "Alpha Reviewer", name: "alpha" }),
      managedAgent({ uuid: "human-1", displayName: "Human User", type: "human" }),
      managedAgent({ uuid: "suspended-1", displayName: "Suspended", status: "suspended" }),
      managedAgent({ uuid: "other-org-1", displayName: "Other Org", organizationId: "org-2" }),
    ]),
  );
  contextApiMocks.initializeContextTree.mockResolvedValue({
    repo: "https://github.com/acme/acme-context-tree.git",
    htmlUrl: "https://github.com/acme/acme-context-tree",
    branch: "main",
    nodePath: "NODE.md",
  });
  settingsMocks.getSourceReposSetting.mockResolvedValue(sourceRepos());
  settingsMocks.putSourceReposSetting.mockImplementation(async (_id: string, body: Partial<OrgSourceReposOutput>) =>
    sourceRepos(body),
  );
  onboardingEventMocks.getTreeSetupStatus.mockResolvedValue({
    needsTreeSetup: false,
    hasTreeBinding: true,
    hasTreeSetupStartChat: true,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("settings panels", () => {
  it("renders settings layout variants and filters admin/onboarding nav entries", async () => {
    const { SettingsLayout } = await import("../settings.js");

    const desktop = await renderDom(<SettingsLayout />, "/settings/github");
    expect(desktop.container.textContent).toContain("Computers");
    expect(desktop.container.textContent).toContain("GitHub");
    // The onboarding nav entry is labelled "Setup" (renamed from "Onboarding"
    // so the sidebar label and the page heading no longer drift).
    expect(desktop.container.textContent).toContain("Setup");
    expect(desktop.container.textContent).toContain("GitHub child");
    await act(async () => desktop.root.unmount());

    authMock.value = { ...authMock.value, role: "member", onboardingCompletedAt: NOW };
    viewportMock.value = "narrow";
    const narrow = await renderDom(<SettingsLayout />);
    expect(narrow.container.querySelector("aside")).toBeNull();
    expect(narrow.container.textContent).toContain("Computers");
    expect(narrow.container.textContent).toContain("GitHub");
    expect(narrow.container.textContent).not.toContain("Setup");
    await act(async () => narrow.root.unmount());

    authMock.value = { ...authMock.value, meLoaded: false };
    const unloaded = await renderDom(<SettingsLayout />);
    expect(unloaded.container.textContent).toBe("");
    await act(async () => unloaded.root.unmount());
  });

  it("renders Context Tree binding configuration and keeps manual editing hidden by default", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);

    await waitForText(container, "Repository");
    expect(container.textContent).toContain("Your team's Context Tree");
    expect(container.textContent).toContain("https://github.com/acme/context");
    expect(container.textContent).toContain("branch main");
    expect(container.textContent).toContain("View on the Context page");
    expect(container.textContent).toContain("Context Reviewer");
    expect(container.querySelectorAll<HTMLButtonElement>('[role="tab"]').length).toBe(0);
    expect(container.textContent).not.toContain("Connect your code & build your Context Tree");
    expect(container.textContent).not.toContain("Repo URL");
    expect(container.textContent).not.toContain("Branch");

    await act(async () => root.unmount());
  });

  it("shows and saves manual context tree settings with blank values normalized to null", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Your team's Context Tree");

    await click(buttonByText(container, "Edit"));
    await waitForText(container, "Repo URL");

    const repoInput = inputByLabel(container, "Repo URL");
    const branchInput = inputByLabel(container, "Branch");
    if (!repoInput || !branchInput) throw new Error("Expected context tree inputs");
    expect(repoInput.value).toBe("https://github.com/acme/context");
    expect(branchInput.value).toBe("main");
    await setInputValue(repoInput, "   ");
    await setInputValue(branchInput, "  trunk  ");
    await submit(container.querySelector("form"));

    expect(settingsMocks.putContextTreeSetting).toHaveBeenCalledWith("org-1", { repo: null, branch: "trunk" });
    await waitForCondition(
      () => !container.textContent?.includes("Repo URL"),
      "Expected manual form to close after save",
    );

    settingsMocks.putContextTreeSetting.mockRejectedValueOnce(new Error("context save failed"));
    await click(buttonByText(container, "Edit"));
    await submit(container.querySelector("form"));
    await waitForText(container, "context save failed");

    await act(async () => root.unmount());

    settingsMocks.getContextTreeSetting.mockRejectedValueOnce(new Error("context load failed"));
    const failed = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(failed.container, "context load failed");
    await act(async () => failed.root.unmount());
  });

  it("points a no-tree admin to the Context page and keeps manual binding as an escape hatch", async () => {
    settingsMocks.getContextTreeSetting.mockResolvedValueOnce({ branch: "main" });

    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Your team doesn't have a Context Tree yet.");
    expect(container.textContent).toContain("Set one up on the Context page");
    expect(container.textContent).toContain("Already have a tree repo? Bind it manually");
    expect(container.textContent).not.toContain("Repo URL");
    expect(container.textContent).not.toContain("Branch");
    // No raw initializer and no Settings build button; building lives on the
    // Context page, while Settings only edits an existing binding.
    expect(container.textContent).not.toContain("Create private GitHub repo");
    expect(contextApiMocks.initializeContextTree).not.toHaveBeenCalled();

    await click(buttonByText(container, "Set one up on the Context page"));
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/context");
    expect(contextApiMocks.initializeContextTree).not.toHaveBeenCalled();

    await click(buttonByText(container, "Already have a tree repo? Bind it manually"));
    await waitForText(container, "Repo URL");

    await act(async () => root.unmount());
  });

  it("renders the context tree binding read-only for members", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    authMock.value = { ...authMock.value, role: "member" };
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Your team's Context Tree");

    expect(container.textContent).toContain("https://github.com/acme/context");
    expect(container.textContent).toContain("branch main");
    expect(buttonByText(container, "Edit")).toBeNull();
    expect(container.textContent).toContain("Context Reviewer");
    expect(container.textContent).toContain("Automatic PR review");
    expect(container.textContent).toContain("Off");
    expect(reviewerSwitch(container)).toBeNull();
    expect(container.textContent).not.toContain("Repo URL");
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("shows admin-required copy for members when no context tree repo is configured", async () => {
    settingsMocks.getContextTreeSetting.mockResolvedValueOnce({ branch: "main" });
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    authMock.value = { ...authMock.value, role: "member" };
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Ask an admin to set one up.");
    expect(container.textContent).not.toContain("Create private GitHub repo");
    await act(async () => root.unmount());
  });

  it("renders Context Reviewer settings without resetting manual binding draft values", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Your team's Context Tree");

    await click(buttonByText(container, "Edit"));
    await waitForText(container, "Repo URL");
    const repoInput = inputByLabel(container, "Repo URL");
    if (!repoInput) throw new Error("Expected repo input");
    await setInputValue(repoInput, "https://github.com/acme/draft-context");

    await waitForText(container, "Context Reviewer");
    expect(reviewerSwitch(container)?.getAttribute("aria-checked")).toBe("false");
    expect(settingsMocks.getContextTreeFeaturesSetting).toHaveBeenCalledWith("org-1");
    expect(agentApiMocks.listAllAgents).not.toHaveBeenCalled();
    expect(inputByLabel(container, "Repo URL")?.value).toBe("https://github.com/acme/draft-context");

    await act(async () => root.unmount());
  });

  it("turning the Context Reviewer Switch off saves disabled/null immediately", async () => {
    settingsMocks.getContextTreeFeaturesSetting.mockResolvedValueOnce(
      contextTreeFeatures({ enabled: true, agentUuid: "agent-alpha" }),
    );
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Context Reviewer");
    await waitForText(container, "Alpha Reviewer");
    expect(reviewerSwitch(container)?.getAttribute("aria-checked")).toBe("true");

    await click(reviewerSwitch(container));

    expect(settingsMocks.putContextTreeFeaturesSetting).toHaveBeenCalledWith("org-1", {
      contextReviewer: { enabled: false, agentUuid: null },
    });

    await act(async () => root.unmount());
  });

  it("does not save when flipping the Switch on (no agent) and back off", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Context Reviewer");

    await click(reviewerSwitch(container));
    await waitForText(container, "Reviewer agent");
    await click(reviewerSwitch(container));

    expect(settingsMocks.putContextTreeFeaturesSetting).not.toHaveBeenCalled();
    expect(reviewerSwitch(container)?.getAttribute("aria-checked")).toBe("false");

    await act(async () => root.unmount());
  });

  it("enables Context Reviewer, filters eligible agents, and saves the selected agent", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Context Reviewer");

    await click(reviewerSwitch(container));
    await waitForText(container, "Reviewer agent");
    await waitForCondition(() => agentApiMocks.listAllAgents.mock.calls.length > 0, "Expected agents to load");
    await waitForText(container, "Select an agent to enable Context Reviewer.");

    await selectOption(container, "Alpha Reviewer");
    expect(document.body.textContent).not.toContain("Human User");
    expect(document.body.textContent).not.toContain("Suspended");
    expect(document.body.textContent).not.toContain("Other Org");

    // The pick itself persists — there is no separate Save step.
    expect(settingsMocks.putContextTreeFeaturesSetting).toHaveBeenCalledWith("org-1", {
      contextReviewer: { enabled: true, agentUuid: "agent-alpha" },
    });

    await act(async () => root.unmount());
  });

  it("initializes an already saved Context Reviewer selection", async () => {
    settingsMocks.getContextTreeFeaturesSetting.mockResolvedValueOnce(
      contextTreeFeatures({ enabled: true, agentUuid: "agent-beta" }),
    );
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Context Reviewer");

    await waitForText(container, "Beta Reviewer");
    expect(reviewerSwitch(container)?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Beta Reviewer");

    await act(async () => root.unmount());
  });

  it("loads all admin agent pages before deciding whether the saved reviewer is available", async () => {
    settingsMocks.getContextTreeFeaturesSetting.mockResolvedValueOnce(
      contextTreeFeatures({ enabled: true, agentUuid: "agent-late-page" }),
    );
    agentApiMocks.listAllAgents
      .mockResolvedValueOnce(
        paginatedAgents(
          [
            managedAgent({ uuid: "human-page-one", displayName: "Human Page One", type: "human" }),
            managedAgent({ uuid: "suspended-page-one", displayName: "Suspended Page One", status: "suspended" }),
          ],
          "older",
        ),
      )
      .mockResolvedValueOnce(
        paginatedAgents([
          managedAgent({ uuid: "agent-late-page", displayName: "Late Page Reviewer", name: "late-reviewer" }),
        ]),
      );
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Context Reviewer");

    await waitForText(container, "Late Page Reviewer");
    expect(agentApiMocks.listAllAgents).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(agentApiMocks.listAllAgents).toHaveBeenNthCalledWith(2, { limit: 100, cursor: "older" });
    expect(container.textContent).not.toContain("No active non-human agents are available.");
    expect(container.textContent).not.toContain("Current reviewer is not an active organization agent.");
    expect(reviewerSwitch(container)?.getAttribute("aria-checked")).toBe("true");

    await act(async () => root.unmount());
  });

  it("shows the empty state and saves nothing when no eligible agents exist", async () => {
    agentApiMocks.listAllAgents.mockResolvedValueOnce(
      paginatedAgents([
        managedAgent({ uuid: "human-only", displayName: "Only Human", type: "human" }),
        managedAgent({ uuid: "suspended-only", displayName: "Only Suspended", status: "suspended" }),
      ]),
    );
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Context Reviewer");

    await click(reviewerSwitch(container));
    await waitForText(container, "No active non-human agents are available.");
    expect(reviewerSwitch(container)?.getAttribute("aria-checked")).toBe("true");
    expect(settingsMocks.putContextTreeFeaturesSetting).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("shows a saved Context Reviewer managed by another admin", async () => {
    settingsMocks.getContextTreeFeaturesSetting.mockResolvedValueOnce(
      contextTreeFeatures({ enabled: true, agentUuid: "agent-other-admin" }),
    );
    agentApiMocks.listAllAgents.mockResolvedValueOnce(
      paginatedAgents([
        managedAgent({
          uuid: "agent-other-admin",
          displayName: "Other Admin Reviewer",
          name: "other-admin-reviewer",
        }),
      ]),
    );
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Context Reviewer");

    await waitForText(container, "Other Admin Reviewer");
    expect(container.textContent).not.toContain("Current reviewer is not your active agent.");
    expect(reviewerSwitch(container)?.getAttribute("aria-checked")).toBe("true");

    await act(async () => root.unmount());
  });

  it("shows Context Reviewer read-only status for members", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    authMock.value = { ...authMock.value, role: "member" };
    settingsMocks.getContextTreeFeaturesSetting.mockResolvedValueOnce(
      contextTreeFeatures({
        enabled: true,
        agentUuid: "agent-reviewer",
        reviewerAgent: { uuid: "agent-reviewer", name: "context-reviewer", displayName: "Context Reviewer Bot" },
      }),
    );
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);

    await waitForText(container, "Your team's Context Tree");
    await waitForText(container, "Context Reviewer Bot");
    expect(container.textContent).toContain("Automatic PR review");
    expect(container.textContent).toContain("On");
    expect(settingsMocks.getContextTreeFeaturesSetting).toHaveBeenCalledWith("org-1");
    expect(settingsMocks.putContextTreeFeaturesSetting).not.toHaveBeenCalled();
    expect(agentApiMocks.listAllAgents).not.toHaveBeenCalled();
    expect(reviewerSwitch(container)).toBeNull();
    expect(container.querySelector('[aria-label="Context Reviewer agent"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("does not expose raw reviewer UUID to members when the reviewer summary is unavailable", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    authMock.value = { ...authMock.value, role: "member" };
    settingsMocks.getContextTreeFeaturesSetting.mockResolvedValueOnce(
      contextTreeFeatures({ enabled: true, agentUuid: "agent-deleted", reviewerAgent: null }),
    );
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);

    await waitForText(container, "Configured reviewer is no longer available.");
    expect(container.textContent).toContain("Automatic PR review");
    expect(container.textContent).toContain("On");
    expect(container.textContent).not.toContain("agent-deleted");
    expect(agentApiMocks.listAllAgents).not.toHaveBeenCalled();
    expect(reviewerSwitch(container)).toBeNull();
    expect(container.querySelector('[aria-label="Context Reviewer agent"]')).toBeNull();

    await act(async () => root.unmount());
  });
});
