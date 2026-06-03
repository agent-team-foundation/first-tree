// @vitest-environment happy-dom

import type { Agent, AgentRuntimeConfig } from "@first-tree/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigRow, ConfigTableHeader } from "../flat-section.js";
import type { AgentDetailContext } from "../layout-context.js";
import { dirtySummaryLabel, SaveBar, sectionAnchorId } from "../save-bar.js";
import type { DraftListItem, DraftSummary, UseConfigDraftResult } from "../use-config-draft.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
    },
    updatedAt: NOW,
    updatedBy: "member-1",
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
      prompt: dirtySections.includes("prompt") ? 1 : 0,
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
      promptAppend: "",
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
    promptDirty: false,
    modelDirty: false,
    reasoningEffortDirty: false,
    setPromptAppend: vi.fn(),
    revertPrompt: vi.fn(),
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

async function renderWithContext(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={["/agents/agent-1/resources"]}>
        <Routes>
          <Route path="/agents/:uuid" element={<Outlet />}>
            <Route path="resources" element={element} />
            <Route path="profile" element={<div>Profile redirect</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
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

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("ResourcesTab and SaveBar", () => {
  it("redirects stale resource links when config editing is not allowed and renders nothing while config is missing", async () => {
    const layoutMocks = await import("../layout-context.js");
    const spy = vi.spyOn(layoutMocks, "useAgentDetailContext");
    const { ResourcesTab } = await import("../resources-tab.js");

    spy.mockReturnValueOnce(context({ canEditConfig: false }));
    let container = await renderWithContext(<ResourcesTab />);
    expect(container.textContent).toContain("Profile redirect");

    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    spy.mockReturnValueOnce(context({ config: undefined }));
    container = await renderWithContext(<ResourcesTab />);
    expect(container.textContent).toBe("");
  });

  it("renders resource sections, computes duplicate sets, handles disabled rows, and runs dry-run preview", async () => {
    const layoutMocks = await import("../layout-context.js");
    const spy = vi.spyOn(layoutMocks, "useAgentDetailContext");
    const ctx = context({ agent: agent({ status: "suspended", runtimeState: null }), dryRunPending: false });
    spy.mockReturnValue(ctx);
    const { ResourcesTab } = await import("../resources-tab.js");

    const container = await renderWithContext(<ResourcesTab />);

    expect(container.querySelector(`#${sectionAnchorId("env")}`)).toBeTruthy();
    expect(container.querySelector(`#${sectionAnchorId("git")}`)).toBeTruthy();
    expect(container.textContent).toContain("OPENAI_API_KEY");
    expect(container.textContent).toContain("dry run diff");
    expect(container.textContent).toContain("Save preview");
    expect(container.textContent).toContain("Preview diff");
    expect(container.textContent).toContain("web");
    expect(container.textContent).toContain("api");
    expect(container.textContent).not.toContain("Add");

    const preview = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Preview diff"),
    );
    await click(preview ?? null);
    expect(ctx.onRunDryRun).toHaveBeenCalled();
  });

  it("renders SaveBar saved, error, conflict, saving, and jump actions", async () => {
    expect(dirtySummaryLabel(summary())).toBe("");
    expect(dirtySummaryLabel(summary(["prompt", "env"]))).toBe("Prompt · Env");
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const onReloadRemote = vi.fn();
    const onJumpTo = vi.fn();

    const container = await renderElement(
      <SaveBar
        summary={summary(["prompt", "env"])}
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

    expect(container.textContent).toContain("Configuration changes in Prompt, Env");
    expect(container.textContent).not.toContain("sections with unsaved changes");
    expect(container.textContent).toContain("local draft");
    expect(container.textContent).toContain("remote changed");
    expect(container.textContent).toContain("save failed");
    expect(container.textContent).toContain("Loading latest");
    expect(container.textContent).toContain("Saving");
    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Prompt") ?? null);
    expect(onJumpTo).toHaveBeenCalledWith("prompt");
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
