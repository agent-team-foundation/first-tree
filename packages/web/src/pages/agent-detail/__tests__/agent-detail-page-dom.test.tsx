// @vitest-environment happy-dom

import type { Agent, AgentResourcesOutput, AgentRuntimeConfig } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import { ApiError } from "../../../api/client.js";
import { ToastProvider } from "../../../components/ui/toast.js";
import { UsageTab } from "../usage-tab.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  listClients: vi.fn(),
}));

const agentConfigMocks = vi.hoisted(() => ({
  getAgentClientStatus: vi.fn(),
  getAgentConfig: vi.fn(),
  updateAgentConfig: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  deleteAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
  listAllAgents: vi.fn(),
  reactivateAgent: vi.fn(),
  recoverAgentRuntimeSwitch: vi.fn(),
  suspendAgent: vi.fn(),
  switchAgentRuntime: vi.fn(),
  testAgentConnection: vi.fn(),
  updateAgent: vi.fn(),
}));

const agentResourceMocks = vi.hoisted(() => ({
  getAgentResources: vi.fn(),
  updateAgentResources: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  listAgentSessions: vi.fn(),
}));

const usageMocks = vi.hoisted(() => ({
  getAgentUsageSummary: vi.fn(),
  getAgentUsageTurns: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    memberId: "member-self",
    role: "admin",
    organizationId: "org-1",
  },
}));

const orgSettingsMocks = vi.hoisted(() => ({
  getContextTreeSetting: vi.fn(),
}));

vi.mock("../../../api/activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/activity.js")>()),
  listClients: activityMocks.listClients,
}));

vi.mock("../../../api/agent-config.js", () => agentConfigMocks);

vi.mock("../../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/agents.js")>()),
  ...agentMocks,
}));

vi.mock("../../../api/agent-resources.js", () => agentResourceMocks);

vi.mock("../../../api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/sessions.js")>()),
  listAgentSessions: sessionMocks.listAgentSessions,
}));

vi.mock("../../../api/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/usage.js")>()),
  getAgentUsageSummary: usageMocks.getAgentUsageSummary,
  getAgentUsageTurns: usageMocks.getAgentUsageTurns,
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../api/org-settings.js", () => orgSettingsMocks);

// The RuntimeTab's model picker asks the bound computer's daemon for a model
// catalog; `null` keeps these page tests on the curated-fallback control they
// exercise (catalog rendering is covered in model-section-catalog.test.tsx).
vi.mock("../../../api/provider-models.js", () => ({
  getProviderModels: vi.fn(async () => null),
}));

const NOW = "2026-05-28T12:00:00.000Z";

type EffectivePromptRow = AgentResourcesOutput["effective"]["prompts"][number];

function effectivePrompt(overrides: Partial<EffectivePromptRow> = {}): EffectivePromptRow {
  const base: EffectivePromptRow = {
    id: "binding:inline-1:enabled",
    bindingId: "inline-1",
    resourceId: null,
    replacesResourceId: null,
    type: "prompt",
    name: "Inline prompt",
    scope: null,
    source: "inline_prompt",
    mode: "enabled",
    defaultEnabled: null,
    payload: null,
    repo: null,
    promptBody: "Always explain tradeoffs.",
    unavailableReason: null,
    order: 1,
  };
  return { ...base, ...overrides };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "vega",
    displayName: overrides.displayName ?? "Vega",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-self",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "inbox-1",
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId === undefined ? "client-1" : overrides.clientId,
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function config(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: overrides.agentId ?? "agent-1",
    version: overrides.version ?? 7,
    payload: overrides.payload ?? {
      kind: "claude-code",
      prompt: {
        append: "Use the team house style.\n\nAlways explain tradeoffs.",
        sections: [
          { scope: "team", name: "Team style guide", body: "Use the team house style." },
          { scope: "agent", name: "", body: "Always explain tradeoffs.", editable: true },
        ],
      },
      model: "sonnet",
      reasoningEffort: "high",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    },
    updatedAt: overrides.updatedAt ?? NOW,
    updatedBy: overrides.updatedBy ?? "member-self",
  };
}

function agentResources(overrides: Partial<AgentResourcesOutput> = {}): AgentResourcesOutput {
  return {
    version: overrides.version ?? 7,
    effective: overrides.effective ?? {
      version: overrides.version ?? 7,
      repos: [],
      prompts: [effectivePrompt()],
      skills: [],
      mcp: [],
      unavailable: [],
    },
    bindings: overrides.bindings ?? [
      {
        id: "inline-1",
        type: "prompt",
        mode: "include",
        resourceId: null,
        replacesResourceId: null,
        inlinePromptBody: "Always explain tradeoffs.",
        order: 1,
      },
    ],
    availableTeamResources: overrides.availableTeamResources ?? [],
  };
}

function client(overrides: Partial<HubClient> = {}): HubClient {
  return {
    id: overrides.id ?? "client-1",
    userId: overrides.userId ?? "user-self",
    status: overrides.status ?? "connected",
    authState: overrides.authState ?? "ok",
    binName: overrides.binName ?? "first-tree-dev",
    sdkVersion: overrides.sdkVersion ?? "0.5.11",
    hostname: overrides.hostname ?? "gandy-macbook",
    os: overrides.os ?? "darwin",
    agentCount: overrides.agentCount ?? 1,
    connectedAt: overrides.connectedAt ?? NOW,
    lastSeenAt: overrides.lastSeenAt ?? NOW,
    capabilities: overrides.capabilities ?? {
      "claude-code": {
        state: "ok",
        available: true,
        sdkVersion: "0.2.84",
        detectedAt: NOW,
      },
      "claude-code-tui": {
        state: "missing",
        available: false,
        sdkVersion: null,
        detectedAt: NOW,
      },
      codex: {
        state: "ok",
        available: true,
        sdkVersion: "0.134.0",
        detectedAt: NOW,
      },
    },
  };
}

function installBrowserStubs(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("80rem") || query.includes("48rem"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  class TestIntersectionObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: TestIntersectionObserver });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

async function renderDom(route: string, child: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const { AgentDetailPage } = await import("../../agent-detail.js");
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Routes>
              <Route path="/agents/:uuid" element={<AgentDetailPage />}>
                <Route path="profile" element={child} />
                <Route path="prompt" element={child} />
                <Route path="resources" element={<div>Resources route</div>} />
                <Route path="runtime" element={child} />
                <Route path="usage" element={<UsageTab />} />
                <Route path="setup" element={<Navigate to="../runtime" replace />} />
              </Route>
              <Route path="/" element={<LocationEcho />} />
              <Route path="/team" element={<div>Team route</div>} />
            </Routes>
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

function LocationEcho() {
  const location = useLocation();
  return <div>{location.pathname + location.search}</div>;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

function exactButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

function menuItemByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    ([...container.querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[]).find(
      (item) => item.textContent?.trim() === text,
    ) ?? null
  );
}

/** Open a row's ⋯ overflow menu, then click one of its items by label. */
async function clickRowMenuItem(container: ParentNode, menuAriaLabel: string, itemText: string): Promise<void> {
  await click(container.querySelector(`button[aria-label="${menuAriaLabel}"]`));
  await click(menuItemByText(container, itemText));
}

async function chooseSelectOption(trigger: Element | null, optionText: string): Promise<void> {
  await click(trigger);
  await click(buttonByText(document.body, optionText));
}

beforeEach(() => {
  installBrowserStubs();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { memberId: "member-self", role: "admin", organizationId: "org-1" };
  orgSettingsMocks.getContextTreeSetting.mockResolvedValue({ repo: "https://github.com/acme/tree", branch: "main" });
  agentMocks.getAgent.mockResolvedValue(agent());
  // Agent switcher list (admin → listAllAgents). Include a second agent so the
  // switcher has a switch target.
  const switcherAgents = {
    items: [agent(), agent({ uuid: "agent-2", name: "nova", displayName: "Nova" })],
    nextCursor: null,
  };
  agentMocks.listAllAgents.mockResolvedValue(switcherAgents);
  agentMocks.listAgents.mockResolvedValue(switcherAgents);
  agentMocks.updateAgent.mockResolvedValue(agent());
  agentMocks.suspendAgent.mockResolvedValue(agent({ status: "suspended" }));
  agentMocks.switchAgentRuntime.mockResolvedValue(agent({ runtimeProvider: "codex" }));
  agentMocks.recoverAgentRuntimeSwitch.mockResolvedValue(agent());
  agentMocks.reactivateAgent.mockResolvedValue(agent());
  agentMocks.deleteAgent.mockResolvedValue(undefined);
  agentMocks.testAgentConnection.mockResolvedValue({
    status: "success",
    message: "connected",
    connection: {
      runtimeState: "idle",
      client: client(),
      lastSeenAt: NOW,
    },
  });
  // Use mockResolvedValue (persistent), not ...Once: the page shell now also
  // observes agent-resources (to badge Tools & skills), so the query can be
  // fetched more than once per render (a stale-time refetch fires when the tab's
  // own observer mounts). The real GET is idempotent — every call returns the
  // same state — so per-test overrides below also use mockResolvedValue; a
  // one-shot mock with an empty fallback would clobber the cache on refetch.
  agentResourceMocks.getAgentResources.mockResolvedValue(agentResources());
  agentResourceMocks.updateAgentResources.mockImplementation(
    async (_agentId: string, body: { bindings: AgentResourcesOutput["bindings"] }) =>
      agentResources({ version: 8, bindings: body.bindings }),
  );
  agentConfigMocks.getAgentConfig.mockResolvedValue(config());
  // Echo the patch back (bumped version) so an immediate save reflects the new
  // value, the way the real PATCH endpoint does.
  agentConfigMocks.updateAgentConfig.mockImplementation(
    async (_agentId: string, body: { payload: Partial<AgentRuntimeConfig["payload"]> }) =>
      config({ version: 8, payload: { ...config().payload, ...body.payload } as AgentRuntimeConfig["payload"] }),
  );
  agentConfigMocks.getAgentClientStatus.mockResolvedValue({
    online: true,
    clientId: "client-1",
    offlineSince: null,
  });
  activityMocks.listClients.mockResolvedValue([
    client(),
    client({ id: "client-2", hostname: "alice-linux", os: "linux" }),
  ]);
  sessionMocks.listAgentSessions.mockResolvedValue([{ chatId: "chat-1" }]);
  usageMocks.getAgentUsageSummary.mockResolvedValue({ daily: [], totals: {} });
  usageMocks.getAgentUsageTurns.mockResolvedValue({
    rows: [
      {
        chatId: "chat-7",
        seq: 1,
        chatTitle: "Launch planning",
        provider: "claude-code",
        model: "sonnet",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        createdAt: NOW,
      },
    ],
    nextCursor: null,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AgentDetailPage", () => {
  it("renders prompt resource blocks and edits the custom prompt inline", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: {
          version: 7,
          repos: [],
          prompts: [
            effectivePrompt({
              id: "resource:team-prompt-1",
              bindingId: null,
              resourceId: "team-prompt-1",
              name: "Team style guide",
              scope: "team",
              source: "team_recommended",
              defaultEnabled: "recommended",
              promptBody: "Use the team style guide.",
              order: 0,
            }),
            effectivePrompt(),
          ],
          skills: [],
          mcp: [],
          unavailable: [],
        },
      }),
    );

    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Team style guide");
    expect(container.textContent).toContain("Vega");
    expect(container.textContent).toContain("1 active");
    expect(container.textContent).toContain("Chat");
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "Profile",
      "Runtime",
      "Instructions",
      "Tools & skills",
      "Repositories",
      "Usage",
    ]);
    expect(container.textContent).toContain("Always explain tradeoffs.");
    expect(container.textContent).toContain("All instructions");
    await waitForText(container, "Team style guide");
    expect(container.textContent).toContain("Team style guide");
    expect(container.textContent).toContain("Added by you");
    // The merged block renders each contributed instruction as its own labelled
    // segment (not one blob): the team segment + the agent's own "Custom" segment.
    const effBlock = container.querySelector('[aria-label="All instructions"]');
    expect(effBlock).toBeTruthy();
    const segLabels = [...(effBlock?.querySelectorAll(".text-eyebrow") ?? [])].map((n) => n.textContent?.trim());
    // Each segment label is "<name> · <source>", aligned with the source rows.
    expect(segLabels.some((l) => l?.includes("Team style guide") && l?.includes("From your team"))).toBe(true);
    expect(segLabels.some((l) => l?.includes("Custom instructions") && l?.includes("Added by you"))).toBe(true);
    expect(effBlock?.textContent).toContain("Use the team house style.");

    // The custom prompt's edit action now lives in the row's ⋯ overflow menu.
    await clickRowMenuItem(container, "More actions for Custom instructions", "Edit custom instructions");
    await waitForText(container, "Save instructions");
    expect(container.textContent).toContain("Team style guide");
    expect(container.textContent).toContain("Team style guide");
    const textarea = container.querySelector<HTMLTextAreaElement>("#custom-prompt-body");
    expect(textarea?.value).toBe("Always explain tradeoffs.");
    expect(textarea?.style.minHeight).toBe("16rem");
    if (!textarea) throw new Error("Expected custom prompt textarea");
    await setValue(textarea, "Prefer concise answers.");
    await click(exactButtonByText(container, "Save instructions"));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected prompt resource update",
    );
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 7,
      bindings: [
        {
          id: "inline-1",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "Prefer concise answers.",
          order: 1,
        },
      ],
    });
    expect(container.textContent).not.toContain("Resources route");

    await act(async () => root.unmount());
  });

  it("keeps the edit entry visible when an inline prompt binding has an empty body", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: {
          version: 7,
          repos: [],
          prompts: [
            effectivePrompt({
              id: "resource:team-prompt-1",
              bindingId: null,
              resourceId: "team-prompt-1",
              name: "Team style guide",
              scope: "team",
              source: "team_recommended",
              defaultEnabled: "recommended",
              promptBody: "Use the team style guide.",
              order: 0,
            }),
            effectivePrompt({
              id: "binding:inline-1:enabled",
              bindingId: "inline-1",
              promptBody: "",
              order: 1,
            }),
          ],
          skills: [],
          mcp: [],
          unavailable: [],
        },
        bindings: [
          {
            id: "inline-1",
            type: "prompt",
            mode: "include",
            resourceId: null,
            replacesResourceId: null,
            inlinePromptBody: "",
            order: 1,
          },
        ],
      }),
    );

    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Team style guide");
    await waitForText(container, "Added by you");
    expect(container.textContent).toContain("No instructions yet.");

    await clickRowMenuItem(container, "More actions for Custom instructions", "Edit custom instructions");
    await waitForText(container, "Save instructions");
    expect(container.textContent).toContain("Team style guide");
    const textarea = container.querySelector<HTMLTextAreaElement>("#custom-prompt-body");
    expect(textarea?.value).toBe("");
    if (!textarea) throw new Error("Expected custom prompt textarea");
    await setValue(textarea, "Recovered custom prompt.");
    await click(exactButtonByText(container, "Save instructions"));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected prompt resource update",
    );
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 7,
      bindings: [
        {
          id: "inline-1",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "Recovered custom prompt.",
          order: 1,
        },
      ],
    });

    await act(async () => root.unmount());
  });

  it("creates an inline replacement when editing a recommended team prompt", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: {
          version: 7,
          repos: [],
          prompts: [
            effectivePrompt({
              id: "resource:team-prompt-1",
              bindingId: null,
              resourceId: "team-prompt-1",
              name: "Team style guide",
              scope: "team",
              source: "team_recommended",
              defaultEnabled: "recommended",
              promptBody: "Use the team style guide.",
              order: 0,
            }),
          ],
          skills: [],
          mcp: [],
          unavailable: [],
        },
        bindings: [],
      }),
    );

    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Team style guide");
    await clickRowMenuItem(container, "More actions for Team style guide", "Customize for this agent");
    await waitForText(container, "Save instructions");
    const textarea = container.querySelector<HTMLTextAreaElement>("#custom-prompt-body");
    expect(textarea?.value).toBe("Use the team style guide.");
    if (!textarea) throw new Error("Expected custom prompt textarea");
    await setValue(textarea, "Use the agent-specific style guide.");
    await click(exactButtonByText(container, "Save instructions"));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected prompt resource update",
    );
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 7,
      bindings: [
        {
          type: "prompt",
          mode: "replace",
          resourceId: null,
          replacesResourceId: "team-prompt-1",
          inlinePromptBody: "Use the agent-specific style guide.",
          order: 1,
        },
      ],
    });

    await act(async () => root.unmount());
  });

  it("converts an explicit recommended prompt binding to an inline replacement", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: {
          version: 7,
          repos: [],
          prompts: [
            effectivePrompt({
              id: "binding:team-binding-1:enabled",
              bindingId: "team-binding-1",
              resourceId: "team-prompt-1",
              name: "Team style guide",
              scope: "team",
              source: "team_recommended",
              defaultEnabled: "recommended",
              promptBody: "Use the team style guide.",
              order: 2,
            }),
          ],
          skills: [],
          mcp: [],
          unavailable: [],
        },
        bindings: [
          {
            id: "team-binding-1",
            type: "prompt",
            mode: "include",
            resourceId: "team-prompt-1",
            replacesResourceId: null,
            inlinePromptBody: null,
            order: 2,
          },
        ],
      }),
    );

    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Team style guide");
    await clickRowMenuItem(container, "More actions for Team style guide", "Customize for this agent");
    await waitForText(container, "Save instructions");
    const textarea = container.querySelector<HTMLTextAreaElement>("#custom-prompt-body");
    expect(textarea?.value).toBe("Use the team style guide.");
    if (!textarea) throw new Error("Expected custom prompt textarea");
    await setValue(textarea, "Use the agent-specific style guide.");
    await click(exactButtonByText(container, "Save instructions"));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected prompt resource update",
    );
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 7,
      bindings: [
        {
          id: "team-binding-1",
          type: "prompt",
          mode: "replace",
          resourceId: null,
          replacesResourceId: "team-prompt-1",
          inlinePromptBody: "Use the agent-specific style guide.",
          order: 2,
        },
      ],
    });

    await act(async () => root.unmount());
  });

  it("drops the existing include binding when disabling an explicitly-included recommended prompt", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: {
          version: 7,
          repos: [],
          prompts: [
            effectivePrompt({
              id: "binding:team-binding-1:enabled",
              bindingId: "team-binding-1",
              resourceId: "team-prompt-1",
              name: "Team style guide",
              scope: "team",
              source: "team_recommended",
              defaultEnabled: "recommended",
              promptBody: "Use the team style guide.",
              order: 2,
            }),
          ],
          skills: [],
          mcp: [],
          unavailable: [],
        },
        bindings: [
          {
            id: "team-binding-1",
            type: "prompt",
            mode: "include",
            resourceId: "team-prompt-1",
            replacesResourceId: null,
            inlinePromptBody: null,
            order: 2,
          },
        ],
      }),
    );

    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Team style guide");
    // Disabling a recommended prompt is now the row's Switch, toggled off.
    await click(container.querySelector('button[role="switch"]'));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected prompt resource update",
    );
    // The pre-existing include binding must be dropped, not left alongside the
    // disable binding — otherwise the resolver keeps the prompt enabled at runtime.
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 7,
      bindings: [{ type: "prompt", mode: "disable", resourceId: "team-prompt-1", order: 3 }],
    });

    await act(async () => root.unmount());
  });

  it("adds an inline prompt and clears local validation errors on cancel", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    const emptyConfig = config();
    agentConfigMocks.getAgentConfig.mockResolvedValueOnce(
      config({ payload: { ...emptyConfig.payload, prompt: { append: "" } } }),
    );
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: { version: 7, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
        bindings: [],
      }),
    );

    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "No instructions yet.");
    await click(container.querySelector('button[aria-label="Add instructions"]'));
    await click(buttonByText(document.body, "Add custom instructions"));
    await waitForText(container, "Save instructions");
    await click(exactButtonByText(container, "Save instructions"));
    await waitForText(container, "Instructions are required.");
    await click(exactButtonByText(container, "Cancel"));
    await waitForCondition(
      () => !container.textContent?.includes("Instructions are required."),
      "Expected prompt body validation error to clear",
    );

    await click(container.querySelector('button[aria-label="Add instructions"]'));
    await click(buttonByText(document.body, "Add custom instructions"));
    await waitForText(container, "Save instructions");
    expect(container.textContent).not.toContain("Instructions are required.");
    const textarea = container.querySelector<HTMLTextAreaElement>("#custom-prompt-body");
    expect(textarea?.value).toBe("");
    if (!textarea) throw new Error("Expected custom prompt textarea");
    await setValue(textarea, "Prefer concise answers.");
    await click(exactButtonByText(container, "Save instructions"));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected prompt resource update",
    );
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 7,
      bindings: [
        {
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "Prefer concise answers.",
          order: 1,
        },
      ],
    });

    await act(async () => root.unmount());
  });

  it("saves the model immediately on change — no Save bar", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(container, "Model settings");

    // Catalog fetch is mocked null → curated Claude fallback once settled.
    // Wait for the loaded control (enabled) before picking opus.
    await waitForCondition(() => {
      const b = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
      return !!b && !b.disabled;
    }, "Expected the model picker to finish loading");
    // Changing the model saves right away (no draft, no Save bar).
    await chooseSelectOption(container.querySelector('button[aria-label="Model"]'), "opus");
    await waitForCondition(
      () => agentConfigMocks.updateAgentConfig.mock.calls.length > 0,
      "Expected an immediate config save",
    );
    expect(agentConfigMocks.updateAgentConfig).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 7,
      payload: { model: "opus" },
    });
    // No draft Save bar / discard affordance ever appears.
    expect(container.textContent).not.toContain("Configuration changes in");
    expect(document.body.textContent).not.toContain("Discard changes");

    await act(async () => root.unmount());
  });

  it("leaves immediately after an edit — no unsaved-changes guard", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(container, "Model settings");
    await waitForCondition(() => {
      const b = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
      return !!b && !b.disabled;
    }, "Expected the model picker to finish loading");
    await chooseSelectOption(container.querySelector('button[aria-label="Model"]'), "opus");
    await waitForCondition(
      () => agentConfigMocks.updateAgentConfig.mock.calls.length > 0,
      "Expected an immediate config save",
    );

    // Leaving via the header Chat button navigates straight away — no guard.
    await click(container.querySelector('button[aria-label="Start chat"]'));
    await waitForText(container, "/?c=draft&with=agent-1");
    expect(document.body.textContent).not.toContain("Leave with unsaved changes?");

    await act(async () => root.unmount());
  });

  it("starts a draft chat with the current agent from the header", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Custom instructions");

    await click(container.querySelector('button[aria-label="Start chat"]'));
    await waitForText(container, "/?c=draft&with=agent-1");
    expect(container.textContent).toContain("/?c=draft&with=agent-1");

    await act(async () => root.unmount());
  });

  it("binds unclaimed agents", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    agentConfigMocks.getAgentClientStatus.mockResolvedValueOnce({
      online: false,
      clientId: null,
      offlineSince: null,
    });
    const unclaimedAgent = agent({ clientId: null, runtimeState: null });
    agentMocks.getAgent.mockResolvedValueOnce(unclaimedAgent);

    const first = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(first.container, "No computer bound");
    expect(first.container.textContent).toContain("Execution");
    expect(first.container.textContent).toContain("Model settings");
    expect(first.container.textContent).toContain("No computer bound");
    await click(buttonByText(first.container, "Bind computer"));
    await waitForText(document.body, "gandy-macbook");
    expect(document.body.textContent).toContain("Bind computer");
    await click(buttonByText(document.body, "gandy-macbook"));
    await click(exactButtonByText(document.body, "Bind"));
    await waitForCondition(() => agentMocks.updateAgent.mock.calls.length > 0, "Expected bind mutation");
    expect(agentMocks.updateAgent).toHaveBeenCalledWith("agent-1", { clientId: "client-1" });
    await act(async () => first.root.unmount());
  });

  it("switches an agent runtime from the Runtime tab", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    const view = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(view.container, "Switch runtime");

    await click(buttonByText(view.container, "Switch runtime"));
    await waitForText(document.body, "Switch runtime");
    await click(buttonByText(document.body, "Codex"));
    await click(exactButtonByText(document.body, "Review impact"));
    await waitForText(document.body, "Existing runtime sessions stop");
    const confirm = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!confirm) throw new Error("Runtime switch confirmation checkbox missing");
    const switchConfirmButton = () =>
      [...document.body.querySelectorAll("button")]
        .filter((button) => button.textContent?.trim() === "Switch runtime")
        .at(-1) ?? null;
    expect(switchConfirmButton()?.disabled).toBe(true);
    await click(confirm);
    await click(switchConfirmButton());
    await waitForCondition(() => agentMocks.switchAgentRuntime.mock.calls.length > 0, "Expected runtime switch");
    expect(agentMocks.switchAgentRuntime).toHaveBeenCalledWith("agent-1", {
      clientId: "client-1",
      runtimeProvider: "codex",
      confirmLocalDataLoss: true,
    });

    await act(async () => view.root.unmount());
  });

  it("offers runtime switch for suspended unbound agents cleared by client retirement", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    agentConfigMocks.getAgentClientStatus.mockResolvedValue({
      online: false,
      clientId: null,
      offlineSince: null,
    });
    agentMocks.getAgent.mockResolvedValue(agent({ status: "suspended", clientId: null, runtimeState: null }));
    agentMocks.switchAgentRuntime.mockResolvedValue(agent({ clientId: "client-2", runtimeProvider: "codex" }));

    const view = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(view.container, "No computer bound");
    await waitForText(view.container, "Switch runtime");
    expect(buttonByText(view.container, "Bind computer")).toBeNull();

    await click(buttonByText(view.container, "Switch runtime"));
    await waitForText(document.body, "alice-linux");
    await click(buttonByText(document.body, "alice-linux"));
    await click(buttonByText(document.body, "Codex"));
    await click(exactButtonByText(document.body, "Review impact"));
    const confirm = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!confirm) throw new Error("Runtime switch confirmation checkbox missing");
    await click(confirm);
    await click(
      [...document.body.querySelectorAll("button")]
        .filter((button) => button.textContent?.trim() === "Switch runtime")
        .at(-1) ?? null,
    );

    await waitForCondition(() => agentMocks.switchAgentRuntime.mock.calls.length > 0, "Expected runtime switch");
    expect(agentMocks.switchAgentRuntime).toHaveBeenCalledWith("agent-1", {
      clientId: "client-2",
      runtimeProvider: "codex",
      confirmLocalDataLoss: true,
    });

    await act(async () => view.root.unmount());
  });

  it("renders load failures and profile lifecycle actions", async () => {
    const { ProfileTab } = await import("../profile-tab.js");

    agentMocks.getAgent.mockRejectedValueOnce(new ApiError(404, "missing"));
    const missing = await renderDom("/agents/agent-404/profile", <ProfileTab />);
    await waitForText(missing.container, "Agent not available");
    expect(missing.container.textContent).toContain("Agent not available");
    await click(exactButtonByText(missing.container, "Back to Agents"));
    expect(missing.container.textContent).toContain("Team route");
    await act(async () => missing.root.unmount());

    agentMocks.getAgent.mockResolvedValueOnce(agent());
    const active = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(active.container, "Agent lifecycle");
    expect(active.container.textContent).toContain("Identity");
    expect(active.container.textContent).toContain("@vega");
    expect(active.container.textContent).toContain("Owner");
    expect(active.container.textContent).toContain("Agent lifecycle");
    expect(active.container.textContent).not.toContain("Lifecycle changes save immediately.");
    expect(
      [...active.container.querySelectorAll("section h2")].filter((heading) =>
        heading.textContent?.includes("Agent lifecycle"),
      ),
    ).toHaveLength(1);
    expect(active.container.textContent).toContain("Availability");
    expect(active.container.textContent).toContain("Deletion");
    await click(exactButtonByText(active.container, "Suspend"));
    expect(document.body.textContent).toContain('Suspend "Vega"?');
    await click(exactButtonByText(document.body, "Suspend agent"));
    await waitForCondition(() => agentMocks.suspendAgent.mock.calls.length > 0, "Expected suspend mutation");
    expect(agentMocks.suspendAgent).toHaveBeenCalledWith("agent-1");
    await act(async () => active.root.unmount());

    agentMocks.getAgent.mockResolvedValueOnce(agent({ status: "suspended", runtimeState: null }));
    const suspended = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(suspended.container, "Reactivate");
    await click(exactButtonByText(suspended.container, "Reactivate"));
    await waitForCondition(() => agentMocks.reactivateAgent.mock.calls.length > 0, "Expected reactivate mutation");
    expect(agentMocks.reactivateAgent).toHaveBeenCalledWith("agent-1");
    await act(async () => suspended.root.unmount());

    agentMocks.getAgent.mockResolvedValueOnce(agent({ status: "suspended", clientId: null, runtimeState: null }));
    const unboundSuspended = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(unboundSuspended.container, "Agent lifecycle");
    expect(unboundSuspended.container.textContent).toContain("Availability");
    expect(unboundSuspended.container.textContent).not.toContain("Reactivate");
    await act(async () => unboundSuspended.root.unmount());

    agentMocks.getAgent.mockResolvedValueOnce(agent({ status: "suspended", runtimeState: null }));
    const toDelete = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(toDelete.container, "Deletion");
    await click(exactButtonByText(toDelete.container, "Delete"));
    await waitForText(document.body, 'Delete "Vega"?');
    const input = document.body.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Delete confirmation input missing");
    await setValue(input, "Vega");
    await click(exactButtonByText(document.body, "Delete agent"));
    await waitForCondition(() => agentMocks.deleteAgent.mock.calls.length > 0, "Expected delete mutation");
    expect(agentMocks.deleteAgent).toHaveBeenCalledWith("agent-1");

    await act(async () => toDelete.root.unmount());
  });

  it("does not render agent lifecycle danger controls for human agents", async () => {
    const { ProfileTab } = await import("../profile-tab.js");

    agentMocks.getAgent.mockResolvedValueOnce(agent({ type: "human" }));
    const view = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(view.container, "Identity");
    expect(view.container.textContent).not.toContain("Agent lifecycle");
    expect(view.container.textContent).not.toContain("Deletion");
    expect(view.container.querySelector('button[aria-label="Suspend"]')).toBeNull();

    await act(async () => view.root.unmount());
  });

  it("omits human display-name editing and keeps projection edits on the agent route", async () => {
    const { ProfileTab } = await import("../profile-tab.js");
    agentMocks.getAgent.mockResolvedValue(agent({ type: "human", managerId: "member-self", displayName: "Gandy" }));

    const view = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(view.container, "Identity");
    await click(exactButtonByText(view.container, "Edit"));
    await waitForText(document.body, "Edit profile");
    expect(document.body.querySelector("#profile-display")).toBeNull();

    const visibility = document.body.querySelector<HTMLButtonElement>("#profile-visibility");
    if (!visibility) throw new Error("Expected human visibility control");
    await chooseSelectOption(visibility, "Private to you");
    await waitForCondition(() => agentMocks.updateAgent.mock.calls.length > 0, "Expected agent projection update");
    expect(agentMocks.updateAgent).toHaveBeenCalledWith("agent-1", { visibility: "private" });

    await act(async () => view.root.unmount());
  });

  it("keeps non-human display-name edits on the agent route", async () => {
    const { ProfileTab } = await import("../profile-tab.js");
    agentMocks.getAgent.mockResolvedValue(agent({ displayName: "Vega" }));

    const view = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(view.container, "Identity");
    await click(exactButtonByText(view.container, "Edit"));
    await waitForText(document.body, "Edit profile");
    const input = document.body.querySelector<HTMLInputElement>("#profile-display");
    if (!input) throw new Error("Expected profile display-name input");
    await setValue(input, "Vega Updated");
    await click(exactButtonByText(document.body, "Done"));

    await waitForCondition(() => agentMocks.updateAgent.mock.calls.length > 0, "Expected agent identity update");
    expect(agentMocks.updateAgent).toHaveBeenCalledWith("agent-1", { displayName: "Vega Updated" });

    await act(async () => view.root.unmount());
  });

  it("shows runtime-switch recovery state instead of ordinary lifecycle controls", async () => {
    const { ProfileTab } = await import("../profile-tab.js");
    const { RuntimeTab } = await import("../runtime-tab.js");
    const stuck = agent({
      status: "suspended",
      runtimeState: null,
      metadata: { runtimeSwitch: { claimId: "claim-web", phase: "committed" } },
    });

    agentMocks.getAgent.mockResolvedValueOnce(stuck);
    const runtime = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(runtime.container, "Runtime switch recovery");
    expect(runtime.container.textContent).toContain("claim-web");
    expect(runtime.container.textContent).not.toContain("Switch runtime");
    await click(exactButtonByText(runtime.container, "Recover"));
    await waitForCondition(
      () => agentMocks.recoverAgentRuntimeSwitch.mock.calls.length > 0,
      "Expected runtime switch recovery mutation",
    );
    expect(agentMocks.recoverAgentRuntimeSwitch).toHaveBeenCalledWith("agent-1");
    await act(async () => runtime.root.unmount());

    agentMocks.getAgent.mockResolvedValueOnce(stuck);
    const profile = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(profile.container, "Runtime switch claim claim-web");
    expect(profile.container.textContent).toContain("Recover");
    expect(profile.container.textContent).not.toContain("Reactivate");
    expect(profile.container.textContent).not.toContain("Delete");
    await act(async () => profile.root.unmount());
  });
});
