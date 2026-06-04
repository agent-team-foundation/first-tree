// @vitest-environment happy-dom

import type { Agent, AgentResourcesOutput, AgentRuntimeConfig } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigRow, ConfigTableHeader } from "../flat-section.js";
import type { AgentDetailContext } from "../layout-context.js";
import { dirtySummaryLabel, SaveBar } from "../save-bar.js";
import type { DraftListItem, DraftSummary, UseConfigDraftResult } from "../use-config-draft.js";

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
    name: overrides.name ?? "kael",
    displayName: overrides.displayName ?? "Kael",
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

function listItem<T>(key: string, value: T, status: DraftListItem<T>["status"] = "unchanged"): DraftListItem<T> {
  return {
    key,
    value,
    baseline: status === "added" ? null : value,
    status,
  };
}

function summary(dirtySections: DraftSummary["dirtySections"] = []): DraftSummary {
  return {
    anyDirty: dirtySections.length > 0,
    dirtySections,
    counts: {
      model: dirtySections.includes("model") ? 1 : 0,
      effort: dirtySections.includes("effort") ? 1 : 0,
      mcp: dirtySections.includes("mcp") ? 1 : 0,
      env: dirtySections.includes("env") ? 1 : 0,
      git: dirtySections.includes("git") ? 1 : 0,
    },
  };
}

function draft(overrides: Partial<UseConfigDraftResult> = {}): UseConfigDraftResult {
  return {
    draft: {
      model: "sonnet",
      reasoningEffort: "medium",
      mcp: [],
      env: [
        listItem("env-1", { key: "OPENAI_API_KEY", value: "secret", sensitive: true }),
        listItem("env-2", { key: "DELETED_KEY", value: "gone", sensitive: false }, "deleted"),
      ],
      git: [
        listItem("git-1", { url: "https://github.com/acme/web.git" }),
        listItem("git-2", { url: "https://github.com/acme/api?ref=main" }),
        listItem("git-3", { url: "https://github.com/acme/tools", localPath: "custom-tools" }, "deleted"),
      ],
    },
    summary: summary(["env", "git"]),
    modelDirty: false,
    reasoningEffortDirty: false,
    setModel: vi.fn(),
    revertModel: vi.fn(),
    setReasoningEffort: vi.fn(),
    revertReasoningEffort: vi.fn(),
    addMcp: vi.fn(),
    updateMcp: vi.fn(),
    deleteMcp: vi.fn(),
    undoDeleteMcp: vi.fn(),
    addEnv: vi.fn(),
    updateEnv: vi.fn(),
    deleteEnv: vi.fn(),
    undoDeleteEnv: vi.fn(),
    addGit: vi.fn(),
    updateGit: vi.fn(),
    deleteGit: vi.fn(),
    undoDeleteGit: vi.fn(),
    resetAll: vi.fn(),
    resetToConfig: vi.fn(),
    buildPayloadPatch: vi.fn(),
    ...overrides,
  };
}

function context(overrides: Partial<AgentDetailContext> = {}): AgentDetailContext {
  return {
    uuid: "agent-1",
    agent: agent(overrides.agent),
    isHuman: false,
    canManageAgent: true,
    canEditConfig: true,
    draft: draft(overrides.draft),
    config: config(),
    configLoading: false,
    configError: null,
    clientStatus: undefined,
    clientStatusLoading: false,
    clientStatusError: null,
    isUnclaimed: false,
    isOffline: false,
    boundClientLabel: "gandy-macbook",
    setupRuntimeProvider: "claude-code",
    onOpenBindDialog: vi.fn(),
    onOpenRebindDialog: vi.fn(),
    bindClientPending: false,
    saveIdentity: vi.fn(),
    refreshAgent: vi.fn(),
    suspendPending: false,
    reactivatePending: false,
    deletePending: false,
    dangerError: null,
    onSuspend: vi.fn(),
    onReactivate: vi.fn(),
    onDelete: vi.fn(),
    dryRunText: "dry run diff",
    dryRunPending: false,
    onRunDryRun: vi.fn(),
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

describe("ResourcesTab and SaveBar", () => {
  it("renders read-only resources for non-managers and nothing for human agents", async () => {
    const layoutMocks = await import("../layout-context.js");
    const spy = vi.spyOn(layoutMocks, "useAgentDetailContext");
    const { ResourcesTab } = await import("../resources-tab.js");

    spy.mockReturnValue(context({ canEditConfig: false, canManageAgent: false }));
    let container = await renderWithContext(<ResourcesTab />);
    await waitForText(container, "Code repositories");
    expect(container.textContent).toContain("Code repositories");
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
    await waitForText(container, "Code repositories");

    expect(container.textContent).toContain("Code repositories");
    expect(container.textContent).toContain("Skills");
    expect(container.textContent).not.toContain("Prompts");
    expect(container.textContent).toContain("Team repo");
    expect(container.textContent).toContain("https://github.com/acme/web.git -> web");
    expect(container.textContent).toContain("Agent repo");

    await click(buttonByText(container, "Enable Available skill"));
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 3,
      bindings: [{ type: "skill", mode: "include", resourceId: "skill-available", order: 1 }],
    });
  });

  it("renders SaveBar saved, error, conflict, saving, and jump actions", async () => {
    expect(dirtySummaryLabel(summary())).toBe("");
    expect(dirtySummaryLabel(summary(["model", "env"]))).toBe("Model · Env");
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const onReloadRemote = vi.fn();
    const onJumpTo = vi.fn();

    const container = await renderElement(
      <SaveBar
        summary={summary(["model", "env"])}
        saveHint="local draft"
        conflictMessage="remote changed"
        errorMessage="save failed"
        saving
        reloadingRemote
        justSaved={false}
        onSave={onSave}
        onDiscard={onDiscard}
        onReloadRemote={onReloadRemote}
        onJumpTo={onJumpTo}
      />,
    );

    expect(container.textContent).toContain("Configuration changes in Model, Env");
    expect(container.textContent).not.toContain("sections with unsaved changes");
    expect(container.textContent).toContain("local draft");
    expect(container.textContent).toContain("remote changed");
    expect(container.textContent).toContain("save failed");
    expect(container.textContent).toContain("Loading latest");
    expect(container.textContent).toContain("Saving");
    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Model") ?? null);
    expect(onJumpTo).toHaveBeenCalledWith("model");
    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard changes") ?? null,
    );
    expect(onDiscard).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    const saved = await renderElement(
      <SaveBar
        summary={summary()}
        saveHint=""
        conflictMessage={null}
        errorMessage={null}
        saving={false}
        justSaved
        onSave={onSave}
        onDiscard={onDiscard}
        onReloadRemote={onReloadRemote}
        onJumpTo={onJumpTo}
      />,
    );
    expect(saved.textContent).toContain("Saved");

    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    const empty = await renderElement(
      <SaveBar
        summary={summary()}
        saveHint=""
        conflictMessage={null}
        errorMessage={null}
        saving={false}
        justSaved={false}
        onSave={onSave}
        onDiscard={onDiscard}
        onReloadRemote={onReloadRemote}
        onJumpTo={onJumpTo}
      />,
    );
    expect(empty.textContent).toBe("");
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
