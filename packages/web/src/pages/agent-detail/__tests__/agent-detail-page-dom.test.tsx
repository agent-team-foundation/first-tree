// @vitest-environment happy-dom

import type { Agent, AgentResourcesOutput, AgentRuntimeConfig } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import { ApiError } from "../../../api/client.js";
import { UsageTab } from "../usage-tab.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  listClients: vi.fn(),
}));

const agentConfigMocks = vi.hoisted(() => ({
  dryRunAgentConfig: vi.fn(),
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
  rebindAgent: vi.fn(),
  suspendAgent: vi.fn(),
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
    name: overrides.name ?? "kael",
    displayName: overrides.displayName ?? "Kael",
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
    clientId: overrides.clientId ?? "client-1",
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
      prompt: { append: "Always explain tradeoffs." },
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
    sdkVersion: overrides.sdkVersion ?? "0.5.0",
    hostname: overrides.hostname ?? "gandy-macbook",
    os: overrides.os ?? "darwin",
    agentCount: overrides.agentCount ?? 1,
    connectedAt: overrides.connectedAt ?? NOW,
    lastSeenAt: overrides.lastSeenAt ?? NOW,
    capabilities: overrides.capabilities ?? {
      "claude-code": {
        state: "ok",
        available: true,
        authenticated: true,
        sdkVersion: "0.2.84",
        authMethod: "oauth",
        detectedAt: NOW,
      },
      "claude-code-tui": {
        state: "missing",
        available: false,
        authenticated: false,
        sdkVersion: null,
        authMethod: "none",
        detectedAt: NOW,
      },
      codex: {
        state: "unauthenticated",
        available: true,
        authenticated: false,
        sdkVersion: "0.134.0",
        authMethod: "none",
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

function lastExactButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].reverse().find((button) => button.textContent?.trim() === text) ?? null
  );
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
  agentMocks.rebindAgent.mockResolvedValue(agent({ clientId: "client-2", runtimeProvider: "codex" }));
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
  agentConfigMocks.updateAgentConfig.mockResolvedValue(config({ version: 8 }));
  agentConfigMocks.dryRunAgentConfig.mockResolvedValue({ diff: [{ op: "replace", path: "/prompt/append" }] });
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
    await waitForText(container, "Effective instructions");
    expect(container.textContent).toContain("Kael");
    expect(container.textContent).toContain("1 active");
    expect(container.textContent).toContain("Chat");
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "Profile",
      "Environment",
      "Instructions",
      "Tools & skills",
      "Usage",
    ]);
    expect(container.textContent).toContain("Always explain tradeoffs.");
    await waitForText(container, "Team style guide");
    expect(container.textContent).toContain("Use the team style guide.");
    expect(container.textContent).toContain("Added by you");

    await click(exactButtonByText(container, "Edit custom instructions"));
    await waitForText(container, "Save instructions");
    expect(container.textContent).toContain("Team style guide");
    expect(container.textContent).toContain("Use the team style guide.");
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

    await click(exactButtonByText(container, "Edit custom instructions"));
    await waitForText(container, "Save instructions");
    expect(container.textContent).toContain("Use the team style guide.");
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
    await waitForText(container, "Effective instructions");
    await click(exactButtonByText(container, "Customize for this agent"));
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
    await waitForText(container, "Effective instructions");
    await click(exactButtonByText(container, "Customize for this agent"));
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
    await waitForText(container, "Effective instructions");
    await click(exactButtonByText(container, "Disable"));
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

  it("guards leaving with an unsaved config draft (confirm discards, cancel stays)", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(container, "Model settings");

    // Dirty the config draft by changing the model — the SaveBar appears.
    await chooseSelectOption(container.querySelector('button[aria-label="Model"]'), "opus");
    await waitForText(container, "Configuration changes in");

    // Leaving via the header Chat button is guarded.
    await click(container.querySelector('button[aria-label="Start chat"]'));
    await waitForText(document.body, "Leave with unsaved changes?");
    expect(container.textContent).not.toContain("/?c=draft");

    // Cancel keeps us on the page (no navigation).
    await click(exactButtonByText(document.body, "Cancel"));
    await waitForCondition(
      () => !document.body.textContent?.includes("Leave with unsaved changes?"),
      "Expected leave guard to dismiss on cancel",
    );

    // Re-trigger and discard → navigation proceeds.
    await click(container.querySelector('button[aria-label="Start chat"]'));
    await waitForText(document.body, "Leave with unsaved changes?");
    await click(exactButtonByText(document.body, "Discard & leave"));
    await waitForText(container, "/?c=draft&with=agent-1");

    await act(async () => root.unmount());
  });

  it("does not guard same-agent tab navigation (draft persists across tabs)", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(container, "Model settings");
    await chooseSelectOption(container.querySelector('button[aria-label="Model"]'), "opus");
    await waitForText(container, "Configuration changes in");

    // Switching tabs within the same agent must NOT pop the leave guard.
    const profileTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.trim() === "Profile");
    await click(profileTab ?? null);
    expect(document.body.textContent).not.toContain("Leave with unsaved changes?");

    await act(async () => root.unmount());
  });

  it("guards the Usage tab's recent-turn chat link when the draft is dirty", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(container, "Model settings");
    // Dirty the config draft on Environment, then switch to Usage (same agent —
    // not guarded; the draft persists across tabs).
    await chooseSelectOption(container.querySelector('button[aria-label="Model"]'), "opus");
    await waitForText(container, "Configuration changes in");
    const usageTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.trim() === "Usage");
    await click(usageTab ?? null);
    await waitForText(container, "Launch planning");

    // Opening a recent-turn chat leaves the agent → guarded; cancel keeps the page.
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Launch planning") ?? null);
    await waitForText(document.body, "Leave with unsaved changes?");
    expect(container.textContent).not.toContain("/?chat=");
    await click(exactButtonByText(document.body, "Cancel"));
    await waitForCondition(
      () => !document.body.textContent?.includes("Leave with unsaved changes?"),
      "Expected leave guard to dismiss on cancel",
    );

    await act(async () => root.unmount());
  });

  it("guards switching to another agent via the switcher when the draft is dirty", async () => {
    const { RuntimeTab } = await import("../runtime-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(container, "Model settings");
    await waitForText(container, "Nova"); // switcher list loaded (Kael + Nova)
    await chooseSelectOption(container.querySelector('button[aria-label="Model"]'), "opus");
    await waitForText(container, "Configuration changes in");

    // Clicking another agent in the switcher leaves the current agent → guarded.
    await click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nova")) ?? null);
    await waitForText(document.body, "Leave with unsaved changes?");
    await click(exactButtonByText(document.body, "Cancel"));
    await waitForCondition(
      () => !document.body.textContent?.includes("Leave with unsaved changes?"),
      "Expected switcher leave guard to dismiss on cancel",
    );

    await act(async () => root.unmount());
  });

  it("starts a draft chat with the current agent from the header", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Effective instructions");

    await click(container.querySelector('button[aria-label="Start chat"]'));
    await waitForText(container, "/?c=draft&with=agent-1");
    expect(container.textContent).toContain("/?c=draft&with=agent-1");

    await act(async () => root.unmount());
  });

  it("binds unclaimed agents and rebinds bound agents", async () => {
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

    const second = await renderDom("/agents/agent-1/runtime", <RuntimeTab />);
    await waitForText(second.container, "Execution");
    expect(second.container.textContent).toContain("Execution");
    expect(second.container.textContent).toContain("Model settings");
    await click(exactButtonByText(second.container, "Re-bind"));
    await waitForText(document.body, "Current binding:");
    expect(document.body.textContent).toContain("Current binding:");
    await chooseSelectOption(document.body.querySelector('button[aria-label="Computer"]'), "alice-linux");
    await click(
      [...document.body.querySelectorAll("label")].find((label) => label.textContent?.includes("Claude Code (TUI)")) ??
        null,
    );
    await click(document.body.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    await click(lastExactButtonByText(document.body, "Re-bind"));
    await waitForCondition(() => agentMocks.rebindAgent.mock.calls.length > 0, "Expected re-bind mutation");
    expect(agentMocks.rebindAgent).toHaveBeenCalledWith("agent-1", {
      clientId: "client-2",
      runtimeProvider: "claude-code-tui",
      force: true,
    });

    await act(async () => second.root.unmount());
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
    expect(active.container.textContent).toContain("@kael");
    expect(active.container.textContent).toContain("Owner");
    expect(active.container.textContent).toContain("Agent lifecycle");
    expect(active.container.textContent).toContain("Lifecycle changes save immediately.");
    expect(
      [...active.container.querySelectorAll("section h2")].filter((heading) =>
        heading.textContent?.includes("Agent lifecycle"),
      ),
    ).toHaveLength(1);
    expect(active.container.textContent).toContain("Availability");
    expect(active.container.textContent).toContain("Deletion");
    await click(exactButtonByText(active.container, "Suspend"));
    expect(document.body.textContent).toContain('Suspend "Kael"?');
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

    agentMocks.getAgent.mockResolvedValueOnce(agent({ status: "suspended", runtimeState: null }));
    const toDelete = await renderDom("/agents/agent-1/profile", <ProfileTab />);
    await waitForText(toDelete.container, "Deletion");
    await click(exactButtonByText(toDelete.container, "Delete"));
    await waitForText(document.body, 'Delete "Kael"?');
    const input = document.body.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Delete confirmation input missing");
    await setValue(input, "Kael");
    await click(exactButtonByText(document.body, "Delete agent"));
    await waitForCondition(() => agentMocks.deleteAgent.mock.calls.length > 0, "Expected delete mutation");
    expect(agentMocks.deleteAgent).toHaveBeenCalledWith("agent-1");

    await act(async () => toDelete.root.unmount());
  });
});
