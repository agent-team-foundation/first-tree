// @vitest-environment happy-dom

import type { Organization, OrgContextTreeOutput, OrgSourceReposOutput } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
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

const orgMocks = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => ({
  getContextTreeSetting: vi.fn(),
  getSourceReposSetting: vi.fn(),
  putContextTreeSetting: vi.fn(),
  putSourceReposSetting: vi.fn(),
}));

const viewportMock = vi.hoisted(() => ({
  value: "xl" as "xl" | "md" | "narrow",
}));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../api/organizations.js", () => orgMocks);

vi.mock("../../api/org-settings.js", () => settingsMocks);

vi.mock("../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => viewportMock.value,
}));

const NOW = "2026-05-28T12:00:00.000Z";

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: overrides.id ?? "org-1",
    name: overrides.name ?? "acme",
    displayName: overrides.displayName ?? "Acme",
    maxAgents: overrides.maxAgents ?? 0,
    maxMessagesPerMinute: overrides.maxMessagesPerMinute ?? 0,
    features: overrides.features ?? {},
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

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
  route = "/settings/team",
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
              <Route path="team" element={<div>Settings child</div>} />
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

async function renderPanel(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={createClient()}>{element}</QueryClientProvider>);
  });
  await flush();
  return { container, root };
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

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { role: "admin", organizationId: "org-1", onboardingCompletedAt: null, meLoaded: true };
  viewportMock.value = "xl";
  orgMocks.getOrganization.mockResolvedValue(organization());
  orgMocks.updateOrganization.mockImplementation(async (_id: string, patch: Partial<Organization>) =>
    organization({ ...patch, updatedAt: "2026-05-28T12:01:00.000Z" }),
  );
  settingsMocks.getContextTreeSetting.mockResolvedValue(contextTree());
  settingsMocks.putContextTreeSetting.mockImplementation(async (_id: string, body: Partial<OrgContextTreeOutput>) =>
    contextTree(body),
  );
  settingsMocks.getSourceReposSetting.mockResolvedValue(sourceRepos());
  settingsMocks.putSourceReposSetting.mockImplementation(async (_id: string, body: Partial<OrgSourceReposOutput>) =>
    sourceRepos(body),
  );
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
    expect(desktop.container.textContent).toContain("Onboarding");
    expect(desktop.container.textContent).toContain("GitHub child");
    await act(async () => desktop.root.unmount());

    authMock.value = { ...authMock.value, role: "member", onboardingCompletedAt: NOW };
    viewportMock.value = "narrow";
    const narrow = await renderDom(<SettingsLayout />);
    expect(narrow.container.querySelector("aside")).toBeNull();
    expect(narrow.container.textContent).toContain("Computers");
    expect(narrow.container.textContent).not.toContain("GitHub");
    expect(narrow.container.textContent).not.toContain("Onboarding");
    await act(async () => narrow.root.unmount());

    authMock.value = { ...authMock.value, meLoaded: false };
    const unloaded = await renderDom(<SettingsLayout />);
    expect(unloaded.container.textContent).toBe("");
    await act(async () => unloaded.root.unmount());
  });

  it("loads and saves team identity, including unchanged and error paths", async () => {
    const { TeamIdentityPanel } = await import("../team-identity-panel.js");
    const { container, root } = await renderPanel(<TeamIdentityPanel />);
    await waitForCondition(
      () => container.querySelector<HTMLInputElement>("input")?.value === "Acme",
      "Expected team identity input to load",
    );

    await submit(container.querySelector("form"));
    expect(orgMocks.updateOrganization).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Saved");

    const input = container.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Identity input missing");
    await setInputValue(input, "  Acme Labs  ");
    await submit(container.querySelector("form"));
    expect(orgMocks.updateOrganization).toHaveBeenCalledWith("org-1", { displayName: "Acme Labs" });

    orgMocks.updateOrganization.mockRejectedValueOnce(new Error("rename failed"));
    await setInputValue(input, "Broken");
    await submit(container.querySelector("form"));
    await waitForText(container, "rename failed");

    await act(async () => root.unmount());

    orgMocks.getOrganization.mockRejectedValueOnce(new Error("load org failed"));
    const failed = await renderPanel(<TeamIdentityPanel />);
    await waitForText(failed.container, "load org failed");
    await act(async () => failed.root.unmount());
  });

  it("loads and saves context tree settings with blank values normalized to null", async () => {
    const { ContextTreeSettingsPanel } = await import("../context-tree-settings-panel.js");
    const { container, root } = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(container, "Context tree");

    const inputs = container.querySelectorAll<HTMLInputElement>("input");
    const repoInput = inputs[0];
    const branchInput = inputs[1];
    if (!repoInput || !branchInput) throw new Error("Expected context tree inputs");
    await setInputValue(repoInput, "   ");
    await setInputValue(branchInput, "  trunk  ");
    await submit(container.querySelector("form"));

    expect(settingsMocks.putContextTreeSetting).toHaveBeenCalledWith("org-1", { repo: null, branch: "trunk" });
    expect(container.textContent).toContain("Saved");

    settingsMocks.putContextTreeSetting.mockRejectedValueOnce(new Error("context save failed"));
    await submit(container.querySelector("form"));
    await waitForText(container, "context save failed");

    await act(async () => root.unmount());

    settingsMocks.getContextTreeSetting.mockRejectedValueOnce(new Error("context load failed"));
    const failed = await renderPanel(<ContextTreeSettingsPanel />);
    await waitForText(failed.container, "context load failed");
    await act(async () => failed.root.unmount());
  });

  it("renders legacy source repos as a read-only compatibility panel", async () => {
    const { SourceReposSettingsPanel } = await import("../source-repos-settings-panel.js");
    const { container, root } = await renderPanel(<SourceReposSettingsPanel />);
    await waitForText(container, "https://github.com/acme/web");
    expect(container.textContent).toContain("branch: main");
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("Manage active repo resources from Team Resources");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => root.unmount());

    authMock.value = { ...authMock.value, role: "member" };
    const member = await renderPanel(<SourceReposSettingsPanel />);
    await waitForText(member.container, "Team Resources");
    expect(member.container.querySelector("button")).toBeNull();
    await act(async () => member.root.unmount());

    settingsMocks.getSourceReposSetting.mockResolvedValueOnce(sourceRepos({ repos: [] }));
    const empty = await renderPanel(<SourceReposSettingsPanel />);
    await waitForText(empty.container, "No source repos bound yet.");
    await act(async () => empty.root.unmount());

    settingsMocks.getSourceReposSetting.mockRejectedValueOnce(new Error("source load failed"));
    const failed = await renderPanel(<SourceReposSettingsPanel />);
    await waitForText(failed.container, "source load failed");
    await act(async () => failed.root.unmount());
  });
});
