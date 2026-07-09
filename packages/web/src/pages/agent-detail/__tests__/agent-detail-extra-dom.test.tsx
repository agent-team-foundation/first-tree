// @vitest-environment happy-dom

import type {
  Agent,
  AgentResourceBindingInput,
  AgentResourcesOutput,
  AgentRuntimeConfig,
  UsageAgentSummary,
  UsageTurnsResponse,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDetailContext } from "../layout-context.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const contextMock = vi.hoisted(() => ({
  value: null as AgentDetailContext | null,
}));

const agentResourceMocks = vi.hoisted(() => ({
  getAgentResources: vi.fn(),
  updateAgentResources: vi.fn(),
}));

const usageMocks = vi.hoisted(() => ({
  getAgentUsageSummary: vi.fn(),
  getAgentUsageTurns: vi.fn(),
}));

const agentApiMocks = vi.hoisted(() => ({
  deleteAgentAvatar: vi.fn(),
  listAgents: vi.fn(),
  listManagedAgents: vi.fn(),
  uploadAgentAvatar: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    memberId: "member-self",
    role: "member",
    agentId: "human-self",
    organizationId: "org-1",
  },
}));

vi.mock("../layout-context.js", () => ({
  useAgentDetailContext: () => {
    if (!contextMock.value) throw new Error("Missing agent detail context");
    return contextMock.value;
  },
}));

vi.mock("../../../api/agent-resources.js", () => agentResourceMocks);

vi.mock("../../../api/usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/usage.js")>()),
  getAgentUsageSummary: usageMocks.getAgentUsageSummary,
  getAgentUsageTurns: usageMocks.getAgentUsageTurns,
}));

vi.mock("../../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/agents.js")>()),
  deleteAgentAvatar: agentApiMocks.deleteAgentAvatar,
  listAgents: agentApiMocks.listAgents,
  listManagedAgents: agentApiMocks.listManagedAgents,
  uploadAgentAvatar: agentApiMocks.uploadAgentAvatar,
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

const NOW = "2026-06-01T12:00:00.000Z";
const roots: Root[] = [];

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
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
    version: overrides.version ?? 4,
    payload: overrides.payload ?? {
      kind: "claude-code",
      prompt: { append: "Fallback prompt body." },
      model: "sonnet",
      reasoningEffort: "medium",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    },
    updatedAt: overrides.updatedAt ?? NOW,
    updatedBy: overrides.updatedBy ?? "member-self",
  };
}

function createContext(overrides: Partial<AgentDetailContext> = {}): AgentDetailContext {
  const baseAgent = overrides.agent ?? agent();
  return {
    uuid: baseAgent.uuid,
    agent: baseAgent,
    isHuman: baseAgent.type === "human",
    canManageAgent: true,
    canEditConfig: baseAgent.type !== "human",
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

type EffectivePromptRow = AgentResourcesOutput["effective"]["prompts"][number];

function promptRow(overrides: Partial<EffectivePromptRow> = {}): EffectivePromptRow {
  const base: EffectivePromptRow = {
    id: "resource:team-prompt",
    bindingId: null,
    resourceId: "team-prompt",
    replacesResourceId: null,
    type: "prompt",
    name: "Team prompt",
    scope: "team",
    source: "team_recommended",
    mode: "enabled",
    defaultEnabled: "recommended",
    payload: null,
    repo: null,
    promptBody: "Use the team playbook.",
    unavailableReason: null,
    order: 0,
  };
  return { ...base, ...overrides };
}

function agentResources(overrides: Partial<AgentResourcesOutput> = {}): AgentResourcesOutput {
  return {
    version: overrides.version ?? 9,
    effective: overrides.effective ?? {
      version: overrides.version ?? 9,
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

function availablePrompt(): AgentResourcesOutput["availableTeamResources"][number] {
  return {
    id: "prompt-available",
    organizationId: "org-1",
    type: "prompt",
    scope: "team",
    ownerAgentId: null,
    name: "Optional safety prompt",
    repoCanonicalKey: null,
    defaultEnabled: "available",
    status: "active",
    payload: { body: "Check safety constraints." },
    createdBy: "member-self",
    updatedBy: "member-self",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function availableSkill(): AgentResourcesOutput["availableTeamResources"][number] {
  return {
    id: "skill-available",
    organizationId: "org-1",
    type: "skill",
    scope: "team",
    ownerAgentId: null,
    name: "Optional skill",
    repoCanonicalKey: null,
    defaultEnabled: "available",
    status: "active",
    payload: { name: "Optional skill", description: "Optional helper.", body: "Do work.", metadata: {} },
    createdBy: "member-self",
    updatedBy: "member-self",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function summary(): UsageAgentSummary {
  return {
    agentId: "agent-1",
    from: "2026-05-01T00:00:00.000Z",
    to: NOW,
    totals: {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      turns: 1,
      chats: 1,
      lastUsageAt: NOW,
    },
    daily: [],
  };
}

function turns(limit = 10, nextCursor: string | null = "next"): UsageTurnsResponse {
  return {
    agentId: "agent-1",
    from: "2026-05-01T00:00:00.000Z",
    to: NOW,
    rows: [
      {
        seq: limit,
        chatId: `chat-${limit}`,
        chatTitle: `Turn batch ${limit}`,
        createdAt: NOW,
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 25,
        provider: "codex",
        model: "gpt-5",
      },
    ],
    nextCursor,
  };
}

function installBrowserStubs(): void {
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => window.clearTimeout(id),
  });
}

function createQueryClient(): QueryClient {
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

async function renderWithProviders(element: ReactElement, route = "/agents/agent-1/prompt"): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

async function renderPlain(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
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

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
  await flush();
}

async function setTextareaValue(element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
  await flush();
}

async function pressKey(element: Element, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForCondition(check: () => boolean, message: string, timeoutMs = 1200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await flush();
  }
  throw new Error(message);
}

async function waitForText(scope: ParentNode, text: string, timeoutMs = 1200): Promise<void> {
  await waitForCondition(() => scope.textContent?.includes(text) === true, `Expected text "${text}"`, timeoutMs);
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  installBrowserStubs();
  contextMock.value = createContext();
  authMock.value = {
    memberId: "member-self",
    role: "member",
    agentId: "human-self",
    organizationId: "org-1",
  };
  vi.clearAllMocks();
  agentResourceMocks.getAgentResources.mockResolvedValue(agentResources());
  agentResourceMocks.updateAgentResources.mockImplementation(
    async (_uuid: string, input: { bindings: AgentResourceBindingInput[] }) =>
      agentResources({ version: 10, bindings: input.bindings }),
  );
  usageMocks.getAgentUsageSummary.mockResolvedValue(summary());
  usageMocks.getAgentUsageTurns.mockImplementation(async (_agentId: string, args: { limit: number }) =>
    turns(args.limit, args.limit >= 30 ? null : "next"),
  );
  agentApiMocks.deleteAgentAvatar.mockResolvedValue(undefined);
  agentApiMocks.uploadAgentAvatar.mockResolvedValue({ avatarImageUrl: "/avatars/agent-1.webp" });
  agentApiMocks.listAgents.mockResolvedValue({ items: [], nextCursor: null });
  agentApiMocks.listManagedAgents.mockResolvedValue([]);
});

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
});

describe("PromptTab extra DOM states", () => {
  it("keeps the fallback prompt visible when resources fail to load", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockRejectedValue(new Error("resources offline"));
    contextMock.value = createContext({
      config: config({
        payload: {
          kind: "claude-code",
          prompt: { append: "Fallback instructions from config." },
          model: "sonnet",
          reasoningEffort: "medium",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
      }),
    });

    const container = await renderWithProviders(<PromptTab />);
    await waitForText(container, "resources offline");

    expect(container.textContent).toContain("Fallback instructions from config.");
    expect(container.querySelector('button[aria-label="Add instructions"]')).toBeNull();
  });

  it("enables optional team prompts and routes the settings escape through navigateAway", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    const navigateAway = vi.fn();
    contextMock.value = createContext({
      navigateAway,
      config: config({
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
      }),
    });
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: { version: 9, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
        availableTeamResources: [availablePrompt()],
      }),
    );

    const container = await renderWithProviders(<PromptTab />);
    await waitForText(container, "No instructions yet.");

    await click(container.querySelector('button[aria-label="Add instructions"]'));
    await click(buttonByText(document.body, "Manage in Settings"));
    expect(navigateAway).toHaveBeenCalledWith("/settings/resources");

    await click(container.querySelector('button[aria-label="Add instructions"]'));
    await waitForText(document.body, "Optional safety prompt");
    await click(buttonByText(document.body, "Optional safety prompt"));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected optional prompt enable mutation",
    );
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 9,
      bindings: [{ type: "prompt", mode: "include", resourceId: "prompt-available", order: 1 }],
    });
  });

  it("re-enables disabled prompts and removes orphan inline bindings", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: {
          version: 9,
          repos: [],
          prompts: [
            promptRow({
              id: "binding:disable-1:disabled",
              bindingId: "disable-1",
              resourceId: "team-prompt",
              mode: "disabled",
              promptBody: "Use the team playbook.",
              order: 1,
            }),
          ],
          skills: [],
          mcp: [],
          unavailable: [],
        },
        bindings: [
          { id: "disable-1", type: "prompt", mode: "disable", resourceId: "team-prompt", order: 1 },
          {
            id: "orphan-inline",
            type: "prompt",
            mode: "include",
            resourceId: null,
            replacesResourceId: null,
            inlinePromptBody: "",
            order: 2,
          },
        ],
      }),
    );

    const container = await renderWithProviders(<PromptTab />);
    await waitForText(container, "Team prompt");

    const disabledSwitch = container.querySelector('button[role="switch"][aria-label="Enable Team prompt"]');
    expect(disabledSwitch?.getAttribute("aria-checked")).toBe("false");
    await click(disabledSwitch);
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 9,
      bindings: [
        {
          id: "orphan-inline",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "",
          order: 2,
        },
      ],
    });

    agentResourceMocks.updateAgentResources.mockClear();
    await click(container.querySelector('button[aria-label="More actions for custom instructions"]'));
    await click(buttonByText(container, "Remove"));
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 10,
      bindings: [],
    });
  });

  it("edits orphan inline prompt bindings and cancels the editor with Escape", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: { version: 9, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
        bindings: [
          {
            id: "orphan-inline",
            type: "prompt",
            mode: "include",
            resourceId: null,
            replacesResourceId: null,
            inlinePromptBody: "Recovered from an invisible binding.",
            order: 3,
          },
        ],
      }),
    );

    const container = await renderWithProviders(<PromptTab />);
    await waitForText(container, "No instructions yet.");

    await click(container.querySelector('button[aria-label="More actions for custom instructions"]'));
    await click(buttonByText(container, "Edit custom instructions"));
    await waitForText(container, "Save instructions");
    const firstTextarea = container.querySelector<HTMLTextAreaElement>("#custom-prompt-body");
    expect(firstTextarea?.value).toBe("Recovered from an invisible binding.");
    if (!firstTextarea) throw new Error("Expected orphan prompt textarea");
    await pressKey(firstTextarea, "Escape");
    await waitForCondition(
      () => !container.textContent?.includes("Save instructions"),
      "Expected Escape to close the orphan editor",
    );
    expect(agentResourceMocks.updateAgentResources).not.toHaveBeenCalled();

    await click(container.querySelector('button[aria-label="More actions for custom instructions"]'));
    await click(buttonByText(container, "Edit custom instructions"));
    await waitForText(container, "Save instructions");
    const secondTextarea = container.querySelector<HTMLTextAreaElement>("#custom-prompt-body");
    if (!secondTextarea) throw new Error("Expected orphan prompt textarea");
    await setTextareaValue(secondTextarea, "Recovered and saved.");
    await click(buttonByText(container, "Save instructions"));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected orphan prompt update",
    );
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 9,
      bindings: [
        {
          id: "orphan-inline",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "Recovered and saved.",
          order: 3,
        },
      ],
    });
  });

  it("expands prompt rows and removes a replaced row without a live replacement", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: {
          version: 9,
          repos: [],
          prompts: [
            promptRow({
              id: "resource:active-prompt",
              resourceId: "active-prompt",
              name: "Active prompt",
              promptBody: "Active body is hidden until expanded.",
              order: 1,
            }),
            promptRow({
              id: "binding:replace-1:replaced",
              bindingId: "replace-1",
              resourceId: "team-prompt",
              replacesResourceId: null,
              name: "Overridden prompt",
              mode: "replaced",
              promptBody: "Original body is hidden until expanded.",
              order: 2,
            }),
          ],
          skills: [],
          mcp: [],
          unavailable: [],
        },
        bindings: [
          {
            id: "replace-1",
            type: "prompt",
            mode: "replace",
            resourceId: null,
            replacesResourceId: "team-prompt",
            inlinePromptBody: "",
            order: 2,
          },
          {
            id: "kept-inline",
            type: "prompt",
            mode: "include",
            resourceId: null,
            replacesResourceId: null,
            inlinePromptBody: "Keep me.",
            order: 3,
          },
        ],
      }),
    );

    const container = await renderWithProviders(<PromptTab />);
    await waitForText(container, "Active prompt");
    expect(container.textContent).not.toContain("Active body is hidden until expanded.");

    await click(container.querySelector('button[aria-label="Expand Active prompt"]'));
    expect(container.textContent).toContain("Active body is hidden until expanded.");
    await click(container.querySelector('button[aria-label="Collapse Active prompt"]'));
    expect(container.textContent).not.toContain("Active body is hidden until expanded.");

    await click(container.querySelector('button[aria-label="Expand Overridden prompt"]'));
    expect(container.textContent).toContain("Original body is hidden until expanded.");
    await click(container.querySelector('button[aria-label="More actions for Overridden prompt"]'));
    await click(buttonByText(container, "Remove"));
    await waitForCondition(
      () => agentResourceMocks.updateAgentResources.mock.calls.length > 0,
      "Expected replaced prompt removal",
    );
    expect(agentResourceMocks.updateAgentResources).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 9,
      bindings: [
        {
          id: "kept-inline",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "Keep me.",
          order: 3,
        },
      ],
    });
  });

  it("toggles the clamped effective instructions block", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 80 });
    try {
      contextMock.value = createContext({
        config: config({
          payload: {
            kind: "claude-code",
            prompt: {
              append: "Team section.\n\nCustom section.",
              sections: [
                { scope: "team", name: "Team guide", body: "Team section." },
                { scope: "agent", name: "", body: "Custom section." },
              ],
            },
            model: "sonnet",
            reasoningEffort: "medium",
            mcpServers: [],
            env: [],
            gitRepos: [],
            resourceSkills: [],
          },
        }),
      });
      agentResourceMocks.getAgentResources.mockResolvedValue(
        agentResources({
          effective: {
            version: 9,
            repos: [],
            prompts: [
              promptRow({ id: "team-guide", name: "Team guide", promptBody: "Team section.", order: 1 }),
              promptRow({
                id: "binding:inline-1:enabled",
                bindingId: "inline-1",
                source: "inline_prompt",
                scope: "agent",
                resourceId: null,
                name: "Custom instructions",
                promptBody: "Custom section.",
                order: 2,
              }),
            ],
            skills: [],
            mcp: [],
            unavailable: [],
          },
        }),
      );

      const container = await renderWithProviders(<PromptTab />);
      await waitForText(container, "All instructions");
      await waitForText(container, "Show all");
      const toggle = buttonByText(container, "Show all");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      await click(toggle);
      expect(buttonByText(container, "Collapse")?.getAttribute("aria-expanded")).toBe("true");
      await click(buttonByText(container, "Collapse"));
      expect(buttonByText(container, "Show all")?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      if (clientDescriptor) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientDescriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
  });
});

describe("ProfileEditDialog extra DOM states", () => {
  it("does not wipe unsaved fields on same-agent refresh, but resets when the agent changes", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    const renderDialog = async (nextAgent: Agent) => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={createQueryClient()}>
            <ProfileEditDialog agent={nextAgent} open onOpenChange={onOpenChange} onSave={onSave} />
          </QueryClientProvider>,
        );
      });
      await flush();
    };

    await renderDialog(agent({ uuid: "agent-1", displayName: "Nova" }));
    const displayInput = document.body.querySelector<HTMLInputElement>("#profile-display");
    if (!displayInput) throw new Error("Expected display input");
    await setInputValue(displayInput, "Unsaved local rename");

    await renderDialog(agent({ uuid: "agent-1", displayName: "Server refreshed name", avatarImageUrl: "/new.png" }));
    expect(document.body.querySelector<HTMLInputElement>("#profile-display")?.value).toBe("Unsaved local rename");

    await renderDialog(agent({ uuid: "agent-2", displayName: "Vega" }));
    expect(document.body.querySelector<HTMLInputElement>("#profile-display")?.value).toBe("Vega");
  });
});

describe("Resources and runtime extra sections", () => {
  it("surfaces resource load and save errors from the Tools & skills tab", async () => {
    const { ResourcesTab } = await import("../resources-tab.js");
    agentResourceMocks.getAgentResources.mockRejectedValueOnce(new Error("resource query failed"));

    const loadError = await renderWithProviders(<ResourcesTab />, "/agents/agent-1/capabilities");
    await waitForText(loadError, "resource query failed");

    const loadErrorRoot = roots.pop();
    if (loadErrorRoot) await act(async () => loadErrorRoot.unmount());
    document.body.innerHTML = "";

    agentResourceMocks.getAgentResources.mockResolvedValue(
      agentResources({
        effective: { version: 9, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
        availableTeamResources: [availableSkill()],
      }),
    );
    agentResourceMocks.updateAgentResources.mockRejectedValue(new Error("resource save failed"));

    const saveError = await renderWithProviders(<ResourcesTab />, "/agents/agent-1/capabilities");
    await waitForText(saveError, "Skills");
    await click(saveError.querySelector('button[aria-label="Add Skill"]'));
    await click(buttonByText(document.body, "Optional skill"));
    await waitForText(saveError, "resource save failed");
  });

  it("renders runtime binding, switch, and recovery edge states", async () => {
    const { RuntimeSection, RuntimeSwitchRecoveryNotice } = await import("../runtime-section.js");
    const onBind = vi.fn();
    const onSwitch = vi.fn();
    const onRecover = vi.fn();

    const binding = await renderPlain(
      <RuntimeSection
        runtimeProvider="codex"
        computerLabel={null}
        canBindComputer
        bindComputerPending
        onBindComputer={onBind}
      />,
    );
    expect(binding.textContent).toContain("No computer bound");
    const bindingButton = buttonByText(binding, "Binding");
    expect(bindingButton?.disabled).toBe(true);

    const error = await renderPlain(
      <RuntimeSection
        runtimeProvider="claude-code-tui"
        computerLabel={null}
        computerStatusError="lookup failed"
        canBindComputer
        onBindComputer={onBind}
        canSwitchRuntime
        runtimeSwitchPending
        onSwitchRuntime={onSwitch}
      />,
    );
    expect(error.textContent).toContain("Could not verify computer binding: lookup failed");
    expect(buttonByText(error, "Bind computer")).toBeNull();
    expect(buttonByText(error, "Switching")?.disabled).toBe(true);

    const recovery = await renderPlain(
      <RuntimeSwitchRecoveryNotice
        claim={{ claimId: null, phase: null }}
        pending
        error="recovery failed"
        onRecover={onRecover}
      />,
    );
    expect(recovery.textContent).toContain("Claim unknown is in phase unknown");
    expect(recovery.textContent).toContain("recovery failed");
    expect(buttonByText(recovery, "Recovering")?.disabled).toBe(true);
  });
});

describe("UsageTab extra DOM states", () => {
  it("grows the recent-turn query limit from Show more", async () => {
    const { UsageTab } = await import("../usage-tab.js");
    const container = await renderWithProviders(<UsageTab refetchInterval={false} />, "/agents/agent-1/usage");
    await waitForText(container, "Turn batch 10");

    await click(buttonByText(container, "Show more"));
    await waitForCondition(
      () =>
        usageMocks.getAgentUsageTurns.mock.calls.some(
          (call) => call[0] === "agent-1" && call[1]?.window === "30d" && call[1]?.limit === 30,
        ),
      "Expected usage turns to refetch with the larger limit",
    );
    await waitForText(container, "Turn batch 30");
  });
});

describe("agent detail pure helpers", () => {
  it("covers access, tab resolution, and bindability edge cases", async () => {
    const { canManageAgentDetail } = await import("../access.js");
    const { buildTabs, canEditConfigFor, resolveTabPath } = await import("../tabs.js");
    const { isBindableClient } = await import("../action-state.js");

    expect(canManageAgentDetail(undefined, "member-self", "admin")).toBe(false);
    expect(canManageAgentDetail({ managerId: "member-self" }, null, "member")).toBe(false);
    expect(canManageAgentDetail({ managerId: "member-other" }, null, "admin")).toBe(true);

    expect(canEditConfigFor(agent(), "member-self", "member")).toBe(true);
    expect(canEditConfigFor(agent({ type: "human", clientId: null }), "member-self", "admin")).toBe(false);
    expect(resolveTabPath(agent({ type: "human", clientId: null }), "member-self", "admin", "usage")).toBe("profile");
    expect(resolveTabPath(agent(), "member-other", "member", "usage")).toBe("usage");
    expect(resolveTabPath(agent(), "member-other", "member", "runtime")).toBe("profile");
    expect(buildTabs(false, false).map((tab) => tab.path)).toEqual(["profile", "capabilities", "usage"]);

    expect(isBindableClient({ status: "connected" })).toBe(true);
    expect(isBindableClient({ status: "retired" })).toBe(false);
  });
});
