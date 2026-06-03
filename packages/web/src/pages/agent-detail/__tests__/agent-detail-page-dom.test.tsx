// @vitest-environment happy-dom

import type { Agent, AgentRuntimeConfig } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import { ApiError } from "../../../api/client.js";

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
  reactivateAgent: vi.fn(),
  rebindAgent: vi.fn(),
  suspendAgent: vi.fn(),
  testAgentConnection: vi.fn(),
  updateAgent: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  listAgentSessions: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    memberId: "member-self",
    role: "admin",
  },
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

vi.mock("../../../api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/sessions.js")>()),
  listAgentSessions: sessionMocks.listAgentSessions,
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

const NOW = "2026-05-28T12:00:00.000Z";

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
    },
    updatedAt: overrides.updatedAt ?? NOW,
    updatedBy: overrides.updatedBy ?? "member-self",
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
              <Route path="runtime" element={child} />
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
  authMock.value = { memberId: "member-self", role: "admin" };
  agentMocks.getAgent.mockResolvedValue(agent());
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
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AgentDetailPage", () => {
  it("edits prompt draft, handles save conflict, reloads latest, and discards changes", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    const conflict = new ApiError(409, "conflict");
    agentConfigMocks.updateAgentConfig.mockRejectedValueOnce(conflict).mockResolvedValueOnce(config({ version: 9 }));
    agentConfigMocks.getAgentConfig
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(
        config({ version: 8, payload: { ...config().payload, prompt: { append: "Server latest" } } }),
      );

    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Instructions");
    expect(container.textContent).toContain("Kael");
    expect(container.textContent).toContain("1 active");
    expect(container.textContent).toContain("Chat");
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "Profile",
      "Runtime",
      "Prompt",
      "Resources",
      "Usage",
    ]);

    await click(exactButtonByText(container, "Edit instructions"));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Prompt textarea missing");
    await setValue(textarea, "New prompt");
    await click(exactButtonByText(container, "Done"));

    expect(container.textContent).toContain("Configuration changes in Prompt");
    expect(container.textContent).toContain("Prompt");
    await click(exactButtonByText(container, "Save"));
    expect(container.textContent).toContain("Someone else saved a newer version");

    await click(buttonByText(container, "Discard mine, load latest"));
    expect(agentConfigMocks.getAgentConfig).toHaveBeenCalledTimes(2);

    await click(exactButtonByText(container, "Edit instructions"));
    const latestTextarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!latestTextarea) throw new Error("Prompt textarea missing after reload");
    await setValue(latestTextarea, "Throw this away");
    await click(exactButtonByText(container, "Done"));
    await click(exactButtonByText(container, "Discard changes"));
    expect(document.body.textContent).toContain("Discard unsaved changes?");
    await click(lastExactButtonByText(document.body, "Discard changes"));
    await waitForText(container, "Server latest");
    expect(container.textContent).not.toContain("Throw this away");

    await act(async () => root.unmount());
  });

  it("starts a draft chat with the current agent from the header", async () => {
    const { PromptTab } = await import("../prompt-tab.js");
    const { container, root } = await renderDom("/agents/agent-1/prompt", <PromptTab />);
    await waitForText(container, "Instructions");

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
    expect(first.container.textContent).toContain("Model behavior");
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
    expect(second.container.textContent).toContain("Model behavior");
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
