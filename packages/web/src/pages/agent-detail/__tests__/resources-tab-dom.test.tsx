// @vitest-environment happy-dom

import type { Agent, AgentResourcesOutput, AgentRuntimeConfig } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigRow, ConfigTableHeader } from "../flat-section.js";
import type { AgentDetailContext } from "../layout-context.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const agentResourceMocks = vi.hoisted(() => ({
  getAgentResources: vi.fn(),
  updateAgentResources: vi.fn(),
}));

vi.mock("../../../api/agent-resources.js", () => agentResourceMocks);

let root: Root | null = null;

const NOW = "2026-05-31T00:00:00.000Z";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-1",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "inbox-1",
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function config(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    payload: {
      kind: "claude-code",
      prompt: { append: "" },
      model: "sonnet",
      reasoningEffort: "medium",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    },
    updatedAt: NOW,
    updatedBy: "member-1",
  };
}

function agentResources(overrides: Partial<AgentResourcesOutput> = {}): AgentResourcesOutput {
  return {
    version: overrides.version ?? 3,
    effective: overrides.effective ?? {
      version: overrides.version ?? 3,
      repos: [],
      prompts: [],
      skills: [],
      mcp: [],
      unavailable: [],
    },
    bindings: overrides.bindings ?? [],
    availableTeamResources: overrides.availableTeamResources ?? [],
  };
}

function context(overrides: Partial<AgentDetailContext> = {}): AgentDetailContext {
  return {
    uuid: "agent-1",
    agent: agent(overrides.agent),
    isHuman: false,
    canManageAgent: true,
    canEditConfig: true,
    navigateAway: vi.fn(),
    config: config(),
    configLoading: false,
    configError: null,
    configSave: {
      save: vi.fn(),
      pending: false,
      saveError: null,
      conflict: false,
      errorField: null,
      justSaved: false,
      savedField: null,
    },
    clientStatus: undefined,
    clientStatusLoading: false,
    clientStatusError: null,
    isUnclaimed: false,
    isOffline: false,
    boundClientLabel: "gandy-macbook",
    setupRuntimeProvider: "claude-code",
    onOpenBindDialog: vi.fn(),
    bindClientPending: false,
    onOpenRuntimeSwitchDialog: vi.fn(),
    runtimeSwitchPending: false,
    runtimeSwitchClaim: null,
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

async function renderWithContext(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/agents/agent-1/resources"]}>
          <Routes>
            <Route path="/agents/:uuid" element={<Outlet />}>
              <Route path="resources" element={element} />
              <Route path="profile" element={<div>Profile redirect</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

async function renderElement(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  await flush();
  return container;
}

// Render a presentational element that only needs a Router (e.g. ResourceTypeSection,
// whose add menu uses useNavigate) — no outlet context or QueryClient required.
async function renderRouted(element: ReactElement): Promise<HTMLElement> {
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

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  agentResourceMocks.getAgentResources.mockResolvedValue(agentResources());
  agentResourceMocks.updateAgentResources.mockImplementation(async (_uuid: string, input: { bindings: unknown[] }) =>
    agentResources({ version: 4, bindings: input.bindings as AgentResourcesOutput["bindings"] }),
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("ResourcesTab", () => {
  it("renders read-only resources for non-managers and nothing for human agents", async () => {
    const layoutMocks = await import("../layout-context.js");
    const spy = vi.spyOn(layoutMocks, "useAgentDetailContext");
    const { ResourcesTab } = await import("../resources-tab.js");

    spy.mockReturnValue(context({ canEditConfig: false, canManageAgent: false }));
    let container = await renderWithContext(<ResourcesTab />);
    await waitForText(container, "Integrations (MCP)");
    expect(container.textContent).toContain("Skills");
    expect(container.textContent).toContain("Integrations (MCP)");
    // Code repositories moved to the Environment tab — not on Tools & skills.
    expect(container.textContent).not.toContain("Repositories");
    expect(container.textContent).not.toContain("Agent repo");

    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    spy.mockReturnValue(context({ agent: agent({ type: "human", clientId: null }), isHuman: true }));
    container = await renderWithContext(<ResourcesTab />);
    expect(container.textContent).toBe("");
  });

  it("renders resource sections and enables available team resources", async () => {
    const layoutMocks = await import("../layout-context.js");
    const spy = vi.spyOn(layoutMocks, "useAgentDetailContext");
    spy.mockReturnValue(context());
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: {
          version: 3,
          repos: [
            {
              id: "resource:repo-1",
              bindingId: null,
              resourceId: "repo-1",
              replacesResourceId: null,
              type: "repo",
              name: "Team repo",
              scope: "team",
              source: "team_recommended",
              mode: "enabled",
              defaultEnabled: "recommended",
              payload: { url: "https://github.com/acme/web.git" },
              repo: { url: "https://github.com/acme/web.git", localPath: "web" },
              promptBody: null,
              unavailableReason: null,
              order: 0,
            },
          ],
          prompts: [],
          skills: [],
          mcp: [],
          unavailable: [],
        },
        availableTeamResources: [
          {
            id: "skill-available",
            organizationId: "org-1",
            type: "skill",
            scope: "team",
            ownerAgentId: null,
            name: "Available skill",
            repoCanonicalKey: null,
            defaultEnabled: "available",
            status: "active",
            payload: { name: "Available skill", description: "A skill.", body: "Do the thing.", metadata: {} },
            createdBy: "member-1",
            updatedBy: "member-1",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    );
    const { ResourcesTab } = await import("../resources-tab.js");

    const container = await renderWithContext(<ResourcesTab />);
    await waitForText(container, "Skills");

    expect(container.textContent).toContain("Skills");
    expect(container.textContent).toContain("Integrations (MCP)");
    expect(container.textContent).not.toContain("Prompts");
    // Repos are not on this tab anymore (they moved to Environment).
    expect(container.textContent).not.toContain("Repositories");
    expect(container.textContent).not.toContain("Team repo");
    // Each editable section gets a quiet "+" add control (aria "Add <Type>").
    expect(container.querySelector('button[aria-label="Add Skill"]')).toBeTruthy();

    // Enable an opt-in team skill via the skill section's add menu. The menu
    // panel portals to document.body, so query the item there.
    await click(container.querySelector('button[aria-label="Add Skill"]'));
    await click(buttonByText(document.body, "Available skill"));
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 3,
      bindings: [{ type: "skill", mode: "include", resourceId: "skill-available", order: 1 }],
    });
  });

  it("renders the repo section (Environment) with rows and an actionable add menu", async () => {
    const { ResourceTypeSection } = await import("../capability-section.js");
    const onNavigateAway = vi.fn();
    // An enabled team repo to render, plus a legacy team repo still flagged
    // Opt-in (available). Team repos are now always On by default, so the opt-in
    // one must NOT be offered as an "enable from team" option.
    const data = agentResources({
      effective: {
        version: 3,
        repos: [
          {
            id: "resource:repo-1",
            bindingId: null,
            resourceId: "repo-1",
            replacesResourceId: null,
            type: "repo",
            name: "Team repo",
            scope: "team",
            source: "team_recommended",
            mode: "enabled",
            defaultEnabled: "recommended",
            payload: { url: "https://github.com/acme/web.git" },
            repo: { url: "https://github.com/acme/web.git", localPath: "web" },
            promptBody: null,
            unavailableReason: null,
            order: 0,
          },
        ],
        prompts: [],
        skills: [],
        mcp: [],
        unavailable: [],
      },
      availableTeamResources: [
        {
          id: "repo-available",
          organizationId: "org-1",
          type: "repo",
          scope: "team",
          ownerAgentId: null,
          name: "Opt-in repo",
          repoCanonicalKey: null,
          defaultEnabled: "available",
          status: "active",
          payload: { url: "https://github.com/acme/optin.git" },
          createdBy: "member-1",
          updatedBy: "member-1",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });

    const container = await renderRouted(
      <ResourceTypeSection
        type="repo"
        data={data}
        canEdit
        pending={false}
        onMutate={vi.fn()}
        onNavigateAway={onNavigateAway}
      />,
    );

    expect(container.textContent).toContain("Repositories");
    expect(container.textContent).toContain("Team repo");
    // Repo peek is the compact `owner/repo` coordinate (default branch + derived
    // path are omitted), not the full clone URL.
    expect(container.textContent).toContain("acme/web");
    expect(container.textContent).not.toContain("https://github.com/acme/web.git");
    expect(container.querySelector('button[aria-label="Add Repo"]')).toBeTruthy();

    // Open the repo section's add menu (panel portals to document.body).
    await click(container.querySelector('button[aria-label="Add Repo"]'));
    // The opt-in repo is not enableable, and there's no "Enable from team" list…
    expect(buttonByText(document.body, "Opt-in repo")).toBeNull();
    expect(document.body.textContent).not.toContain("Enable from team");
    // …but the menu stays actionable: add a private repo or jump to the
    // provider-neutral Team code-access area in Settings. Skill/MCP/prompt
    // menus keep the Resources destination.
    expect(buttonByText(document.body, "Add agent repo")).toBeTruthy();
    await click(buttonByText(document.body, "Manage Team code access"));
    expect(onNavigateAway).toHaveBeenCalledWith("/settings/integrations/github#code-access");
    expect(buttonByText(document.body, "Manage in Settings → Resources")).toBeNull();
  });

  it("agent repo dialog aligns with Settings: no Name field; normalizes URL + derives the name", async () => {
    const { ResourceTypeSection } = await import("../capability-section.js");
    const data = agentResources({
      effective: { version: 1, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      availableTeamResources: [],
    });
    const onMutate = vi.fn();
    const container = await renderRouted(
      <ResourceTypeSection type="repo" data={data} canEdit pending={false} onMutate={onMutate} />,
    );
    await click(container.querySelector('button[aria-label="Add Repo"]'));
    await click(buttonByText(document.body, "Add agent repo"));
    // Two fields only — URL + Default branch — no Name (matches Settings → Resources).
    expect(document.getElementById("agent-repo-url")).toBeTruthy();
    expect(document.getElementById("agent-repo-name")).toBeNull();
    const url = document.getElementById("agent-repo-url");
    if (!(url instanceof HTMLInputElement)) throw new Error("Expected url input");
    await setInputValue(url, "github.com/acme/web");
    const addBtn = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add") ?? null;
    await click(addBtn);
    // Scheme-less URL normalized, name derived from it, no Name field was asked.
    expect(onMutate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: "repo",
          mode: "include",
          agentExtraRepo: { url: "https://github.com/acme/web", name: "web" },
        }),
      ]),
    );
  });

  it("keeps the MCP add menu actionable with no team MCP (routes to Settings, no dead end)", async () => {
    const layoutMocks = await import("../layout-context.js");
    const spy = vi.spyOn(layoutMocks, "useAgentDetailContext");
    spy.mockReturnValue(context());
    // Default fixtures: empty effective MCP + no available team resources.
    const { ResourcesTab } = await import("../resources-tab.js");

    const container = await renderWithContext(<ResourcesTab />);
    await waitForText(container, "Integrations (MCP)");

    // The MCP section is empty and the team offers nothing to enable — but the
    // "+" (Add MCP) menu must still be actionable: it explains the source and
    // routes to Settings → Resources instead of leaving a dead end.
    await click(container.querySelector('button[aria-label="Add MCP"]'));
    expect(document.body.textContent).toContain("No team MCP integrations to enable yet");
    expect(document.body.textContent).toContain("Manage in Settings → Resources");
  });

  it("disables a recommended skill via its Switch (off = disable binding)", async () => {
    const { ResourceTypeSection } = await import("../capability-section.js");
    const onMutate = vi.fn();
    const data = agentResources({
      effective: {
        version: 3,
        repos: [],
        prompts: [],
        mcp: [],
        unavailable: [],
        skills: [
          {
            id: "resource:skill-1",
            bindingId: null,
            resourceId: "skill-1",
            replacesResourceId: null,
            type: "skill",
            name: "Team skill",
            scope: "team",
            source: "team_recommended",
            mode: "enabled",
            defaultEnabled: "recommended",
            payload: { name: "Team skill", description: "Does things.", body: "Do it.", metadata: {} },
            repo: null,
            promptBody: null,
            unavailableReason: null,
            order: 0,
          },
        ],
      },
    });

    const container = await renderRouted(
      <ResourceTypeSection type="skill" data={data} canEdit pending={false} onMutate={onMutate} />,
    );
    const sw = container.querySelector('button[role="switch"]');
    expect(sw?.getAttribute("aria-checked")).toBe("true");
    await click(sw);
    expect(onMutate).toHaveBeenCalledWith([{ type: "skill", mode: "disable", resourceId: "skill-1", order: 1 }]);
  });

  it("removes an opted-in skill via the ⋯ overflow menu (no Switch)", async () => {
    const { ResourceTypeSection } = await import("../capability-section.js");
    const onMutate = vi.fn();
    const data = agentResources({
      bindings: [{ id: "skill-binding-1", type: "skill", mode: "include", resourceId: "skill-1", order: 1 }],
      effective: {
        version: 3,
        repos: [],
        prompts: [],
        mcp: [],
        unavailable: [],
        skills: [
          {
            id: "binding:skill-binding-1:enabled",
            bindingId: "skill-binding-1",
            resourceId: "skill-1",
            replacesResourceId: null,
            type: "skill",
            name: "Opt-in skill",
            scope: "team",
            source: "team_available",
            mode: "enabled",
            defaultEnabled: "available",
            payload: { name: "Opt-in skill", description: "Optional.", body: "Maybe.", metadata: {} },
            repo: null,
            promptBody: null,
            unavailableReason: null,
            order: 1,
          },
        ],
      },
    });

    const container = await renderRouted(
      <ResourceTypeSection type="skill" data={data} canEdit pending={false} onMutate={onMutate} />,
    );
    // Opt-in resources are present-or-removed — no Switch, just ⋯ Remove.
    expect(container.querySelector('button[role="switch"]')).toBeNull();
    await click(container.querySelector('button[aria-label="More actions for Opt-in skill"]'));
    await click(buttonByText(container, "Remove Opt-in skill"));
    expect(onMutate).toHaveBeenCalledWith([]);
  });

  it("shows a disabled Switch and a Can't load badge for an unavailable recommended skill", async () => {
    const { ResourceTypeSection } = await import("../capability-section.js");
    const data = agentResources({
      effective: {
        version: 3,
        repos: [],
        prompts: [],
        mcp: [],
        unavailable: [],
        skills: [
          {
            id: "resource:skill-x",
            bindingId: null,
            resourceId: "skill-x",
            replacesResourceId: null,
            type: "skill",
            name: "Broken skill",
            scope: "team",
            source: "team_recommended",
            mode: "unavailable",
            defaultEnabled: "recommended",
            payload: null,
            repo: null,
            promptBody: null,
            unavailableReason: "Skill failed to load.",
            order: 0,
          },
        ],
      },
    });

    const container = await renderRouted(
      <ResourceTypeSection type="skill" data={data} canEdit pending={false} onMutate={vi.fn()} />,
    );
    expect(container.textContent).toContain("Can't load");
    const sw = container.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(sw?.disabled).toBe(true);
  });

  it("renders flat-section row primitives", async () => {
    const row = await renderElement(
      <div>
        <ConfigRow
          label="Danger row"
          value="value"
          description="visible help"
          helpText="hover help"
          meta={<span>meta</span>}
          action={<button type="button">act</button>}
          icon={<span>icon</span>}
          danger
        />
        <ConfigRow label="Child row" helpText="child help">
          <input aria-label="child input" />
        </ConfigRow>
        <ConfigTableHeader columns={["Key", "Value"]} template="1fr 2fr" />
      </div>,
    );

    expect(row.textContent).toContain("Danger row");
    expect(row.textContent).toContain("visible help");
    expect(row.textContent).toContain("meta");
    expect(row.querySelector('[aria-label="hover help"]')).toBeTruthy();
    expect(row.querySelector('[aria-label="child help"]')).toBeTruthy();
    expect(row.textContent).toContain("Key");
    expect(row.textContent).toContain("Value");
  });
});
