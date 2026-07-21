// @vitest-environment happy-dom

import type { Agent, RuntimeProvider, UsageByAgentRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../api/activity.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type MockNewAgentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: Agent, runtime: RuntimeProvider) => void;
};

type MockSuspendDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onConfirm: () => void;
  pending: boolean;
};

type MockDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expected: string;
  onDelete: () => void;
  deleting: boolean;
};

const activityMocks = vi.hoisted(() => ({
  listClients: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  deleteAgent: vi.fn(),
  listAgents: vi.fn(),
  listAllAgents: vi.fn(),
  reactivateAgent: vi.fn(),
  suspendAgent: vi.fn(),
  updateAgent: vi.fn(),
}));

const memberMocks = vi.hoisted(() => ({
  deleteMember: vi.fn(),
  listMembers: vi.fn(),
  updateMember: vi.fn(),
}));

const usageMocks = vi.hoisted(() => ({
  getOrgUsageByAgent: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    role: "admin" as "admin" | "member",
    memberId: "member-self" as string | null,
  },
  refreshMe: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("../../../api/activity.js", () => activityMocks);

vi.mock("../../../api/agents.js", () => agentMocks);

vi.mock("../../../api/members.js", () => memberMocks);

vi.mock("../../../api/usage.js", () => usageMocks);

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ ...authMock.value, refreshMe: authMock.refreshMe }),
}));

vi.mock("../../../lib/use-member-name-map.js", () => ({
  useMemberNameMap: () => (id: string | null | undefined) => {
    if (!id) return "unknown";
    const names: Record<string, string> = {
      "member-self": "Gandy",
      "member-alice": "Alice",
      "member-bob": "Bob",
    };
    return names[id] ?? id;
  },
}));

vi.mock("../../../components/new-agent-dialog.js", async () => {
  const React = await import("react");
  return {
    NewAgentDialog: ({ open, onOpenChange, onCreated }: MockNewAgentDialogProps) => {
      if (!open) return null;
      const created: Agent = {
        uuid: "created-agent",
        name: "created",
        displayName: "Created Agent",
        type: "agent",
        managerId: "member-self",
        visibility: "organization",
        avatarColorToken: null,
        avatarImageUrl: null,
        status: "active",
        organizationId: "org-1",
        delegateMention: null,
        inboxId: "created-agent-inbox",
        metadata: {},
        source: "portal",
        clientId: "client-1",
        runtimeProvider: "claude-code",
        runtimeState: "idle",
        createdAt: NOW,
        updatedAt: NOW,
      };
      return React.createElement(
        "div",
        { role: "dialog", "aria-label": "Mock new agent" },
        React.createElement("span", null, "Mock New Agent"),
        React.createElement(
          "button",
          { type: "button", onClick: () => onCreated(created, "claude-code") },
          "Create mock agent",
        ),
        React.createElement("button", { type: "button", onClick: () => onOpenChange(false) }, "Cancel new agent"),
      );
    },
  };
});

vi.mock("../../../components/agent-lifecycle-confirm-dialog.js", async () => {
  const React = await import("react");
  return {
    AgentSuspendConfirmDialog: ({ open, onOpenChange, label, onConfirm, pending }: MockSuspendDialogProps) => {
      if (!open) return null;
      return React.createElement(
        "div",
        { role: "dialog", "aria-label": "Mock suspend agent" },
        React.createElement("span", null, `Suspend ${label}`),
        React.createElement("button", { type: "button", disabled: pending, onClick: onConfirm }, "Suspend agent"),
        React.createElement("button", { type: "button", onClick: () => onOpenChange(false) }, "Cancel suspend"),
      );
    },
    AgentDeleteConfirmDialog: ({ open, onOpenChange, expected, onDelete, deleting }: MockDeleteDialogProps) => {
      if (!open) return null;
      return React.createElement(
        "div",
        { role: "dialog", "aria-label": "Mock delete agent" },
        React.createElement("span", null, `Delete ${expected}`),
        React.createElement("button", { type: "button", disabled: deleting, onClick: onDelete }, "Delete agent"),
        React.createElement("button", { type: "button", onClick: () => onOpenChange(false) }, "Cancel delete"),
      );
    },
  };
});

vi.mock("../../invite-link-panel.js", async () => {
  const React = await import("react");
  return {
    InviteLinkPanel: () => React.createElement("div", null, "Mock invite link panel"),
  };
});

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => routerMocks.navigate,
}));

const NOW = "2026-05-28T12:00:00.000Z";

type MemberListItem = {
  id: string;
  userId: string;
  organizationId: string;
  agentId: string;
  role: string;
  createdAt: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  lastActiveAt: string | null;
};

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
    inboxId: overrides.inboxId ?? `${overrides.uuid ?? "agent-1"}-inbox`,
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId === undefined ? "client-1" : overrides.clientId,
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function member(overrides: Partial<MemberListItem> = {}): MemberListItem {
  return {
    id: overrides.id ?? "member-self",
    userId: overrides.userId ?? "user-self",
    organizationId: overrides.organizationId ?? "org-1",
    agentId: overrides.agentId ?? "human-agent-self",
    role: overrides.role ?? "admin",
    createdAt: overrides.createdAt ?? NOW,
    username: overrides.username ?? "gandy",
    displayName: overrides.displayName ?? "Gandy",
    avatarUrl: overrides.avatarUrl ?? null,
    lastActiveAt: overrides.lastActiveAt ?? null,
  };
}

function client(overrides: Partial<HubClient> = {}): HubClient {
  return {
    id: overrides.id ?? "client-1",
    userId: overrides.userId ?? "user-self",
    status: overrides.status ?? "connected",
    authState: overrides.authState ?? "ok",
    binName: overrides.binName ?? "first-tree-dev",
    sdkVersion: overrides.sdkVersion ?? "0.5.0",
    hostname: overrides.hostname ?? "gandy-macbook",
    os: overrides.os ?? "darwin",
    agentCount: overrides.agentCount ?? 1,
    connectedAt: overrides.connectedAt ?? NOW,
    lastSeenAt: overrides.lastSeenAt ?? NOW,
    capabilities: overrides.capabilities ?? {},
  };
}

function usage(agentId: string, overrides: Partial<UsageByAgentRow> = {}): UsageByAgentRow {
  return {
    agentId,
    inputTokens: overrides.inputTokens ?? 1_200,
    cachedInputTokens: overrides.cachedInputTokens ?? 2_000,
    outputTokens: overrides.outputTokens ?? 300,
    turns: overrides.turns ?? 3,
  };
}

const SELF_HUMAN_AGENT = agent({
  uuid: "human-agent-self",
  name: "gandy",
  displayName: "Gandy",
  type: "human",
  delegateMention: "agent-private",
  managerId: "member-self",
});

const ALICE_HUMAN_AGENT = agent({
  uuid: "human-agent-alice",
  name: "alice",
  displayName: "Alice",
  type: "human",
  managerId: "member-alice",
});

const NOVA = agent({
  uuid: "agent-1",
  name: "nova",
  displayName: "Nova",
  managerId: "member-self",
  visibility: "organization",
  clientId: "client-1",
});

const SCOUT = agent({
  uuid: "agent-private",
  name: "scout",
  displayName: "Scout",
  managerId: "member-self",
  visibility: "private",
  clientId: "client-1",
});

const DESIGN = agent({
  uuid: "agent-2",
  name: "design",
  displayName: "Design Critique",
  managerId: "member-alice",
  visibility: "private",
  runtimeProvider: "codex",
  clientId: "client-2",
  runtimeState: "working",
});

const SHARED_OTHER = agent({
  uuid: "agent-3",
  name: "ops",
  displayName: "Ops Helper",
  managerId: "member-alice",
  visibility: "organization",
  clientId: "client-2",
});

const DORMANT = agent({
  uuid: "agent-suspended",
  name: "dormant",
  displayName: "Dormant",
  managerId: "member-self",
  visibility: "organization",
  status: "suspended",
  runtimeState: null,
});

const UNBOUND_DORMANT = agent({
  uuid: "agent-unbound-suspended",
  name: "unbound-dormant",
  displayName: "Unbound Dormant",
  managerId: "member-self",
  visibility: "organization",
  status: "suspended",
  clientId: null,
  runtimeState: null,
});

const ALL_AGENTS = [NOVA, SCOUT, DESIGN, SHARED_OTHER, DORMANT, SELF_HUMAN_AGENT, ALICE_HUMAN_AGENT];
const MEMBER_AGENTS = [NOVA, SCOUT, SHARED_OTHER, DORMANT, SELF_HUMAN_AGENT, ALICE_HUMAN_AGENT];
const MEMBERS = [
  member(),
  member({
    id: "member-alice",
    userId: "user-alice",
    agentId: "human-agent-alice",
    role: "member",
    username: "alice",
    displayName: "Alice",
    avatarUrl: "https://avatars.example.test/u/alice.png",
  }),
];

function installBrowserStubs(): void {
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("64rem"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
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
): Promise<{ container: HTMLElement; queryClient: QueryClient; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createClient();
  queryClient.setQueryData(["chat-detail", "chat-1"], { id: "chat-1", participants: [] });
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, queryClient, root };
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

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
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

async function setSelectValue(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function exactButton(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

function seedDefaultMocks(): void {
  authMock.value = { role: "admin", memberId: "member-self" };
  activityMocks.listClients.mockResolvedValue([client(), client({ id: "client-2", hostname: "alice-linux" })]);
  agentMocks.listAllAgents.mockResolvedValue({ items: ALL_AGENTS, nextCursor: null });
  agentMocks.listAgents.mockResolvedValue({ items: MEMBER_AGENTS, nextCursor: null });
  agentMocks.updateAgent.mockImplementation(
    async (uuid: string) => ALL_AGENTS.find((item) => item.uuid === uuid) ?? NOVA,
  );
  agentMocks.suspendAgent.mockImplementation(async (uuid: string) =>
    agent({ ...(ALL_AGENTS.find((item) => item.uuid === uuid) ?? NOVA), status: "suspended" }),
  );
  agentMocks.reactivateAgent.mockImplementation(async (uuid: string) =>
    agent({ ...(ALL_AGENTS.find((item) => item.uuid === uuid) ?? DORMANT), status: "active" }),
  );
  agentMocks.deleteAgent.mockResolvedValue(undefined);
  memberMocks.listMembers.mockResolvedValue(MEMBERS);
  memberMocks.updateMember.mockImplementation(async (id: string, patch: { displayName?: string; role?: string }) => ({
    ...(MEMBERS.find((item) => item.id === id) ?? MEMBERS[0]),
    ...patch,
  }));
  memberMocks.deleteMember.mockResolvedValue(undefined);
  authMock.refreshMe.mockResolvedValue(undefined);
  usageMocks.getOrgUsageByAgent.mockImplementation(async () => ({
    rows: [usage("agent-1"), usage("agent-private", { turns: 1 }), usage("agent-2", { turns: 2 })],
  }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  installBrowserStubs();
  window.localStorage.clear();
  vi.clearAllMocks();
  routerMocks.navigate.mockClear();
  seedDefaultMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TeamPage", () => {
  it("renders admin data source and wires create, invite, filtering, usage, navigation, delegate, and agent actions", async () => {
    const { TeamPage } = await import("../index.js");
    const { container, root } = await renderDom(<TeamPage />);

    await waitForText(container, "Nova");
    expect(agentMocks.listAllAgents).toHaveBeenCalledWith({ limit: 100 });
    expect(agentMocks.listAgents).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Invite link");
    expect(container.textContent).toContain("Design Critique");
    expect(container.querySelector('[title="claude-code @ gandy-macbook"]')).not.toBeNull();
    expect(container.querySelector('img[alt="Alice"]')?.getAttribute("src")).toBe(
      "https://avatars.example.test/u/alice.png",
    );

    await click(exactButton(container, "New agent"));
    await waitForText(document.body, "Mock New Agent");
    await click(exactButton(document.body, "Create mock agent"));
    await waitForCondition(
      () => !document.body.textContent?.includes("Mock New Agent"),
      "Expected create dialog close",
    );

    await click(exactButton(container, "Invite link"));
    await waitForText(document.body, "Mock invite link panel");
    await click(buttonByText(document.body, "Close"));

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search team"]');
    if (!search) throw new Error("Search input missing");
    await setInputValue(search, "design");
    expect(container.textContent).toContain("Design Critique");
    expect(container.textContent).not.toContain("Nova");
    await setInputValue(search, "");

    await click(exactButton(container, "Mine"));
    expect(container.textContent).toContain("Nova");
    expect(container.textContent).not.toContain("Ops Helper");
    await click(exactButton(container, "All"));

    await click(container.querySelector('[aria-label="Open Nova"]'));
    expect(routerMocks.navigate).toHaveBeenCalledWith("/agents/agent-1");

    await click(container.querySelector('button[aria-label="Actions for Nova"]'));
    await click(exactButton(container, "Chat"));
    expect(routerMocks.navigate).toHaveBeenCalledWith("/?c=draft&with=agent-1");

    expect(usageMocks.getOrgUsageByAgent).toHaveBeenCalledWith("7d");

    await click(container.querySelector('button[title="Change delegate"]'));
    await waitForText(document.body, "Scout");
    await click(exactButton(document.body, "Remove delegate"));
    await waitForCondition(() => agentMocks.updateAgent.mock.calls.length > 0, "Expected delegate update");
    expect(agentMocks.updateAgent).toHaveBeenCalledWith("human-agent-self", { delegateMention: null });

    await click(container.querySelector('button[aria-label="Actions for Nova"]'));
    await click(exactButton(container, "Suspend"));
    await waitForText(document.body, "Suspend Nova");
    await click(exactButton(document.body, "Suspend agent"));
    await waitForCondition(() => agentMocks.suspendAgent.mock.calls.length > 0, "Expected suspend mutation");
    expect(agentMocks.suspendAgent.mock.calls[0]?.[0]).toBe("agent-1");

    await click(container.querySelector('button[aria-label="Actions for Dormant"]'));
    await click(exactButton(container, "Reactivate"));
    await waitForCondition(() => agentMocks.reactivateAgent.mock.calls.length > 0, "Expected reactivate mutation");
    expect(agentMocks.reactivateAgent.mock.calls[0]?.[0]).toBe("agent-suspended");

    await click(container.querySelector('button[aria-label="Actions for Dormant"]'));
    await click(exactButton(container, "Delete"));
    await waitForText(document.body, "Delete Dormant");
    await click(exactButton(document.body, "Delete agent"));
    await waitForCondition(() => agentMocks.deleteAgent.mock.calls.length > 0, "Expected delete mutation");
    expect(agentMocks.deleteAgent.mock.calls[0]?.[0]).toBe("agent-suspended");

    await act(async () => root.unmount());
  });

  it("does not offer ordinary reactivation for unbound suspended agents", async () => {
    agentMocks.listAllAgents.mockResolvedValueOnce({ items: [UNBOUND_DORMANT, SELF_HUMAN_AGENT], nextCursor: null });
    const { TeamPage } = await import("../index.js");
    const { container, root } = await renderDom(<TeamPage />);

    await waitForText(container, "Unbound Dormant");
    await click(container.querySelector('button[aria-label="Actions for Unbound Dormant"]'));

    expect(container.textContent).not.toContain("Reactivate");
    expect(exactButton(container, "Delete")).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("edits and removes human members through the profile dialog", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { TeamPage } = await import("../index.js");
    const { container, queryClient, root } = await renderDom(<TeamPage />);

    await waitForText(container, "Alice");
    await click(container.querySelector('[aria-label="Open Alice"]'));
    await waitForText(document.body, "Edit profile");

    const displayName = document.body.querySelector<HTMLInputElement>("#member-display");
    const role = document.body.querySelector<HTMLSelectElement>("#member-role");
    if (!displayName || !role) throw new Error("Member form missing");
    await setInputValue(displayName, "Alice Updated");
    await setSelectValue(role, "admin");
    await click(exactButton(document.body, "Save"));
    await waitForCondition(() => memberMocks.updateMember.mock.calls.length > 0, "Expected member update");
    expect(memberMocks.updateMember).toHaveBeenCalledWith("member-alice", {
      displayName: "Alice Updated",
      role: "admin",
    });
    expect(queryClient.getQueryState(["chat-detail", "chat-1"])?.isInvalidated).toBe(true);

    await click(container.querySelector('button[aria-label="Actions for Alice"]'));
    await click(exactButton(container, "Remove from org"));
    await waitForCondition(() => memberMocks.deleteMember.mock.calls.length > 0, "Expected member removal");
    expect(confirmSpy).toHaveBeenCalledWith("Remove Alice from the org? The human agent will be deactivated.");
    expect(memberMocks.deleteMember.mock.calls[0]?.[0]).toBe("member-alice");

    await act(async () => root.unmount());
  });

  it("refreshes AuthProvider after a combined self rename and role edit", async () => {
    memberMocks.listMembers.mockResolvedValueOnce([MEMBERS[0], member({ ...MEMBERS[1], role: "admin" })]);
    const { TeamPage } = await import("../index.js");
    const { container, queryClient, root } = await renderDom(<TeamPage />);

    await waitForText(container, "Gandy");
    await click(container.querySelector('[aria-label="Open Gandy"]'));
    await waitForText(document.body, "Edit profile");

    const displayName = document.body.querySelector<HTMLInputElement>("#member-display");
    const role = document.body.querySelector<HTMLSelectElement>("#member-role");
    if (!displayName || !role) throw new Error("Self member form missing");
    await setInputValue(displayName, "Gandy Updated");
    await setSelectValue(role, "member");
    await click(exactButton(document.body, "Save"));

    await waitForCondition(() => memberMocks.updateMember.mock.calls.length > 0, "Expected self member update");
    expect(memberMocks.updateMember).toHaveBeenCalledWith("member-self", {
      displayName: "Gandy Updated",
      role: "member",
    });
    expect(authMock.refreshMe).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(["chat-detail", "chat-1"])?.isInvalidated).toBe(true);

    await act(async () => root.unmount());
  });

  it("uses member-scoped agent listing and opens read-only profiles for non-admins", async () => {
    authMock.value = { role: "member", memberId: "member-self" };
    const { TeamPage } = await import("../index.js");
    const { container, root } = await renderDom(<TeamPage />);

    await waitForText(container, "Nova");
    expect(agentMocks.listAgents).toHaveBeenCalledWith({ limit: 100 });
    expect(agentMocks.listAllAgents).not.toHaveBeenCalled();
    // Issue 836: sharing the invite link is member-level, so the "Invite link"
    // entry is no longer admin-gated — non-admins see it too.
    expect(container.textContent).toContain("Invite link");
    expect(container.textContent).not.toContain("Design Critique");
    expect(container.textContent).toContain("Ops Helper");

    await click(container.querySelector('[aria-label="Open Alice"]'));
    await waitForText(document.body, "Profile");
    expect(document.body.textContent).not.toContain("Demoting the last admin");
    expect(exactButton(document.body, "Save")).toBeNull();
    await click(exactButton(document.body, "Close"));

    await click(container.querySelector('button[aria-label="Actions for Ops Helper"]'));
    await waitForText(container, "Chat");
    expect(exactButton(container, "Suspend")).toBeNull();

    await act(async () => root.unmount());
  });

  it("remembers the agent filter preference", async () => {
    window.localStorage.setItem("first-tree:team-agent-filter:v1", "mine");
    const { TeamPage } = await import("../index.js");
    const { container, root } = await renderDom(<TeamPage />);

    await waitForText(container, "Nova");
    expect(exactButton(container, "Mine")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).not.toContain("Ops Helper");

    await click(exactButton(container, "All"));
    expect(window.localStorage.getItem("first-tree:team-agent-filter:v1")).toBe("all");
    expect(exactButton(container, "All")?.getAttribute("aria-pressed")).toBe("true");

    await click(exactButton(container, "Mine"));
    expect(window.localStorage.getItem("first-tree:team-agent-filter:v1")).toBe("mine");

    await act(async () => root.unmount());
  });

  it("renders loading and failed states from its queries", async () => {
    const { TeamPage } = await import("../index.js");
    agentMocks.listAllAgents.mockReturnValue(new Promise(() => undefined));
    const loading = await renderDom(<TeamPage />);
    expect(loading.container.textContent).toContain("Loading");
    await act(async () => loading.root.unmount());

    agentMocks.listAllAgents.mockRejectedValueOnce(new Error("agents down"));
    const failed = await renderDom(<TeamPage />);
    await waitForText(failed.container, "Failed to load: agents down");
    await act(async () => failed.root.unmount());
  });
});
