// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../auth/auth-context.js";
import type { AgentDetailContext } from "../layout-context.js";
import { RepositoriesTab } from "../repositories-tab.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const resourceMocks = vi.hoisted(() => ({
  useAgentResources: vi.fn(),
}));
const orgSettingMocks = vi.hoisted(() => ({
  getContextTreeSetting: vi.fn(),
}));

vi.mock("../capability-section.js", () => ({
  useAgentResources: resourceMocks.useAgentResources,
  ResourceTypeSection: ({
    canEdit,
    pending,
    saved,
    onNavigateAway,
  }: {
    canEdit: boolean;
    pending: boolean;
    saved: boolean;
    onNavigateAway: (to: string) => void;
  }) => (
    <div data-testid="resource-section">
      resources {canEdit ? "editable" : "read-only"} {pending ? "pending" : "idle"} {saved ? "saved" : "unsaved"}
      <button type="button" onClick={() => onNavigateAway("/settings/resources")}>
        Leave repositories
      </button>
    </div>
  ),
}));
vi.mock("../../../api/org-settings.js", () => orgSettingMocks);

const roots: Root[] = [];

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function baseContext(overrides: Partial<AgentDetailContext> = {}): AgentDetailContext {
  return {
    uuid: "agent-1",
    agent: {
      id: "agent-1",
      name: "build-agent",
      status: "active",
      type: "agent",
    } as unknown as AgentDetailContext["agent"],
    isHuman: false,
    canManageAgent: true,
    canEditConfig: true,
    navigateAway: vi.fn(),
    config: undefined,
    configLoading: false,
    configError: null,
    configSave: {} as AgentDetailContext["configSave"],
    clientStatus: undefined,
    clientStatusLoading: false,
    clientStatusError: null,
    isUnclaimed: false,
    isOffline: false,
    boundClientLabel: null,
    setupRuntimeProvider: "codex",
    runtimeSwitchClaim: null,
    onOpenBindDialog: vi.fn(),
    bindClientPending: false,
    onOpenRuntimeSwitchDialog: vi.fn(),
    runtimeSwitchPending: false,
    runtimeSwitchRecoveryPending: false,
    runtimeSwitchRecoveryError: null,
    onRecoverRuntimeSwitch: vi.fn(),
    saveIdentity: vi.fn(),
    refreshAgent: vi.fn(),
    suspendPending: false,
    reactivatePending: false,
    deletePending: false,
    dangerError: null,
    onSuspend: vi.fn(),
    onReactivate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

async function renderTab({
  context = baseContext(),
  organizationId = "org-1",
  initialEntry = "/agents/agent-1/repositories",
}: {
  context?: AgentDetailContext;
  organizationId?: string | null;
  initialEntry?: string;
} = {}): Promise<{ container: HTMLElement; context: AgentDetailContext }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const authValue = {
    organizationId,
  } as unknown as Parameters<typeof AuthContext.Provider>[0]["value"];
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthContext.Provider value={authValue}>
          <Routes>
            <Route path="/agents/:uuid" element={<Outlet context={context} />}>
              <Route path="repositories" element={<RepositoriesTab />} />
              <Route path="profile" element={<div>Profile tab</div>} />
            </Route>
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => {
    root.render(ui);
  });
  await flush();
  return { container, context };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  resourceMocks.useAgentResources.mockReturnValue({
    data: { bindings: [] },
    error: null,
    isLoading: false,
    justSaved: false,
    mutateBindings: vi.fn(),
    pending: false,
    saveError: null,
  });
  orgSettingMocks.getContextTreeSetting.mockResolvedValue({
    repo: "https://github.com/acme/context-tree.git",
    branch: "main",
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("RepositoriesTab", () => {
  it("redirects non-editors back to the profile tab without loading resources", async () => {
    const context = baseContext({ canEditConfig: false });

    const { container } = await renderTab({ context });

    expect(container.textContent).toContain("Profile tab");
    expect(resourceMocks.useAgentResources).toHaveBeenCalledWith("agent-1", { enabled: false });
  });

  it("renders the repository section and configured context tree row", async () => {
    const navigateAway = vi.fn();
    const { container } = await renderTab({ context: baseContext({ navigateAway }) });

    expect(container.querySelector('[data-testid="resource-section"]')?.textContent).toContain("resources editable");
    await waitForText(container, "context-tree");
    expect(container.textContent).toContain("acme/context-tree");

    await click(container.querySelector("button"));
    expect(navigateAway).toHaveBeenCalledWith("/settings/resources");
  });

  it("renders loading, fetch errors, save errors, and context-tree empty/error states", async () => {
    resourceMocks.useAgentResources.mockReturnValueOnce({
      data: null,
      error: null,
      isLoading: true,
      justSaved: false,
      mutateBindings: vi.fn(),
      pending: false,
      saveError: null,
    });
    const loading = await renderTab();
    expect(loading.container.textContent).toContain("Loading repositories");

    resourceMocks.useAgentResources.mockReturnValueOnce({
      data: null,
      error: new Error("repo load failed"),
      isLoading: false,
      justSaved: false,
      mutateBindings: vi.fn(),
      pending: false,
      saveError: new Error("repo save failed"),
    });
    orgSettingMocks.getContextTreeSetting.mockResolvedValueOnce({ repo: null, branch: null });
    const failed = await renderTab();
    expect(failed.container.textContent).toContain("repo load failed");
    expect(failed.container.textContent).toContain("repo save failed");
    await waitForText(failed.container, "Not configured");

    orgSettingMocks.getContextTreeSetting.mockRejectedValueOnce(new Error("context failed"));
    const contextFailed = await renderTab({ organizationId: "org-2" });
    await waitForText(contextFailed.container, "Couldn't load context tree.");

    const noOrg = await renderTab({ organizationId: null });
    expect(noOrg.container.textContent).toContain("Loading");
  });
});

async function waitForText(container: ParentNode, text: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text: ${text}`);
}
