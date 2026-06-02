// @vitest-environment happy-dom

import type { Agent, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient, RuntimeAgent } from "../../api/activity.js";
import { ToastProvider } from "../../components/ui/toast.js";
import type { OnboardingFlowValue } from "../onboarding/onboarding-flow.js";
import { ADMIN_STEPS, INVITEE_STEPS, type OnboardingPath, type StepId } from "../onboarding/steps.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const WAIT_FOR_TEXT_TIMEOUT_MS = 3_000;

const activityMocks = vi.hoisted(() => ({
  disconnectClient: vi.fn(),
  generateConnectToken: vi.fn(),
  getActivityOverview: vi.fn(),
  getClientCapabilities: vi.fn(),
  listClients: vi.fn(),
  listOrgClients: vi.fn(),
  retireClient: vi.fn(),
}));

const agentApiMocks = vi.hoisted(() => ({
  checkAgentNameAvailability: vi.fn(),
  createAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
  listManagedAgents: vi.fn(),
}));

const agentConfigMocks = vi.hoisted(() => ({
  getAgentConfig: vi.fn(),
  updateAgentConfig: vi.fn(),
}));

const chatApiMocks = vi.hoisted(() => ({
  createAgentChat: vi.fn(),
  readFileAsBase64: vi.fn(),
  sendChatMessage: vi.fn(),
  sendFileMessageBatch: vi.fn(),
}));

const githubMocks = vi.hoisted(() => ({
  listGithubRepos: vi.fn(),
}));

const githubAppMocks = vi.hoisted(() => ({
  getGithubAppInstallation: vi.fn(),
  getGithubAppInstallationExists: vi.fn(),
  getGithubAppInstallUrl: vi.fn(),
}));

const imageStoreMocks = vi.hoisted(() => ({
  putImage: vi.fn(),
}));

const memberApiMocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));

const orgSettingsMocks = vi.hoisted(() => ({
  getContextTreeSetting: vi.fn(),
  getSourceReposSetting: vi.fn(),
  putContextTreeSetting: vi.fn(),
  putSourceReposSetting: vi.fn(),
}));

const onboardingEventMocks = vi.hoisted(() => ({
  reportOnboardingEvent: vi.fn(),
}));

const meChatMocks = vi.hoisted(() => ({
  addMeChatParticipants: vi.fn(),
  createMeChat: vi.fn(),
}));

const clientApiMocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

const authMock = vi.hoisted(() => {
  const memberships: MeMembership[] = [];
  const currentMembership: MeMembership | null = null;
  const nullableString = (value: string | null): string | null => value;
  const onboardingStep = (value: "connect" | "create_agent" | "completed" | null) => value;
  return {
    value: {
      isAuthenticated: true,
      meLoaded: true,
      user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships,
      currentMembership,
      organizationId: nullableString("org-1"),
      memberId: nullableString("member-self"),
      role: nullableString("admin"),
      agentId: nullableString("human-agent-self"),
      teamDisplayName: nullableString("Acme"),
      orgHasOtherMembers: true,
      currentOrgHasUsableAgent: true,
      onboardingStep: onboardingStep("completed"),
      onboardingDismissedAt: nullableString(null),
      onboardingCompletedAt: nullableString("2026-05-01T00:00:00.000Z"),
      dismissOnboarding: vi.fn(async () => undefined),
      restoreOnboarding: vi.fn(async () => undefined),
      markOnboardingCompleted: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      adoptTokens: vi.fn(async () => undefined),
      selectOrganization: vi.fn(async () => undefined),
      refreshMe: vi.fn(async () => undefined),
      logout: vi.fn(),
    },
  };
});

vi.mock("../../api/activity.js", () => activityMocks);
vi.mock("../../api/agent-config.js", () => agentConfigMocks);
vi.mock("../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/agents.js")>()),
  ...agentApiMocks,
}));
vi.mock("../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chats.js")>()),
  ...chatApiMocks,
}));
vi.mock("../../api/github.js", () => githubMocks);
vi.mock("../../api/github-app.js", () => githubAppMocks);
vi.mock("../../api/image-store.js", () => imageStoreMocks);
vi.mock("../../api/members.js", () => memberApiMocks);
vi.mock("../../api/me-chats.js", () => meChatMocks);
vi.mock("../../api/onboarding-events.js", () => onboardingEventMocks);
vi.mock("../../api/org-settings.js", () => orgSettingsMocks);
vi.mock("../../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client.js")>();
  return {
    ...actual,
    api: { ...actual.api, post: clientApiMocks.post },
  };
});
vi.mock("../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));
vi.mock("../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => (id ? (AGENT_NAMES[id] ?? id) : "unknown"),
  useAgentIdentityMap: () => (id: string | null | undefined) =>
    id
      ? {
          name: AGENT_SLUGS[id] ?? id,
          displayName: AGENT_NAMES[id] ?? id,
          avatarImageUrl: null,
          avatarColorToken: null,
        }
      : null,
  useAgentSlugToIdMap: () => (slug: string | null | undefined) => {
    if (!slug) return null;
    return Object.entries(AGENT_SLUGS).find(([, value]) => value === slug)?.[0] ?? null;
  },
}));
vi.mock("../../lib/use-member-name-map.js", () => ({
  useMemberNameMap: () => (id: string | null | undefined) => (id ? (MEMBER_NAMES[id] ?? id) : "unknown"),
}));
vi.mock("../../lib/visibility-interval.js", () => ({
  runVisibilityAwareInterval: (tick: () => void | Promise<void>) => {
    void tick();
    return () => undefined;
  },
}));

const NOW = "2026-05-28T12:00:00.000Z";

const AGENT_NAMES: Record<string, string> = {
  "agent-1": "Kael",
  "agent-2": "Design Critique",
  "human-agent-self": "Gandy",
};

const AGENT_SLUGS: Record<string, string> = {
  "agent-1": "kael",
  "agent-2": "design",
  "human-agent-self": "gandy",
};

const MEMBER_NAMES: Record<string, string> = {
  "member-self": "Gandy",
  "member-alice": "Alice",
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "kael",
    organizationId: overrides.organizationId ?? "org-1",
    type: overrides.type ?? "agent",
    displayName: overrides.displayName ?? "Kael",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "inbox-1",
    status: overrides.status ?? "active",
    source: overrides.source ?? "portal",
    visibility: overrides.visibility ?? "organization",
    metadata: overrides.metadata ?? {},
    managerId: overrides.managerId ?? "member-self",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

const CLIENTS: HubClient[] = [
  {
    id: "client-1",
    userId: "user-self",
    status: "connected",
    authState: "ok",
    sdkVersion: "0.5.0",
    hostname: "gandy-macbook",
    os: "darwin",
    agentCount: 1,
    connectedAt: NOW,
    lastSeenAt: NOW,
    capabilities: {
      "claude-code": {
        state: "ok",
        available: true,
        authenticated: true,
        sdkVersion: "0.2.84",
        authMethod: "oauth",
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
  },
  {
    id: "client-2",
    userId: "user-alice",
    status: "disconnected",
    authState: "expired",
    sdkVersion: "0.5.0",
    hostname: "alice-linux",
    os: "linux",
    agentCount: 1,
    connectedAt: null,
    lastSeenAt: "2026-05-28T11:00:00.000Z",
    capabilities: {},
  },
];

const GITHUB_REPOS = [
  {
    fullName: "acme/web",
    cloneUrl: "https://github.com/acme/web.git",
    htmlUrl: "https://github.com/acme/web",
    private: false,
    defaultBranch: "main",
    pushedAt: NOW,
  },
  {
    fullName: "acme/api",
    cloneUrl: "git@github.com:acme/api.git",
    htmlUrl: "https://github.com/acme/api",
    private: true,
    defaultBranch: "main",
    pushedAt: NOW,
  },
];

const RUNTIME_AGENTS: RuntimeAgent[] = [
  {
    agentId: "agent-1",
    clientId: "client-1",
    runtimeType: "claude-code",
    runtimeState: "working",
    activeSessions: 1,
    totalSessions: 2,
    runtimeUpdatedAt: NOW,
    type: "agent",
    managedByMe: true,
  },
  {
    agentId: "agent-2",
    clientId: "client-2",
    runtimeType: "codex",
    runtimeState: "offline",
    activeSessions: 0,
    totalSessions: 0,
    runtimeUpdatedAt: NOW,
    type: "agent",
    managedByMe: false,
  },
];

const ORG_AGENTS = [
  agent({
    uuid: "human-agent-self",
    name: "gandy",
    displayName: "Gandy",
    type: "human",
    clientId: null,
    delegateMention: "agent-1",
  }),
  agent(),
  agent({ uuid: "agent-2", name: "design", displayName: "Design Critique", managerId: "member-alice" }),
];

const mountedRoots = new Set<Root>();

function setupDom(): void {
  const storage = createStorage();
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => undefined;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: createStorage() });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes(`1024${"px"}`),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
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
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function renderDom(
  element: ReactElement,
  route = "/",
  seed?: (queryClient: QueryClient) => void,
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.add(root);
  const queryClient = createClient();
  queryClient.setQueryData(["agents", "org-list"], { items: ORG_AGENTS, nextCursor: null });
  seed?.(queryClient);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{element}</ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function unmountRoot(root: Root): Promise<void> {
  mountedRoots.delete(root);
  await act(async () => root.unmount());
}

function createFlowValue(overrides: Partial<OnboardingFlowValue> = {}): OnboardingFlowValue {
  const path: OnboardingPath = overrides.path ?? "admin";
  const sequence: readonly StepId[] = path === "admin" ? ADMIN_STEPS : INVITEE_STEPS;
  const fallbackStep: StepId = path === "admin" ? "team" : "welcome";
  const requestedActiveStep = overrides.activeStep;
  const activeStep: StepId =
    requestedActiveStep && sequence.some((step) => step === requestedActiveStep) ? requestedActiveStep : fallbackStep;
  const activeIndex = sequence.indexOf(activeStep);
  return {
    path,
    sequence,
    activeIndex: overrides.activeIndex ?? Math.max(0, activeIndex),
    activeStep,
    goNext: vi.fn(),
    goTo: vi.fn(),
    organizationId: "org-1",
    memberId: "member-self",
    role: path === "admin" ? "admin" : "member",
    username: "gandy",
    teamDisplayName: "Acme",
    orgHasOtherMembers: true,
    computer: {
      connectedClient: CLIENTS[0] ?? null,
      capabilitiesLoaded: true,
      okRuntimes: ["claude-code", "codex"],
      selectedRuntime: "claude-code",
      setSelectedRuntime: vi.fn(),
      cliCommand: "first-tree-dev login token",
      tokenError: null,
      retry: vi.fn(),
    },
    agentDisplayName: "Gandy's assistant",
    setAgentDisplayName: vi.fn(),
    visibility: "organization",
    setVisibility: vi.fn(),
    agentPhase: "idle",
    agentError: null,
    createAgent: vi.fn(async () => undefined),
    retryAgent: vi.fn(async () => undefined),
    createdAgentUuid: "agent-1",
    hasAgent: true,
    selectedRepoUrls: ["https://github.com/acme/web.git"],
    setSelectedRepoUrls: vi.fn(),
    treeMode: "existing",
    setTreeMode: vi.fn(),
    treeUrl: "https://github.com/acme/context-tree",
    setTreeUrl: vi.fn(),
    treeAutoInitDone: true,
    markTreeAutoInitDone: vi.fn(),
    completeAndEnterChat: vi.fn(async () => undefined),
    finishLater: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function renderOnboardingDom(
  element: ReactElement,
  overrides: Partial<OnboardingFlowValue> = {},
): Promise<{ container: HTMLElement; root: Root; flow: OnboardingFlowValue }> {
  const { OnboardingFlowContext } = await import("../onboarding/onboarding-flow.js");
  const flow = createFlowValue(overrides);
  const rendered = await renderDom(
    <OnboardingFlowContext.Provider value={flow}>{element}</OnboardingFlowContext.Provider>,
  );
  return { ...rendered, flow };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForText(text: string, container: HTMLElement = document.body): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_TEXT_TIMEOUT_MS;
  do {
    if (container.textContent?.includes(text)) return;
    await flush();
  } while (Date.now() < deadline);
  throw new Error(`Missing text: ${text}\n${container.textContent ?? ""}`);
}

beforeEach(() => {
  setupDom();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = {
    ...authMock.value,
    role: "admin",
    memberId: "member-self",
    agentId: "human-agent-self",
    organizationId: "org-1",
    user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
  };
  activityMocks.listClients.mockResolvedValue(CLIENTS.filter((client) => client.userId === "user-self"));
  activityMocks.listOrgClients.mockResolvedValue(CLIENTS);
  activityMocks.getActivityOverview.mockResolvedValue({
    total: 2,
    running: 1,
    byState: { idle: 1, working: 1, blocked: 0, error: 0 },
    clients: 2,
    agents: RUNTIME_AGENTS,
  });
  activityMocks.getClientCapabilities.mockResolvedValue(CLIENTS[0]);
  activityMocks.generateConnectToken.mockResolvedValue({
    token: "connect-token",
    expiresIn: 600,
    command: "first-tree-dev login connect-token",
    bootstrapCommand: "first-tree-dev login connect-token",
    npmSpec: null,
    binName: "first-tree-dev",
  });
  activityMocks.disconnectClient.mockResolvedValue({ disconnected: true, agentIds: ["agent-1"] });
  activityMocks.retireClient.mockResolvedValue(undefined);
  agentApiMocks.checkAgentNameAvailability.mockResolvedValue({ available: true });
  agentApiMocks.createAgent.mockResolvedValue(
    agent({ uuid: "agent-created", name: "deploy-bot", displayName: "Deploy Bot" }),
  );
  agentApiMocks.getAgent.mockResolvedValue(agent({ clientId: "client-bound" }));
  agentApiMocks.listAgents.mockResolvedValue({ items: ORG_AGENTS, nextCursor: null });
  agentApiMocks.listManagedAgents.mockResolvedValue([
    {
      uuid: "agent-1",
      name: "kael",
      displayName: "Kael",
      type: "agent",
      organizationId: "org-1",
      inboxId: "inbox-1",
      visibility: "organization",
      runtimeProvider: "claude-code",
      clientId: "client-1",
      avatarImageUrl: null,
    },
  ]);
  agentConfigMocks.getAgentConfig.mockResolvedValue({
    agentId: "agent-1",
    version: 7,
    payload: {
      kind: "claude-code",
      gitRepos: [],
      prompt: { append: "" },
      mcpServers: [],
      env: [],
    },
    updatedAt: NOW,
    updatedBy: "member-self",
  });
  agentConfigMocks.updateAgentConfig.mockResolvedValue({
    agentId: "agent-1",
    version: 8,
    payload: {
      kind: "claude-code",
      gitRepos: [{ url: "https://github.com/acme/web.git" }],
      prompt: { append: "" },
      mcpServers: [],
      env: [],
    },
    updatedAt: NOW,
    updatedBy: "member-self",
  });
  chatApiMocks.createAgentChat.mockResolvedValue({ id: "chat-onboarding" });
  chatApiMocks.readFileAsBase64.mockResolvedValue("base64");
  chatApiMocks.sendChatMessage.mockResolvedValue(undefined);
  chatApiMocks.sendFileMessageBatch.mockResolvedValue(undefined);
  githubMocks.listGithubRepos.mockResolvedValue(GITHUB_REPOS);
  githubAppMocks.getGithubAppInstallation.mockResolvedValue(null);
  githubAppMocks.getGithubAppInstallationExists.mockResolvedValue(true);
  githubAppMocks.getGithubAppInstallUrl.mockResolvedValue("https://github.com/apps/first-tree/installations/new");
  imageStoreMocks.putImage.mockResolvedValue(undefined);
  memberApiMocks.listMembers.mockResolvedValue([
    {
      id: "member-self",
      userId: "user-self",
      agentId: "human-agent-self",
      username: "gandy",
      displayName: "Gandy",
      role: "admin",
      createdAt: NOW,
    },
    {
      id: "member-alice",
      userId: "user-alice",
      agentId: null,
      username: "alice",
      displayName: "Alice",
      role: "member",
      createdAt: NOW,
    },
  ]);
  meChatMocks.addMeChatParticipants.mockResolvedValue({ ok: true });
  meChatMocks.createMeChat.mockResolvedValue({ chatId: "chat-created" });
  onboardingEventMocks.reportOnboardingEvent.mockResolvedValue(undefined);
  orgSettingsMocks.getContextTreeSetting.mockResolvedValue({
    repo: "https://github.com/acme/context-tree",
    branch: "main",
  });
  orgSettingsMocks.getSourceReposSetting.mockResolvedValue({
    repos: [
      { url: "https://github.com/acme/web.git", defaultBranch: "main" },
      { url: "git@github.com:acme/api.git", defaultBranch: "main" },
    ],
  });
  orgSettingsMocks.putContextTreeSetting.mockResolvedValue({
    repo: "https://github.com/acme/context-tree",
    branch: "main",
  });
  orgSettingsMocks.putSourceReposSetting.mockResolvedValue({ repos: [] });
  clientApiMocks.post.mockResolvedValue({
    token: "connect-token",
    expiresIn: 600,
    command: "first-tree-dev login connect-token",
    bootstrapCommand: "first-tree-dev login connect-token",
    npmSpec: null,
    binName: "first-tree-dev",
  });
});

afterEach(async () => {
  for (const root of [...mountedRoots]) await unmountRoot(root);
  document.body.innerHTML = "";
});

describe("web DOM interaction coverage", () => {
  it("loads NewAgentDialog computer/runtime state and submits an agent", async () => {
    const { NewAgentDialog } = await import("../../components/new-agent-dialog.js");
    const onCreated = vi.fn();
    const { root } = await renderDom(<NewAgentDialog open onOpenChange={() => undefined} onCreated={onCreated} />);

    await waitForText("gandy-macbook");
    await waitForText("Claude Code");
    const input = document.body.querySelector<HTMLInputElement>("#new-agent-display-name");
    if (!input) throw new Error("Display name input missing");
    await setValue(input, "Deploy Bot");
    await click(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Create") ?? null,
    );

    expect(agentApiMocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deploy-bot",
        displayName: "Deploy Bot",
        clientId: "client-1",
        runtimeProvider: "claude-code",
        visibility: "private",
        organizationId: "org-1",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ uuid: "agent-created" }), "claude-code");

    await unmountRoot(root);
  });

  it("renders NewAgentDialog zero-computer recovery command", async () => {
    activityMocks.listClients.mockResolvedValue([]);
    const { NewAgentDialog } = await import("../../components/new-agent-dialog.js");
    await renderDom(<NewAgentDialog open onOpenChange={() => undefined} onCreated={() => undefined} />);

    await waitForText("No computer connected yet.");
    await waitForText("first-tree-dev login connect-token");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Copy") ?? null);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("first-tree-dev login connect-token");
  });

  it("renders ClientsPage admin groups, member empty state, and fallback banner", async () => {
    const { ClientsPage } = await import("../clients.js");
    const seedAdmin = (queryClient: QueryClient) => {
      queryClient.setQueryData(["clients", "org"], CLIENTS);
      queryClient.setQueryData(
        ["members"],
        [
          { userId: "user-self", displayName: "Gandy" },
          { userId: "user-alice", displayName: "Alice" },
        ],
      );
      queryClient.setQueryData(["activity"], { agents: RUNTIME_AGENTS, clients: CLIENTS });
    };
    const admin = await renderDom(<ClientsPage />, "/", seedAdmin);
    await waitForText("Your computers", admin.container);
    await waitForText("Team computers", admin.container);
    await click(
      [...admin.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Show")) ?? null,
    );
    await waitForText("Alice", admin.container);
    await waitForText("Auth expired", admin.container);

    await unmountRoot(admin.root);

    authMock.value = { ...authMock.value, role: "member" };
    activityMocks.listClients.mockResolvedValue([]);
    const member = await renderDom(<ClientsPage />, "/", (queryClient) => {
      queryClient.setQueryData(["clients", "me"], []);
      queryClient.setQueryData(["activity"], { agents: [], clients: [] });
    });
    await waitForText("No computers connected yet.", member.container);
    await unmountRoot(member.root);

    authMock.value = { ...authMock.value, role: "admin" };
    activityMocks.listOrgClients.mockRejectedValue(new Error("forbidden"));
    activityMocks.listClients.mockResolvedValue([CLIENTS[0]]);
    const fallback = await renderDom(<ClientsPage />);
    await waitForText("Failed to load team computers", fallback.container);
    await waitForText("gandy-macbook", fallback.container);
  });

  it("creates one-on-one and group chats from NewChatDraft", async () => {
    const { NewChatDraft } = await import("../workspace/conversations/new-chat-draft.js");
    const onCreated = vi.fn();
    const first = await renderDom(<NewChatDraft onCreated={onCreated} onShowConversations={() => undefined} />);
    await waitForText("Kael", first.container);
    const textarea = first.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Draft textarea missing");
    await setValue(textarea, "hello");
    await click(first.container.querySelector('button[aria-label="Send"]'));

    expect(meChatMocks.createMeChat).toHaveBeenCalledWith({ participantIds: ["agent-1"] });
    expect(chatApiMocks.sendChatMessage).toHaveBeenCalledWith("chat-created", "hello", ["agent-1"]);
    expect(onCreated).toHaveBeenCalledWith("chat-created");
    await unmountRoot(first.root);

    meChatMocks.createMeChat.mockClear();
    chatApiMocks.sendChatMessage.mockClear();
    const second = await renderDom(<NewChatDraft onCreated={() => undefined} />);
    await waitForText("Kael", second.container);
    await click(second.container.querySelector('button[aria-label="Add participant"]'));
    await waitForText("Design Critique", second.container);
    await click(
      [...second.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Design Critique"),
      ) ?? null,
    );
    await waitForText("Design Critique", second.container);
    const groupTextarea = second.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!groupTextarea) throw new Error("Group draft textarea missing");
    await setValue(groupTextarea, "please review @design");
    await click(second.container.querySelector('button[aria-label="Send"]'));

    expect(meChatMocks.createMeChat).toHaveBeenCalledWith({ participantIds: ["agent-1", "agent-2"] });
    expect(chatApiMocks.sendChatMessage).toHaveBeenCalledWith("chat-created", "please review @design", ["agent-2"]);
  });

  it("searches, keyboard-selects, and closes AddParticipantDropdown", async () => {
    const { AddParticipantDropdown } = await import("../../components/add-participant-dropdown.js");
    const onAdded = vi.fn();
    const first = await renderDom(
      <AddParticipantDropdown chatId="chat-1" participantIds={["agent-1"]} onAdded={onAdded} variant="inline" />,
    );

    await click(first.container.querySelector("button"));
    await waitForText("Kael", first.container);
    await waitForText("Design Critique", first.container);
    expect(first.container.querySelector('[aria-label="Already in chat"]')).toBeTruthy();
    const input = first.container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]');
    if (!input) throw new Error("search input missing");

    await setValue(input, "Design");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await flush();
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    expect(meChatMocks.addMeChatParticipants).toHaveBeenCalledWith("chat-1", { participantIds: ["agent-2"] });
    expect(onAdded).toHaveBeenCalled();
    await unmountRoot(first.root);

    const second = await renderDom(
      <AddParticipantDropdown
        chatId="chat-1"
        participantIds={["agent-1", "agent-2"]}
        onAdded={() => undefined}
        variant="icon"
      />,
    );
    await click(second.container.querySelector('button[aria-label="Add participant"]'));
    await waitForText("Kael", second.container);
    expect(second.container.querySelector('[aria-label="Already in chat"]')).toBeTruthy();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(second.container.querySelector('input[aria-label="Search agents"]')).toBeNull();
  });

  it("renders login states and builds safe OAuth links", async () => {
    const { LoginPage } = await import("../login.js");

    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hostname: "localhost" },
    });
    authMock.value = { ...authMock.value, isAuthenticated: false };
    const local = await renderDom(<LoginPage />, "/login", undefined);
    await waitForText("Sign in with GitHub", local.container);
    await waitForText("Dev: skip GitHub", local.container);
    expect(local.container.querySelector<HTMLAnchorElement>('a[href="/api/v1/auth/github/start"]')).toBeTruthy();
    await unmountRoot(local.root);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hostname: "app.example.com" },
    });
    const deepLink = await renderDom(<LoginPage />, "/login", undefined);
    expect(deepLink.container.textContent).not.toContain("Dev: skip GitHub");
    await unmountRoot(deepLink.root);

    authMock.value = { ...authMock.value, isAuthenticated: true };
    const authed = await renderDom(<LoginPage />, "/login", undefined);
    expect(authed.container.textContent).toBe("");
  });

  it("consumes OAuth fragments and reports missing tokens", async () => {
    const { OAuthCompletePage } = await import("../oauth-complete.js");
    const replaceState = vi.fn();
    Object.defineProperty(window, "history", { configurable: true, value: { replaceState } });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        hash: "#access=access-token&refresh=refresh-token&next=/team&joinPath=invite",
        pathname: "/auth/github/complete",
      },
    });

    authMock.value = { ...authMock.value, adoptTokens: vi.fn(async () => undefined) };
    const success = await renderDom(<OAuthCompletePage />, "/auth/github/complete");
    await flush();
    expect(authMock.value.adoptTokens).toHaveBeenCalledWith({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/auth/github/complete");
    expect(sessionStorage.getItem("onboarding:joinPath")).toBe("invite");
    await unmountRoot(success.root);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hash: "#access=only-access", pathname: "/auth/github/complete" },
    });
    const failure = await renderDom(<OAuthCompletePage />, "/auth/github/complete");
    await waitForText("Sign-in did not complete", failure.container);
  });

  it("renders SettingsOnboardingPage resume, hide, disabled, and completed states", async () => {
    const { SettingsOnboardingPage } = await import("../settings/onboarding.js");

    authMock.value = {
      ...authMock.value,
      onboardingStep: "create_agent",
      onboardingDismissedAt: null,
      onboardingCompletedAt: null,
      dismissOnboarding: vi.fn(async () => undefined),
    };
    const disabled = await renderDom(<SettingsOnboardingPage />);
    const hideDisabled = [...disabled.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Hide setup guide"),
    );
    expect(hideDisabled).toBeTruthy();
    expect(hideDisabled?.hasAttribute("disabled")).toBe(true);
    await unmountRoot(disabled.root);

    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      onboardingDismissedAt: null,
      onboardingCompletedAt: null,
      dismissOnboarding: vi.fn(async () => undefined),
    };
    const active = await renderDom(<SettingsOnboardingPage />);
    await click(
      [...active.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Hide setup guide"),
      ) ?? null,
    );
    expect(authMock.value.dismissOnboarding).toHaveBeenCalled();
    await unmountRoot(active.root);

    authMock.value = {
      ...authMock.value,
      onboardingDismissedAt: "2026-05-01T00:00:00.000Z",
      onboardingCompletedAt: null,
      restoreOnboarding: vi.fn(async () => undefined),
    };
    const dismissed = await renderDom(<SettingsOnboardingPage />);
    await waitForText("Setup is hidden", dismissed.container);
    await click(
      [...dismissed.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Resume setup"),
      ) ?? null,
    );
    expect(authMock.value.restoreOnboarding).toHaveBeenCalled();
    await unmountRoot(dismissed.root);

    authMock.value = { ...authMock.value, onboardingCompletedAt: "2026-05-02T00:00:00.000Z" };
    const completed = await renderDom(<SettingsOnboardingPage />);
    expect(completed.container.textContent).toBe("");
  });

  it("builds LastStepModal command, copies it, skips install on dev, and fires onBound", async () => {
    const { LastStepModal } = await import("../../components/last-step-modal.js");
    const onBound = vi.fn();
    const onClose = vi.fn();

    const unboundAgent = { ...agent({ name: "deploy bot", uuid: "agent-new" }), clientId: null };
    const modal = await renderDom(<LastStepModal agent={unboundAgent} open onClose={onClose} onBound={onBound} />);
    await waitForText("first-tree-dev agent add", document.body);
    expect(document.body.textContent).toContain(
      "first-tree-dev agent add 'deploy bot' --agent-id agent-new && first-tree-dev login connect-token",
    );
    expect(document.body.textContent).not.toContain("npm install -g");
    await click(document.body.querySelector("button"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "first-tree-dev agent add 'deploy bot' --agent-id agent-new && first-tree-dev login connect-token",
    );
    await waitForText("Waiting for your computer to connect", document.body);
    for (let index = 0; index < 20 && onBound.mock.calls.length === 0; index += 1) {
      await flush();
    }
    expect(onBound).toHaveBeenCalledWith(expect.objectContaining({ clientId: "client-bound" }));
    await click(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent?.includes("Skip for now")) ??
        null,
    );
    expect(onClose).toHaveBeenCalled();
    await unmountRoot(modal.root);

    activityMocks.generateConnectToken.mockResolvedValueOnce({
      token: "prod-token",
      expiresIn: 600,
      command: "first-tree login prod-token",
      bootstrapCommand: "npm install -g first-tree\nfirst-tree login prod-token",
      npmSpec: "first-tree",
      binName: "first-tree",
    });
    await renderDom(
      <LastStepModal
        agent={agent({ clientId: "client-1", name: "kael" })}
        open
        onClose={() => undefined}
        onBound={() => undefined}
      />,
    );
    await waitForText("npm install -g first-tree", document.body);
  });

  it("opens UserMenu, switches orgs, opens setup actions, and signs out", async () => {
    clientApiMocks.post.mockResolvedValue({});
    const { UserMenu } = await import("../../components/user-menu.js");
    const selectOrganization = vi.fn(async () => undefined);
    const logout = vi.fn();
    authMock.value = {
      ...authMock.value,
      organizationId: "org-1",
      selectOrganization,
      logout,
    };
    const getMock = async <T,>(): Promise<T> =>
      [
        { id: "org-1", displayName: "Acme", role: "admin" },
        { id: "org-2", displayName: "Beta", role: "member" },
      ] as T;
    const { api } = await import("../../api/client.js");
    const originalGet = api.get;
    api.get = getMock;

    const menu = await renderDom(<UserMenu />);
    await waitForText("", menu.container);
    await click(menu.container.querySelector('button[aria-haspopup="menu"]'));
    await waitForText("Acme", menu.container);
    await click(
      [...menu.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Beta")) ?? null,
    );
    expect(selectOrganization).toHaveBeenCalledWith("org-2");

    await click(menu.container.querySelector('button[aria-haspopup="menu"]'));
    await click(
      [...menu.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Create new team"),
      ) ?? null,
    );
    await waitForText("Create", document.body);

    await click(menu.container.querySelector('button[aria-haspopup="menu"]'));
    await click(
      [...menu.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Join with invite link"),
      ) ?? null,
    );
    await waitForText("Join", document.body);

    await click(menu.container.querySelector('button[aria-haspopup="menu"]'));
    await click(
      [...menu.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign out")) ?? null,
    );
    expect(logout).toHaveBeenCalled();
    api.get = originalGet;
  });

  it("loads, copies, rotates, and errors InviteLinkPanel", async () => {
    const { InviteLinkPanel } = await import("../invite-link-panel.js");
    const { api } = await import("../../api/client.js");
    const originalGet = api.get;
    const originalPost = api.post;
    const invite = {
      id: "invite-1",
      inviteUrl: "https://first-tree.example/invite/token-1",
      token: "token-1",
      organizationId: "org-1",
      role: "member",
      createdAt: "2026-05-28T00:00:00.000Z",
      expiresAt: "2026-06-04T00:00:00.000Z",
      revokedAt: null,
    };
    api.get = async <T,>(): Promise<T> => invite as T;
    api.post = async <T,>(): Promise<T> => ({ ...invite, inviteUrl: "https://first-tree.example/invite/token-2" }) as T;

    const panel = await renderDom(<InviteLinkPanel />);
    await waitForText("Created", panel.container);
    expect(panel.container.querySelector<HTMLInputElement>("input")?.value).toBe(
      "https://first-tree.example/invite/token-1",
    );
    await click(
      [...panel.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Copy")) ?? null,
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://first-tree.example/invite/token-1");
    await click(
      [...panel.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Rotate")) ?? null,
    );
    for (
      let index = 0;
      index < 20 &&
      panel.container.querySelector<HTMLInputElement>("input")?.value !== "https://first-tree.example/invite/token-2";
      index += 1
    ) {
      await flush();
    }
    expect(panel.container.querySelector<HTMLInputElement>("input")?.value).toBe(
      "https://first-tree.example/invite/token-2",
    );
    await unmountRoot(panel.root);

    api.get = vi.fn(async () => {
      throw new Error("load failed");
    });
    const failed = await renderDom(<InviteLinkPanel />);
    await waitForText("load failed", failed.container);
    api.get = originalGet;
    api.post = originalPost;
  });

  it("drives StepConnectCode install, skip, connected picker, and error states", async () => {
    const { ApiError } = await import("../../api/client.js");
    const { StepConnectCode } = await import("../onboarding/steps/step-connect-code.js");
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, href: "http://localhost/onboarding" },
    });

    const disconnected = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Install First Tree on GitHub", disconnected.container);
    await click(
      [...disconnected.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Install First Tree on GitHub"),
      ) ?? null,
    );
    expect(githubAppMocks.getGithubAppInstallUrl).toHaveBeenCalledWith("org-1", "/onboarding");
    expect(sessionStorage.getItem("onboarding:connect-code:install-attempt")).toBeTruthy();
    expect(assign).toHaveBeenCalledWith("https://github.com/apps/first-tree/installations/new");

    await click(
      [...disconnected.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Skip for now"),
      ) ?? null,
    );
    await waitForText("Skip connecting code?", disconnected.container);
    await click(
      [...disconnected.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Cancel")) ??
        null,
    );
    expect(disconnected.container.textContent).not.toContain("Skip connecting code?");
    await click(
      [...disconnected.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Skip for now"),
      ) ?? null,
    );
    await click(
      [...disconnected.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Skip anyway"),
      ) ?? null,
    );
    expect(disconnected.flow.goNext).toHaveBeenCalled();
    await unmountRoot(disconnected.root);

    githubAppMocks.getGithubAppInstallation.mockResolvedValueOnce({
      installationId: 42,
      accountLogin: "acme",
      accountType: "Organization",
      accountGithubId: 123,
      repositorySelection: "selected",
      permissions: {},
      events: [],
      suspended: false,
      manageUrl: "https://github.com/organizations/acme/settings/installations/42",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const setSelectedRepoUrls = vi.fn();
    const connected = await renderOnboardingDom(<StepConnectCode />, {
      activeStep: "connect-code",
      selectedRepoUrls: [],
      setSelectedRepoUrls,
      goNext: vi.fn(),
    });
    await waitForText("Which projects should your agent work on?", connected.container);
    await waitForText("acme/web", connected.container);
    await click(
      [...connected.container.querySelectorAll("label")].find((label) => label.textContent?.includes("acme/web")) ??
        null,
    );
    expect(setSelectedRepoUrls).toHaveBeenCalledWith(["https://github.com/acme/web.git"]);
    await click(
      [...connected.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Continue without a project"),
      ) ?? null,
    );
    expect(connected.flow.goNext).toHaveBeenCalled();
    await unmountRoot(connected.root);

    githubAppMocks.getGithubAppInstallation.mockResolvedValueOnce({
      installationId: 42,
      accountLogin: "acme",
      accountType: "Organization",
      accountGithubId: 123,
      repositorySelection: "selected",
      permissions: {},
      events: [],
      suspended: false,
      manageUrl: "https://github.com/organizations/acme/settings/installations/42",
      createdAt: NOW,
      updatedAt: NOW,
    });
    githubMocks.listGithubRepos.mockRejectedValueOnce(new ApiError(403, "scope missing"));
    const scopeMissing = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Reconnect GitHub with project access", scopeMissing.container);
    await unmountRoot(scopeMissing.root);

    githubAppMocks.getGithubAppInstallUrl.mockRejectedValueOnce(new ApiError(503, "not configured"));
    const notConfigured = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Install First Tree on GitHub", notConfigured.container);
    await click(
      [...notConfigured.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Install First Tree on GitHub"),
      ) ?? null,
    );
    await waitForText("Code connection isn't set up here yet.", notConfigured.container);
    await click(
      [...notConfigured.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Continue without connecting code"),
      ) ?? null,
    );
    expect(notConfigured.flow.goNext).toHaveBeenCalled();
  });

  it("drives StepKickoff admin and invitee start flows", async () => {
    const { ApiError } = await import("../../api/client.js");
    const { StepKickoff } = await import("../onboarding/steps/step-kickoff.js");

    const setTreeMode = vi.fn();
    const setTreeUrl = vi.fn();
    const markTreeAutoInitDone = vi.fn();
    const adminAutoDetect = await renderOnboardingDom(<StepKickoff />, {
      activeStep: "kickoff",
      selectedRepoUrls: ["https://github.com/acme/web.git"],
      treeMode: "new",
      treeUrl: "",
      treeAutoInitDone: false,
      setTreeMode,
      setTreeUrl,
      markTreeAutoInitDone,
    });
    await waitForText("Start building your Context Tree", adminAutoDetect.container);
    expect(markTreeAutoInitDone).toHaveBeenCalled();
    expect(setTreeMode).toHaveBeenCalledWith("existing");
    expect(setTreeUrl).toHaveBeenCalledWith("https://github.com/acme/context-tree");
    await unmountRoot(adminAutoDetect.root);

    const adminExisting = await renderOnboardingDom(<StepKickoff />, {
      activeStep: "kickoff",
      selectedRepoUrls: ["https://github.com/acme/web.git"],
      treeMode: "existing",
      treeUrl: "https://github.com/acme/context-tree",
    });
    await waitForText("Use your team's Context Tree", adminExisting.container);
    await click(
      [...adminExisting.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Start")) ??
        null,
    );
    await waitForText("Starting your agent", adminExisting.container);
    expect(agentApiMocks.listManagedAgents).toHaveBeenCalled();
    expect(chatApiMocks.createAgentChat).toHaveBeenCalledWith("agent-1");
    expect(chatApiMocks.sendChatMessage).toHaveBeenCalledWith(
      "chat-onboarding",
      expect.stringContaining("https://github.com/acme/context-tree"),
      ["agent-1"],
    );
    expect(orgSettingsMocks.putSourceReposSetting).toHaveBeenCalledWith("org-1", {
      repos: [{ url: "https://github.com/acme/web.git" }],
    });
    expect(orgSettingsMocks.putContextTreeSetting).toHaveBeenCalledWith("org-1", {
      repo: "https://github.com/acme/context-tree",
    });
    expect(adminExisting.flow.completeAndEnterChat).toHaveBeenCalledWith("chat-onboarding");
    await unmountRoot(adminExisting.root);

    const setTreeModeNew = vi.fn();
    const setTreeUrlNew = vi.fn();
    const adminNew = await renderOnboardingDom(<StepKickoff />, {
      activeStep: "kickoff",
      selectedRepoUrls: ["https://github.com/acme/web.git"],
      treeMode: "existing",
      treeUrl: "git@github.com:acme/context-tree.git",
      setTreeMode: setTreeModeNew,
      setTreeUrl: setTreeUrlNew,
    });
    await waitForText("That doesn't look like a web link", adminNew.container);
    const startButton = [...adminNew.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Start"),
    );
    expect(startButton?.hasAttribute("disabled")).toBe(true);
    await click(
      [...adminNew.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Create new instead"),
      ) ?? null,
    );
    expect(setTreeUrlNew).toHaveBeenCalledWith("");
    expect(setTreeModeNew).toHaveBeenCalledWith("new");
    await unmountRoot(adminNew.root);

    chatApiMocks.sendChatMessage.mockRejectedValueOnce(new Error("message failed"));
    const adminNoProject = await renderOnboardingDom(<StepKickoff />, {
      activeStep: "kickoff",
      selectedRepoUrls: [],
      treeMode: "new",
      treeUrl: "",
    });
    await waitForText("Start your agent", adminNoProject.container);
    await click(
      [...adminNoProject.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Start"),
      ) ?? null,
    );
    expect(chatApiMocks.createAgentChat).toHaveBeenLastCalledWith("agent-1");
    expect(adminNoProject.flow.completeAndEnterChat).toHaveBeenCalledWith("chat-onboarding");
    await unmountRoot(adminNoProject.root);

    orgSettingsMocks.getContextTreeSetting.mockResolvedValueOnce({ repo: "", branch: null });
    const inviteeWaiting = await renderOnboardingDom(<StepKickoff />, {
      path: "invitee",
      activeStep: "kickoff",
    });
    await waitForText("Waiting for your team to set up", inviteeWaiting.container);
    await click(
      [...inviteeWaiting.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Start chatting anyway"),
      ) ?? null,
    );
    expect(inviteeWaiting.flow.finishLater).toHaveBeenCalled();
    await unmountRoot(inviteeWaiting.root);

    githubAppMocks.getGithubAppInstallationExists.mockResolvedValueOnce(false);
    const inviteeNoInstall = await renderOnboardingDom(<StepKickoff />, {
      path: "invitee",
      activeStep: "kickoff",
    });
    await waitForText("your team's code isn't connected yet", inviteeNoInstall.container);
    await click(
      [...inviteeNoInstall.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Copy"),
      ) ?? null,
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    await unmountRoot(inviteeNoInstall.root);

    const inviteeConfirm = await renderOnboardingDom(<StepKickoff />, {
      path: "invitee",
      activeStep: "kickoff",
    });
    await waitForText("Your team is ready", inviteeConfirm.container);
    await click(
      [...inviteeConfirm.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Continue without a project"),
      ) ?? null,
    );
    expect(chatApiMocks.sendChatMessage).toHaveBeenCalledWith("chat-onboarding", expect.any(String), ["agent-1"]);
    expect(onboardingEventMocks.reportOnboardingEvent).toHaveBeenCalledWith(
      "tree_chat_started",
      expect.objectContaining({ joinPath: "invite" }),
    );
    await unmountRoot(inviteeConfirm.root);

    orgSettingsMocks.getSourceReposSetting.mockResolvedValueOnce({ repos: [] });
    githubMocks.listGithubRepos.mockRejectedValueOnce(new ApiError(403, "scope missing"));
    const inviteePickerScope = await renderOnboardingDom(<StepKickoff />, {
      path: "invitee",
      activeStep: "kickoff",
    });
    await waitForText("Reconnect GitHub with project access", inviteePickerScope.container);
    await unmountRoot(inviteePickerScope.root);

    orgSettingsMocks.getSourceReposSetting.mockResolvedValueOnce({ repos: [] });
    githubMocks.listGithubRepos.mockRejectedValueOnce(new Error("network"));
    const inviteePickerNetwork = await renderOnboardingDom(<StepKickoff />, {
      path: "invitee",
      activeStep: "kickoff",
    });
    await waitForText("Couldn't load your projects", inviteePickerNetwork.container);
  });

  it("edits MCP server rows through validation, stdio, and HTTP submissions", async () => {
    const { McpSection } = await import("../agent-detail/mcp-section.js");
    const onAdd = vi.fn();
    const onUpdate = vi.fn();
    const onDelete = vi.fn();
    const onUndoDelete = vi.fn();
    const items = [
      {
        key: "stdio",
        status: "unchanged" as const,
        baseline: { name: "filesystem", transport: "stdio" as const, command: "npx", args: ["-y", "server"] },
        value: { name: "filesystem", transport: "stdio" as const, command: "npx", args: ["-y", "server"] },
      },
      {
        key: "http",
        status: "deleted" as const,
        baseline: { name: "docs", transport: "http" as const, url: "https://docs.example/mcp" },
        value: { name: "docs", transport: "http" as const, url: "https://docs.example/mcp" },
      },
    ];

    const { container, root } = await renderDom(
      <McpSection
        items={items}
        otherNames={(exceptKey) => new Set(exceptKey === "stdio" ? ["docs"] : ["filesystem", "docs"])}
        toolHealth={(name) => (name === "filesystem" ? "working" : "error")}
        onAdd={onAdd}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onUndoDelete={onUndoDelete}
      />,
    );

    expect(container.textContent).toContain("Working");
    expect(container.textContent).toContain("will be removed on save");
    await click(container.querySelector('button[title="Delete"]'));
    expect(onDelete).toHaveBeenCalledWith("stdio");
    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Undo")) ?? null,
    );
    expect(onUndoDelete).toHaveBeenCalledWith("http");

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add")) ?? null,
    );
    await waitForText("Add MCP server", document.body);
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await waitForText("Name must start alphanumeric", document.body);

    const name = document.body.querySelector<HTMLInputElement>("#mcp-name");
    const command = document.body.querySelector<HTMLInputElement>("#mcp-command");
    const args = document.body.querySelector<HTMLTextAreaElement>("#mcp-args");
    if (!name || !command || !args) throw new Error("MCP stdio fields missing");
    await setValue(name, "filesystem");
    await setValue(command, "node");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await waitForText('Another MCP server is already named "filesystem".', document.body);

    await setValue(name, "browser");
    await setValue(args, '{"bad": true}');
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await waitForText("Args must be a JSON array of strings.", document.body);

    await setValue(args, '["--port", "3000"]');
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    expect(onAdd).toHaveBeenCalledWith({
      name: "browser",
      transport: "stdio",
      command: "node",
      args: ["--port", "3000"],
    });

    await click(container.querySelector('button[title="Edit"]'));
    await waitForText("Edit MCP server", document.body);
    const transport = document.body.querySelector<HTMLSelectElement>("#mcp-transport");
    if (!transport) throw new Error("MCP transport select missing");
    await act(async () => {
      transport.value = "http";
      transport.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    const url = document.body.querySelector<HTMLInputElement>("#mcp-url");
    const headers = document.body.querySelector<HTMLTextAreaElement>("#mcp-headers");
    if (!url || !headers) throw new Error("MCP http fields missing");
    await setValue(url, "not a url");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done") ?? null);
    await waitForText("URL is not valid.", document.body);

    await setValue(url, "https://browser.example/mcp");
    await setValue(headers, '{"Authorization": 123}');
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done") ?? null);
    await waitForText("Headers must be a JSON object with string values.", document.body);

    await setValue(headers, '{"Authorization": "Bearer token"}');
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done") ?? null);
    expect(onUpdate).toHaveBeenCalledWith("stdio", {
      name: "filesystem",
      transport: "http",
      url: "https://browser.example/mcp",
      headers: { Authorization: "Bearer token" },
    });

    await unmountRoot(root);
  });

  it("edits environment variable rows, reveal state, and sensitive keep-existing behavior", async () => {
    const { ENV_REDACTED_PLACEHOLDER } = await import("@first-tree/shared");
    const { EnvSection } = await import("../agent-detail/env-section.js");
    const onAdd = vi.fn();
    const onUpdate = vi.fn();
    const onDelete = vi.fn();
    const onUndoDelete = vi.fn();
    const items = [
      {
        key: "plain",
        status: "unchanged" as const,
        baseline: { key: "FIRST_TREE_ENV", value: "test", sensitive: false },
        value: { key: "FIRST_TREE_ENV", value: "test", sensitive: false },
      },
      {
        key: "secret",
        status: "unchanged" as const,
        baseline: { key: "OPENAI_API_KEY", value: ENV_REDACTED_PLACEHOLDER, sensitive: true },
        value: { key: "OPENAI_API_KEY", value: ENV_REDACTED_PLACEHOLDER, sensitive: true },
      },
      {
        key: "draft-secret",
        status: "added" as const,
        baseline: { key: "TOKEN", value: "secret-value", sensitive: true },
        value: { key: "TOKEN", value: "secret-value", sensitive: true },
      },
    ];

    const { container, root } = await renderDom(
      <EnvSection
        items={items}
        otherKeys={(exceptKey) => new Set(exceptKey === "secret" ? ["FIRST_TREE_ENV", "TOKEN"] : ["FIRST_TREE_ENV"])}
        onAdd={onAdd}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onUndoDelete={onUndoDelete}
      />,
    );

    await click(
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Reveal value"]')].find(
        (button) => !button.disabled,
      ) ?? null,
    );
    expect(container.textContent).toContain("secret-value");
    await click(container.querySelector('button[aria-label="Hide value"]'));
    expect(container.textContent).not.toContain("secret-value");
    await click(container.querySelector('button[title="Delete"]'));
    expect(onDelete).toHaveBeenCalledWith("plain");

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add")) ?? null,
    );
    await waitForText("Add environment variable", document.body);
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await waitForText("Key must match", document.body);

    const key = document.body.querySelector<HTMLInputElement>("#env-key");
    const value = document.body.querySelector<HTMLInputElement>("#env-value");
    const sensitive = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!key || !value || !sensitive) throw new Error("Env fields missing");
    await setValue(key, "first_tree_env");
    expect(key.value).toBe("FIRST_TREE_ENV");
    await setValue(value, "duplicate");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await waitForText('Another entry already uses key "FIRST_TREE_ENV".', document.body);

    await setValue(key, "NEW_SECRET");
    await setValue(value, "");
    await click(sensitive);
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await waitForText("Value is required for sensitive entries.", document.body);
    await setValue(value, "super-secret");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    expect(onAdd).toHaveBeenCalledWith({ key: "NEW_SECRET", value: "super-secret", sensitive: true });

    await click([...container.querySelectorAll('button[title="Edit"]')][1] ?? null);
    await waitForText("Edit environment variable", document.body);
    const editValue = document.body.querySelector<HTMLInputElement>("#env-value");
    if (!editValue) throw new Error("Env edit value missing");
    expect(editValue.placeholder).toBe("Leave empty to keep existing value");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done") ?? null);
    expect(onUpdate).toHaveBeenCalledWith("secret", {
      key: "OPENAI_API_KEY",
      value: ENV_REDACTED_PLACEHOLDER,
      sensitive: true,
    });

    await unmountRoot(root);
  });

  it("edits Git repository rows and validates derived local path collisions", async () => {
    const { GitSection } = await import("../agent-detail/git-section.js");
    const onAdd = vi.fn();
    const onUpdate = vi.fn();
    const onDelete = vi.fn();
    const onUndoDelete = vi.fn();
    const items = [
      {
        key: "web",
        status: "unchanged" as const,
        baseline: { url: "https://github.com/acme/web.git", localPath: "web", ref: "main" },
        value: { url: "https://github.com/acme/web.git", localPath: "web", ref: "main" },
      },
      {
        key: "api",
        status: "deleted" as const,
        baseline: { url: "git@github.com:acme/api.git", localPath: "api" },
        value: { url: "git@github.com:acme/api.git", localPath: "api" },
      },
    ];

    const { container, root } = await renderDom(
      <GitSection
        items={items}
        otherPaths={(exceptKey) => new Set(exceptKey === "web" ? ["api"] : ["web", "api"])}
        onAdd={onAdd}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onUndoDelete={onUndoDelete}
      />,
    );

    expect(container.textContent).toContain("@ main");
    await click(container.querySelector('button[title="Delete"]'));
    expect(onDelete).toHaveBeenCalledWith("web");
    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Undo")) ?? null,
    );
    expect(onUndoDelete).toHaveBeenCalledWith("api");

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add")) ?? null,
    );
    await waitForText("Add Git repository", document.body);
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await waitForText("URL is required.", document.body);

    const url = document.body.querySelector<HTMLInputElement>("#git-url");
    const ref = document.body.querySelector<HTMLInputElement>("#git-ref");
    const path = document.body.querySelector<HTMLInputElement>("#git-path");
    if (!url || !ref || !path) throw new Error("Git fields missing");
    await setValue(url, "https://github.com/acme/web.git");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    await waitForText('Another repo already occupies local path "web".', document.body);

    await setValue(url, "git@github.com:acme/docs.git");
    await setValue(ref, "main");
    await setValue(path, "docs-local");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Add") ?? null);
    expect(onAdd).toHaveBeenCalledWith({
      url: "git@github.com:acme/docs.git",
      ref: "main",
      localPath: "docs-local",
    });

    await click(container.querySelector('button[title="Edit"]'));
    await waitForText("Edit Git repository", document.body);
    const editRef = document.body.querySelector<HTMLInputElement>("#git-ref");
    const editPath = document.body.querySelector<HTMLInputElement>("#git-path");
    if (!editRef || !editPath) throw new Error("Git edit fields missing");
    await setValue(editRef, "");
    await setValue(editPath, "");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done") ?? null);
    expect(onUpdate).toHaveBeenCalledWith("web", { url: "https://github.com/acme/web.git" });

    await unmountRoot(root);
  });
});
