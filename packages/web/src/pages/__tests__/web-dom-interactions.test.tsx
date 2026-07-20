// @vitest-environment happy-dom

import type { Agent, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, type ReactNode, useState } from "react";
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
  getNewChatDefaultCandidates: vi.fn(),
  listAgents: vi.fn(),
  listManagedAgents: vi.fn(),
}));

const agentConfigMocks = vi.hoisted(() => ({
  getAgentConfig: vi.fn(),
  updateAgentConfig: vi.fn(),
}));

const attachmentMocks = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  uploadImageAttachment: vi.fn(),
  uploadMimeFor: vi.fn((file: File) => file.type || "application/octet-stream"),
}));

const chatApiMocks = vi.hoisted(() => ({
  createAgentChat: vi.fn(),
  readFileAsBase64: vi.fn(),
  sendChatMessage: vi.fn(),
  sendFileMessageBatch: vi.fn(),
}));

const githubMocks = vi.hoisted(() => ({
  listGithubRepos: vi.fn(),
  listOrgGithubRepos: vi.fn(),
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

const resourceMocks = vi.hoisted(() => ({
  createTeamResourceForOrg: vi.fn(),
  listTeamResourcesForOrg: vi.fn(),
}));

const onboardingEventMocks = vi.hoisted(() => {
  const startOnboardingChat = vi.fn();
  const treeSetupStartChat = vi.fn();
  return {
    reportOnboardingEvent: vi.fn(),
    startOnboardingChat,
    postOnboardingStartChat: startOnboardingChat,
    postTreeSetupStartChat: treeSetupStartChat,
    treeSetupStartChat,
    getTreeSetupStatus: vi.fn(),
  };
});

const meChatMocks = vi.hoisted(() => ({
  addMeChatParticipants: vi.fn(),
  createMeChat: vi.fn(),
  createMeTaskChat: vi.fn(),
  listMeChats: vi.fn(),
}));

const clientApiMocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

const contextTreeMocks = vi.hoisted(() => ({
  initializeContextTree: vi.fn(),
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
      currentOrgHasPersonalAgent: true,
      onboardingStep: onboardingStep("completed"),
      onboardingDismissedAt: nullableString(null),
      onboardingCompletedAt: nullableString("2026-05-01T00:00:00.000Z"),
      dismissOnboarding: vi.fn(async () => undefined),
      restoreOnboarding: vi.fn(async () => undefined),
      markOnboardingCompleted: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      adoptTokens: vi.fn(async () => undefined),
      selectOrganization: vi.fn(async () => undefined),
      switchingOrg: null,
      setSwitchingOrg: vi.fn(),
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
vi.mock("../../api/attachments.js", () => attachmentMocks);
vi.mock("../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/chats.js")>()),
  ...chatApiMocks,
}));
vi.mock("../../api/context-tree.js", () => contextTreeMocks);
vi.mock("../../api/github.js", () => githubMocks);
vi.mock("../../api/github-app.js", () => githubAppMocks);
vi.mock("../../api/image-store.js", () => imageStoreMocks);
vi.mock("../../api/members.js", () => memberApiMocks);
vi.mock("../../api/me-chats.js", () => meChatMocks);
vi.mock("../../api/onboarding-events.js", () => onboardingEventMocks);
vi.mock("../../api/org-settings.js", () => orgSettingsMocks);
vi.mock("../../api/resources.js", () => resourceMocks);
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
const PROD_INSTALLER_URL = "https://download.first-tree.ai/releases/prod/install.sh";
const PROD_BOOTSTRAP_COMMAND = `curl -fsSL ${PROD_INSTALLER_URL} | sh\n~/.local/bin/first-tree login connect-token`;

const AGENT_NAMES: Record<string, string> = {
  "agent-1": "Nova",
  "agent-2": "Design Critique",
  "human-agent-self": "Gandy",
};

const AGENT_SLUGS: Record<string, string> = {
  "agent-1": "nova",
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
    name: overrides.name ?? "nova",
    organizationId: overrides.organizationId ?? "org-1",
    type: overrides.type ?? "agent",
    displayName: overrides.displayName ?? "Nova",
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
    binName: "first-tree-dev",
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
        sdkVersion: "0.2.84",
        detectedAt: NOW,
      },
      codex: {
        state: "ok",
        available: true,
        sdkVersion: "0.134.0",
        detectedAt: NOW,
      },
    },
  },
  {
    id: "client-2",
    userId: "user-alice",
    status: "disconnected",
    authState: "expired",
    binName: "first-tree-dev",
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
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
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

type FlowOverrides = Partial<Omit<OnboardingFlowValue, "activeStep">> & {
  activeStep?: StepId | "connect-code";
};

function createFlowValue(overrides: FlowOverrides = {}): OnboardingFlowValue {
  const path: OnboardingPath = overrides.path ?? "admin";
  const sequence: readonly StepId[] = path === "admin" ? ADMIN_STEPS : INVITEE_STEPS;
  const fallbackStep: StepId = path === "admin" ? "create-team" : "join-team";
  const requestedActiveStep = overrides.activeStep;
  const activeStep: StepId =
    requestedActiveStep && (sequence as readonly string[]).includes(requestedActiveStep)
      ? (requestedActiveStep as StepId)
      : fallbackStep;
  const activeIndex = sequence.indexOf(activeStep);
  const base: OnboardingFlowValue = {
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
    hasRepoDraft: true,
    treeBindingPlan: "useBoundTree",
    setTreeBindingPlan: vi.fn(),
    treeUrl: "https://github.com/acme/context-tree",
    setTreeUrl: vi.fn(),
    treeAutoDetectDone: true,
    markTreeAutoDetectDone: vi.fn(),
    completeAndEnterChat: vi.fn(async () => undefined),
    finishLater: vi.fn(async () => undefined),
  };
  return {
    ...base,
    ...overrides,
    sequence,
    activeIndex: overrides.activeIndex ?? Math.max(0, activeIndex),
    activeStep,
  };
}

async function renderOnboardingDom(
  element: ReactElement,
  overrides: FlowOverrides = {},
  seed?: (queryClient: QueryClient) => void,
): Promise<{ container: HTMLElement; root: Root; flow: OnboardingFlowValue }> {
  const { OnboardingFlowContext } = await import("../onboarding/onboarding-flow.js");
  const flow = createFlowValue(overrides);
  const rendered = await renderDom(
    <OnboardingFlowContext.Provider value={flow}>{element}</OnboardingFlowContext.Provider>,
    "/",
    seed,
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

async function changeFiles(el: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(el, "files", { configurable: true, value: files });
  await act(async () => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function pasteFiles(el: Element, files: File[]): Promise<void> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { configurable: true, value: { files } });
  await act(async () => {
    el.dispatchEvent(event);
  });
  await flush();
}

async function dropFiles(el: Element, files: File[]): Promise<void> {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { configurable: true, value: { files } });
  await act(async () => {
    el.dispatchEvent(event);
  });
  await flush();
}

async function keyDown(el: Element, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_TEXT_TIMEOUT_MS;
  do {
    if (predicate()) return;
    await flush();
  } while (Date.now() < deadline);
  throw new Error(message);
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
    installerUrl: null,
    binName: "first-tree-dev",
  });
  activityMocks.disconnectClient.mockResolvedValue({ disconnected: true, agentIds: ["agent-1"] });
  activityMocks.retireClient.mockResolvedValue(undefined);
  agentApiMocks.checkAgentNameAvailability.mockResolvedValue({ available: true });
  agentApiMocks.createAgent.mockResolvedValue(
    agent({ uuid: "agent-created", name: "deploy-bot", displayName: "Deploy Bot" }),
  );
  agentApiMocks.getNewChatDefaultCandidates.mockResolvedValue({
    agent: agent({ uuid: "agent-1" }),
  });
  agentApiMocks.listAgents.mockResolvedValue({ items: ORG_AGENTS, nextCursor: null });
  agentApiMocks.listManagedAgents.mockResolvedValue([
    {
      uuid: "agent-1",
      name: "nova",
      displayName: "Nova",
      type: "agent",
      organizationId: "org-1",
      inboxId: "inbox-1",
      visibility: "organization",
      runtimeProvider: "claude-code",
      clientId: "client-1",
      status: "active",
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
  attachmentMocks.uploadAttachment.mockImplementation(async (file: File) => ({
    id: file.name === "brief.pdf" ? "11111111-1111-4111-8111-111111111111" : "uploaded-image",
    mimeType: file.type || "application/octet-stream",
    filename: file.name,
    sizeBytes: file.size,
    uploadedBy: "member-self",
    createdAt: NOW,
  }));
  attachmentMocks.uploadImageAttachment.mockImplementation((file: File) => attachmentMocks.uploadAttachment(file));
  chatApiMocks.createAgentChat.mockResolvedValue({ id: "chat-onboarding" });
  chatApiMocks.readFileAsBase64.mockResolvedValue("base64");
  chatApiMocks.sendChatMessage.mockResolvedValue(undefined);
  chatApiMocks.sendFileMessageBatch.mockResolvedValue(undefined);
  githubMocks.listGithubRepos.mockResolvedValue(GITHUB_REPOS);
  githubMocks.listOrgGithubRepos.mockResolvedValue(GITHUB_REPOS);
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
  meChatMocks.createMeTaskChat.mockResolvedValue({ chatId: "chat-created" });
  meChatMocks.listMeChats.mockResolvedValue({ rows: [], nextCursor: null });
  onboardingEventMocks.reportOnboardingEvent.mockResolvedValue(undefined);
  onboardingEventMocks.startOnboardingChat.mockResolvedValue({ chatId: "chat-onboarding" });
  onboardingEventMocks.treeSetupStartChat.mockResolvedValue({ chatId: "chat-tree-setup" });
  onboardingEventMocks.getTreeSetupStatus.mockResolvedValue({
    needsTreeSetup: false,
    hasTreeBinding: true,
    hasTreeSetupStartChat: true,
  });
  contextTreeMocks.initializeContextTree.mockResolvedValue({
    repo: "https://github.com/acme/context-tree",
    htmlUrl: "https://github.com/acme/context-tree",
    defaultBranch: "main",
  });
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
  resourceMocks.createTeamResourceForOrg.mockResolvedValue({
    id: "resource-repo",
    organizationId: "org-1",
    type: "repo",
    scope: "team",
    ownerAgentId: null,
    name: "web",
    repoCanonicalKey: "github.com/acme/web",
    defaultEnabled: "recommended",
    status: "active",
    payload: { url: "https://github.com/acme/web.git" },
    createdBy: "member-self",
    updatedBy: "member-self",
    createdAt: NOW,
    updatedAt: NOW,
  });
  resourceMocks.listTeamResourcesForOrg.mockResolvedValue([
    {
      id: "resource-web",
      organizationId: "org-1",
      type: "repo",
      scope: "team",
      ownerAgentId: null,
      name: "web",
      repoCanonicalKey: "github.com/acme/web",
      defaultEnabled: "recommended",
      status: "active",
      payload: { url: "https://github.com/acme/web.git" },
      createdBy: "member-self",
      updatedBy: "member-self",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "resource-api",
      organizationId: "org-1",
      type: "repo",
      scope: "team",
      ownerAgentId: null,
      name: "api",
      repoCanonicalKey: "github.com/acme/api",
      defaultEnabled: "recommended",
      status: "active",
      payload: { url: "git@github.com:acme/api.git" },
      createdBy: "member-self",
      updatedBy: "member-self",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  clientApiMocks.post.mockResolvedValue({
    token: "connect-token",
    expiresIn: 600,
    command: "first-tree login connect-token",
    bootstrapCommand: PROD_BOOTSTRAP_COMMAND,
    installerUrl: PROD_INSTALLER_URL,
    binName: "first-tree",
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
    await waitForText("~/.local/bin/first-tree login connect-token");
    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Copy") ?? null);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(PROD_BOOTSTRAP_COMMAND);
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
    const cacheKey = "first-tree:new-chat-default-agent:user-self:org-1";
    const onCreated = vi.fn();
    const first = await renderDom(<NewChatDraft onCreated={onCreated} onShowConversations={() => undefined} />);
    await waitForText("Nova", first.container);
    expect(agentApiMocks.getNewChatDefaultCandidates).toHaveBeenLastCalledWith({ cachedAgentId: null });
    const textarea = first.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Draft textarea missing");
    await setValue(textarea, "hello");
    await click(first.container.querySelector('button[aria-label="Send"]'));

    expect(meChatMocks.createMeTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: ["agent-1"],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      initialMessage: {
        format: "text",
        content: "hello",
        source: "web",
      },
    });
    expect(chatApiMocks.sendChatMessage).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith("chat-created");
    expect(window.localStorage.getItem(cacheKey)).toBe("agent-1");
    await unmountRoot(first.root);

    meChatMocks.createMeTaskChat.mockClear();
    chatApiMocks.sendChatMessage.mockClear();
    const second = await renderDom(<NewChatDraft onCreated={() => undefined} />);
    await waitForText("Nova", second.container);
    expect(agentApiMocks.getNewChatDefaultCandidates).toHaveBeenLastCalledWith({ cachedAgentId: "agent-1" });
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

    expect(meChatMocks.createMeTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: ["agent-2"],
      initialRecipientNames: [],
      contextParticipantAgentIds: ["agent-1"],
      contextParticipantNames: [],
      initialMessage: {
        format: "text",
        content: "please review @design",
        source: "web",
      },
    });
    expect(chatApiMocks.sendChatMessage).not.toHaveBeenCalled();
    await unmountRoot(second.root);

    meChatMocks.createMeTaskChat.mockClear();
    const humanOnly = await renderDom(
      <NewChatDraft onCreated={() => undefined} initialParticipantIds={["human-agent-self"]} />,
    );
    await waitForText("human-agent-self", humanOnly.container);
    const humanTextarea = humanOnly.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!humanTextarea) throw new Error("Human-only draft textarea missing");
    await setValue(humanTextarea, "hello human");
    await click(humanOnly.container.querySelector('button[aria-label="Send"]'));

    expect(meChatMocks.createMeTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: ["human-agent-self"],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      initialMessage: {
        format: "text",
        content: "hello human",
        source: "web",
      },
    });
    expect(window.localStorage.getItem(cacheKey)).toBeNull();
    await unmountRoot(humanOnly.root);

    const afterHumanOnly = await renderDom(<NewChatDraft onCreated={() => undefined} />);
    await waitForText("Nova", afterHumanOnly.container);
    expect(agentApiMocks.getNewChatDefaultCandidates).toHaveBeenLastCalledWith({ cachedAgentId: null });
    await unmountRoot(afterHumanOnly.root);

    agentApiMocks.getNewChatDefaultCandidates.mockImplementation(
      async ({ cachedAgentId }: { cachedAgentId?: string | null }) => ({
        agent:
          cachedAgentId === "agent-off-page"
            ? agent({ uuid: "agent-off-page", name: "off-page", displayName: "Off Page" })
            : agent({ uuid: "agent-1" }),
      }),
    );
    meChatMocks.createMeTaskChat.mockClear();
    const offPage = await renderDom(
      <NewChatDraft onCreated={() => undefined} initialParticipantIds={["agent-off-page"]} />,
    );
    await waitForText("agent-off-page", offPage.container);
    const offPageTextarea = offPage.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!offPageTextarea) throw new Error("Off-page draft textarea missing");
    await setValue(offPageTextarea, "hello off page");
    await click(offPage.container.querySelector('button[aria-label="Send"]'));

    expect(meChatMocks.createMeTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: ["agent-off-page"],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      initialMessage: {
        format: "text",
        content: "hello off page",
        source: "web",
      },
    });
    expect(window.localStorage.getItem(cacheKey)).toBe("agent-off-page");
    await unmountRoot(offPage.root);

    const afterOffPage = await renderDom(<NewChatDraft onCreated={() => undefined} />);
    await waitForText("Off Page", afterOffPage.container);
    expect(agentApiMocks.getNewChatDefaultCandidates).toHaveBeenLastCalledWith({ cachedAgentId: "agent-off-page" });
    await unmountRoot(afterOffPage.root);
  });

  it("drives NewChatDraft participants, mention autocomplete, image send, and error paths", async () => {
    const { NewChatDraft } = await import("../workspace/conversations/new-chat-draft.js");
    agentApiMocks.listAgents.mockImplementation(async (params?: { query?: string }) => {
      const query = params?.query?.trim().toLowerCase() ?? "";
      const items =
        query.length === 0
          ? ORG_AGENTS
          : ORG_AGENTS.filter(
              (item) =>
                item.displayName.toLowerCase().includes(query) || (item.name?.toLowerCase().includes(query) ?? false),
            );
      return { items, nextCursor: null };
    });
    const onCreated = vi.fn();
    const onShowConversations = vi.fn();
    const rendered = await renderDom(
      <NewChatDraft
        onCreated={onCreated}
        onShowConversations={onShowConversations}
        initialParticipantIds={["agent-2"]}
      />,
    );

    await waitForText("Design Critique", rendered.container);
    await click(rendered.container.querySelector('button[aria-label="Show conversations"]'));
    expect(onShowConversations).toHaveBeenCalledTimes(1);

    await click(rendered.container.querySelector('button[title="Remove participant"]'));
    expect(rendered.container.textContent).not.toContain("Design Critique");
    expect(rendered.container.querySelector('button[aria-label="Send"]')?.getAttribute("title")).toBe(
      "Add at least one participant",
    );

    await click(rendered.container.querySelector('button[aria-label="Add participant"]'));
    await waitForText("Nova", rendered.container);
    const search = rendered.container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]');
    if (!search) throw new Error("Participant search missing");
    await setValue(search, "nobody");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await flush();
    await waitForText("No agents match", rendered.container);
    await setValue(search, "Nova");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await flush();
    await keyDown(search, "ArrowDown");
    await keyDown(search, "ArrowUp");
    await keyDown(search, "Enter");
    await waitForText("Nova", rendered.container);

    await click(rendered.container.querySelector('button[aria-label="Add participant"]'));
    await waitForText("Design Critique", rendered.container);
    const designButton = [...rendered.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Design Critique"),
    );
    await act(async () => {
      designButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await click(designButton ?? null);
    await waitForText("Design Critique", rendered.container);
    await click(rendered.container.querySelector('button[aria-label="Add participant"]'));
    expect(rendered.container.querySelector('[title*="already in this draft"]')).toBeTruthy();
    expect(rendered.container.querySelector('[aria-label="Already in draft"]')).toBeTruthy();
    await keyDown(
      rendered.container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]') ?? search,
      "Escape",
    );

    const textarea = rendered.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Draft textarea missing");
    await setValue(textarea, "group caption");
    expect(rendered.container.textContent).toContain("@ a group member to send");
    expect(rendered.container.querySelector('button[aria-label="Send"]')?.getAttribute("title")).toBe(
      "Group chats need an @ to wake at least one participant",
    );

    const pasted = new File(["abc"], "pasted.png", { type: "image/png" });
    await pasteFiles(textarea, [pasted]);
    expect(rendered.container.querySelector('img[alt="pasted.png"]')).toBeTruthy();
    await click(rendered.container.querySelector('button[title="Remove image"]'));
    expect(rendered.container.querySelector('img[alt="pasted.png"]')).toBeNull();

    const dropped = new File(["def"], "dropped.png", { type: "image/png" });
    await dropFiles(rendered.container.querySelector('[style*="box-shadow"]') ?? rendered.container, [dropped]);
    expect(rendered.container.querySelector('img[alt="dropped.png"]')).toBeTruthy();
    await setValue(textarea, "@design image attached");
    await keyDown(textarea, "Enter");
    await waitForCondition(() => meChatMocks.createMeTaskChat.mock.calls.length > 0, "Expected image task create");
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(dropped);
    expect(imageStoreMocks.putImage).toHaveBeenCalledWith(
      {
        imageId: "uploaded-image",
        base64: "base64",
        mimeType: "image/png",
      },
      expect.objectContaining({ key: expect.any(String), revision: expect.any(Number) }),
    );
    expect(meChatMocks.createMeTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: ["agent-2"],
      initialRecipientNames: [],
      contextParticipantAgentIds: ["agent-1"],
      contextParticipantNames: [],
      initialMessage: {
        format: "file",
        content: {
          caption: "@design image attached",
          attachments: [{ imageId: "uploaded-image", mimeType: "image/png", filename: "dropped.png", size: 3 }],
        },
        source: "web",
      },
    });
    expect(onCreated).toHaveBeenCalledWith("chat-created");

    await unmountRoot(rendered.root);

    chatApiMocks.sendFileMessageBatch.mockClear();
    chatApiMocks.sendChatMessage.mockClear();
    meChatMocks.createMeTaskChat.mockClear();
    meChatMocks.createMeTaskChat.mockResolvedValueOnce({ chatId: "image-only-chat" });
    const imageOnly = await renderDom(<NewChatDraft onCreated={onCreated} initialParticipantIds={["agent-1"]} />);
    await waitForText("Nova", imageOnly.container);
    const imageOnlyInput = imageOnly.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!imageOnlyInput) throw new Error("Image-only file input missing");
    const imageOnlyFile = new File(["ghi"], "only.png", { type: "image/png" });
    await changeFiles(imageOnlyInput, [imageOnlyFile]);
    await click(imageOnly.container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => meChatMocks.createMeTaskChat.mock.calls.length > 0, "Expected image-only task create");
    expect(meChatMocks.createMeTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: ["agent-1"],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      initialMessage: {
        format: "file",
        content: {
          attachments: [{ imageId: "uploaded-image", mimeType: "image/png", filename: "only.png", size: 3 }],
        },
        source: "web",
      },
    });
    expect(onCreated).toHaveBeenCalledWith("image-only-chat");
    await unmountRoot(imageOnly.root);

    meChatMocks.createMeTaskChat.mockClear();
    meChatMocks.createMeTaskChat.mockResolvedValueOnce({ chatId: "document-only-chat" });
    const documentOnly = await renderDom(<NewChatDraft onCreated={onCreated} initialParticipantIds={["agent-1"]} />);
    await waitForText("Nova", documentOnly.container);
    const documentOnlyInput = documentOnly.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!documentOnlyInput) throw new Error("Document-only file input missing");
    const documentFile = new File(["pdf"], "brief.pdf", { type: "application/pdf" });
    await changeFiles(documentOnlyInput, [documentFile]);
    await waitForText("brief.pdf", documentOnly.container);
    await click(documentOnly.container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(
      () => meChatMocks.createMeTaskChat.mock.calls.length > 0,
      "Expected document-only task create",
    );
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(documentFile);
    expect(meChatMocks.createMeTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: ["agent-1"],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      initialMessage: {
        format: "text",
        content: "",
        metadata: {
          attachments: [
            {
              attachmentId: "11111111-1111-4111-8111-111111111111",
              kind: "file",
              mimeType: "application/pdf",
              filename: "brief.pdf",
              size: 3,
            },
          ],
        },
        source: "web",
      },
    });
    expect(onCreated).toHaveBeenCalledWith("document-only-chat");
    await unmountRoot(documentOnly.root);
  });

  it("searches, keyboard-selects, and closes AddParticipantDropdown", async () => {
    const { AddParticipantDropdown } = await import("../../components/add-participant-dropdown.js");
    const onAdded = vi.fn();
    const first = await renderDom(
      <AddParticipantDropdown chatId="chat-1" participantIds={["agent-1"]} onAdded={onAdded} variant="inline" />,
    );

    await click(first.container.querySelector("button"));
    await waitForText("Nova", first.container);
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
    await waitForText("Nova", second.container);
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
    await waitForText("Continue with GitHub", local.container);
    await waitForText("only your GitHub identity", local.container);
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

  it("renders friendly copy for callback error fragments", async () => {
    const { OAuthCompletePage } = await import("../oauth-complete.js");
    const replaceState = vi.fn();
    Object.defineProperty(window, "history", { configurable: true, value: { replaceState } });

    // Expired/consumed state — the most common real-world trigger is the
    // user spending >10min on GitHub's repo picker.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        hash: "#error=state-expired&next=/settings/github",
        pathname: "/auth/github/complete",
      },
    });
    const expired = await renderDom(<OAuthCompletePage />, "/auth/github/complete");
    await waitForText("took too long or was already used", expired.container);
    const back = expired.container.querySelector<HTMLAnchorElement>("a");
    expect(back?.getAttribute("href")).toBe("/settings/github");
    await unmountRoot(expired.root);

    // Install refused: start-chat admin's authority no longer holds.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, hash: "#error=install-not-admin", pathname: "/auth/github/complete" },
    });
    const notAdmin = await renderDom(<OAuthCompletePage />, "/auth/github/complete");
    await waitForText("admin of the First Tree team", notAdmin.container);
    // No `next` in the fragment → the way out defaults to the app root.
    expect(notAdmin.container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe("/");
    await unmountRoot(notAdmin.root);
  });

  it("activates the callback org only when the server pins it", async () => {
    const { OAuthCompletePage } = await import("../oauth-complete.js");
    Object.defineProperty(window, "history", {
      configurable: true,
      value: { replaceState: vi.fn() },
    });

    // A pinned destination (install-return keeps joinPath="returning" yet
    // names a specific org): the SPA must activate it, otherwise a concurrent
    // org switch would strand the Settings page on the user's last-used org.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        hash: "#access=a&refresh=r&next=/settings/github&joinPath=returning&org=org-b&orgPinned=1",
        pathname: "/auth/github/complete",
      },
    });
    const pinnedSelect = vi.fn(async () => undefined);
    authMock.value = {
      ...authMock.value,
      adoptTokens: vi.fn(async () => undefined),
      selectOrganization: pinnedSelect,
    };
    const pinned = await renderDom(<OAuthCompletePage />, "/auth/github/complete");
    await flush();
    expect(pinnedSelect).toHaveBeenCalledWith("org-b");
    await unmountRoot(pinned.root);

    // A plain returning sign-in carries no pin: the SPA keeps the user's own
    // last-used org (restored by adoptTokens → fetchMe) instead of activating
    // the callback's default org.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        hash: "#access=a&refresh=r&next=/&joinPath=returning&org=org-default",
        pathname: "/auth/github/complete",
      },
    });
    const plainSelect = vi.fn(async () => undefined);
    authMock.value = {
      ...authMock.value,
      adoptTokens: vi.fn(async () => undefined),
      selectOrganization: plainSelect,
    };
    const plain = await renderDom(<OAuthCompletePage />, "/auth/github/complete");
    await flush();
    expect(plainSelect).not.toHaveBeenCalled();
    await unmountRoot(plain.root);
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

  it("switches orgs and opens setup actions from the TeamSwitcher, and signs out from the UserMenu", async () => {
    clientApiMocks.post.mockResolvedValue({});
    const { TeamSwitcher } = await import("../../components/team-switcher.js");
    const { UserMenu } = await import("../../components/user-menu.js");
    const selectOrganization = vi.fn(async () => undefined);
    const logout = vi.fn();
    authMock.value = {
      ...authMock.value,
      organizationId: "org-1",
      teamDisplayName: "Acme",
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

    // Team switching + management live in the header-left TeamSwitcher now.
    const switcher = await renderDom(<TeamSwitcher redirectHomeOnSwitch={false} />);
    await click(switcher.container.querySelector('button[aria-haspopup="menu"]'));
    await waitForText("Beta", switcher.container);
    await click(
      [...switcher.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Beta")) ?? null,
    );
    expect(selectOrganization).toHaveBeenCalledWith("org-2");

    await click(switcher.container.querySelector('button[aria-haspopup="menu"]'));
    await click(
      [...switcher.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Create new team"),
      ) ?? null,
    );
    await waitForText("Create", document.body);

    await click(switcher.container.querySelector('button[aria-haspopup="menu"]'));
    await click(
      [...switcher.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Join with invite link"),
      ) ?? null,
    );
    await waitForText("Join", document.body);

    // The avatar menu is account-only: no team rows, just Sign out.
    const account = await renderDom(<UserMenu />);
    await click(account.container.querySelector('button[aria-haspopup="menu"]'));
    expect(account.container.textContent).not.toContain("Beta");
    expect(account.container.textContent).not.toContain("Create new team");
    await click(
      [...account.container.querySelectorAll("button")].find((button) => button.textContent?.includes("Sign out")) ??
        null,
    );
    expect(logout).toHaveBeenCalled();
    api.get = originalGet;
  });

  it("shows the current team in the header and lists the other teams without a collapse", async () => {
    const { TeamSwitcher } = await import("../../components/team-switcher.js");
    authMock.value = {
      ...authMock.value,
      organizationId: "org-current",
      role: "admin",
      teamDisplayName: "Current Team",
      selectOrganization: vi.fn(async () => undefined),
    };
    const getMock = async <T,>(): Promise<T> =>
      [
        { id: "org-1", displayName: "Alpha", role: "member" },
        { id: "org-2", displayName: "Beta", role: "member" },
        { id: "org-3", displayName: "Gamma", role: "admin" },
        { id: "org-4", displayName: "Delta", role: "member" },
        { id: "org-5", displayName: "Epsilon", role: "member" },
        { id: "org-6", displayName: "Zeta", role: "member" },
        { id: "org-current", displayName: "Current Team", role: "admin" },
      ] as T;
    const { api } = await import("../../api/client.js");
    const originalGet = api.get;
    api.get = getMock;

    const switcher = await renderDom(<TeamSwitcher redirectHomeOnSwitch={false} />);
    await click(switcher.container.querySelector('button[aria-haspopup="menu"]'));
    await waitForText("Current Team", switcher.container);

    // The current team is the menu header; the switch list is the OTHER teams,
    // all shown (scroll, not a "View N more" collapse), with no duplicate row.
    const teamNames = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Current Team"];
    const switchRowNames = [...switcher.container.querySelectorAll("button[role='menuitem']")]
      .map((button) => teamNames.find((name) => button.textContent?.includes(name)))
      .filter((name): name is string => Boolean(name));
    expect(switchRowNames).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]);
    expect(switcher.container.textContent).toContain("Epsilon");
    expect(switcher.container.textContent).not.toContain("View 2 more teams");
    expect(switcher.container.textContent).not.toContain("Show fewer teams");
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
    // connect-code opens the install in a new tab (popup) and fills its location
    // once the URL is minted; stub window.open to capture that.
    const installTab = { location: { href: "" }, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(installTab as unknown as Window);

    const disconnected = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Install First Tree on GitHub", disconnected.container);
    await click(
      [...disconnected.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Install First Tree on GitHub"),
      ) ?? null,
    );
    expect(githubAppMocks.getGithubAppInstallUrl).toHaveBeenCalledWith("org-1", "/onboarding/connected");
    expect(sessionStorage.getItem("onboarding:connect-code:install-attempt")).toBeTruthy();
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(installTab.location.href).toBe("https://github.com/apps/first-tree/installations/new");

    // Skip is one click now — a legitimate, recoverable choice goes straight
    // through with no confirm gate (the old "Skip connecting code?" panel +
    // Keep-connecting / Skip-anyway was confirmshaming and was removed).
    expect(disconnected.container.textContent).toContain("connect anytime from Settings.");
    await click(
      [...disconnected.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Skip for now"),
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
    await waitForText("Repos your agent can use", connected.container);
    await waitForText("acme/web", connected.container);
    // 0 repos picked but the list is pickable → no strong primary "Continue"
    // (only the quiet "Skip for now" link remains; never disabled). The old
    // no-repo consequence line was dropped, so there's nothing extra to assert.
    expect([...connected.container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Continue")).toBe(
      false,
    );
    await click(
      [...connected.container.querySelectorAll("label")].find((label) => label.textContent?.includes("acme/web")) ??
        null,
    );
    expect(setSelectedRepoUrls).toHaveBeenCalledWith(["https://github.com/acme/web.git"]);
    await click(
      [...connected.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Skip for now"),
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
    // A 403 from the org repo endpoint is `requireOrgAdmin` ("not an org
    // admin"), not a GitHub-scope problem (the repos come from the App
    // installation token, not the caller's OAuth). It folds into the same
    // honest load-failed message — there's no "reconnect GitHub" recovery.
    githubMocks.listOrgGithubRepos.mockRejectedValueOnce(new ApiError(403, "admin required"));
    const adminForbidden = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Couldn't load your team's repos", adminForbidden.container);
    await unmountRoot(adminForbidden.root);

    // A 502 (upstream) / 503 (no_installation|suspended) failure shows the same
    // honest load-failed message, not the empty "no projects" state.
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
    githubMocks.listOrgGithubRepos.mockRejectedValueOnce(new ApiError(503, "no installation"));
    const loadFailed = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Couldn't load your team's repos", loadFailed.container);
    await unmountRoot(loadFailed.root);

    githubAppMocks.getGithubAppInstallUrl.mockRejectedValueOnce(new ApiError(503, "not configured"));
    const notConfigured = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Install First Tree on GitHub", notConfigured.container);
    await click(
      [...notConfigured.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Install First Tree on GitHub"),
      ) ?? null,
    );
    await waitForText("Couldn't connect a repo here right now", notConfigured.container);
    await click(
      [...notConfigured.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Skip for now"),
      ) ?? null,
    );
    expect(notConfigured.flow.goNext).toHaveBeenCalled();
  });

  it("defaults to no selection with no draft, and preserves then prunes a resumed draft", async () => {
    const { StepConnectCode } = await import("../onboarding/steps/step-connect-code.js");
    const connectedInstall = {
      installationId: 42,
      accountLogin: "acme",
      accountType: "Organization" as const,
      accountGithubId: 123,
      repositorySelection: "selected" as const,
      permissions: {},
      events: [],
      suspended: false,
      manageUrl: "https://github.com/organizations/acme/settings/installations/42",
      createdAt: NOW,
      updatedAt: NOW,
    };
    githubAppMocks.getGithubAppInstallation.mockResolvedValue(connectedInstall);

    // No saved draft (first visit) → default to NONE selected; the user actively
    // picks which repos to share (paired with the "Skip for now" out + the
    // no-repo consequence hint). The picker never auto-selects on their behalf.
    const freshSet = vi.fn();
    const noDraft = await renderOnboardingDom(<StepConnectCode />, {
      activeStep: "connect-code",
      selectedRepoUrls: [],
      hasRepoDraft: false,
      setSelectedRepoUrls: freshSet,
    });
    await waitForText("acme/web", noDraft.container);
    await flush();
    expect(freshSet).not.toHaveBeenCalled();
    await unmountRoot(noDraft.root);

    // Resumed draft (user narrowed to just one repo earlier, then bailed before
    // start-chat) → no auto-select; the saved selection is left untouched instead
    // of being clobbered back to "all granted".
    const resumedSet = vi.fn();
    const withDraft = await renderOnboardingDom(<StepConnectCode />, {
      activeStep: "connect-code",
      selectedRepoUrls: ["https://github.com/acme/web.git"],
      hasRepoDraft: true,
      setSelectedRepoUrls: resumedSet,
    });
    await waitForText("acme/web", withDraft.container);
    await flush();
    expect(resumedSet).not.toHaveBeenCalled();
    await unmountRoot(withDraft.root);

    // Resumed draft carrying a repo the GitHub App no longer grants (uninstall /
    // changed grant between bailout and resume) → prune it against the current
    // grant list so a stale URL can't ride into start-chat. acme/web is still
    // granted; the gone repo is dropped.
    const prunedSet = vi.fn();
    const staleDraft = await renderOnboardingDom(<StepConnectCode />, {
      activeStep: "connect-code",
      selectedRepoUrls: ["https://github.com/acme/web.git", "https://github.com/acme/gone.git"],
      hasRepoDraft: true,
      setSelectedRepoUrls: prunedSet,
    });
    await waitForText("acme/web", staleDraft.container);
    await waitForCondition(
      () =>
        prunedSet.mock.calls.some(
          ([arg]) => Array.isArray(arg) && arg.length === 1 && arg[0] === "https://github.com/acme/web.git",
        ),
      "prune a no-longer-granted repo from a resumed draft",
    );
    await unmountRoot(staleDraft.root);
  });

  it("falls back to a full-page redirect when the install popup is blocked", async () => {
    const { StepConnectCode } = await import("../onboarding/steps/step-connect-code.js");
    // A fresh attempt: clear any marker a prior test left so the CTA is enabled.
    sessionStorage.removeItem("onboarding:connect-code:install-attempt");
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, href: "http://localhost/onboarding" },
    });
    // Popup blocked → window.open returns null → we must fall back to a
    // full-page redirect rather than silently dropping the install.
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    githubAppMocks.getGithubAppInstallUrl.mockClear();

    const blocked = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Install First Tree on GitHub", blocked.container);
    await click(
      [...blocked.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Install First Tree on GitHub"),
      ) ?? null,
    );
    // Blocked path redirects THIS tab, so it must come back to the wizard
    // (/onboarding) — not the popup auto-close page, which would strand it.
    expect(githubAppMocks.getGithubAppInstallUrl).toHaveBeenCalledWith("org-1", "/onboarding");
    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(assign).toHaveBeenCalledWith("https://github.com/apps/first-tree/installations/new");
    await unmountRoot(blocked.root);
  });

  it("locks the Install CTA after launch and re-enables only via Start over", async () => {
    const { StepConnectCode } = await import("../onboarding/steps/step-connect-code.js");
    sessionStorage.removeItem("onboarding:connect-code:install-attempt");
    const installTab = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(installTab as unknown as Window);
    githubAppMocks.getGithubAppInstallUrl.mockClear();

    const view = await renderOnboardingDom(<StepConnectCode />, { activeStep: "connect-code" });
    await waitForText("Install First Tree on GitHub", view.container);
    const installBtn = (): HTMLButtonElement | null =>
      [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("Install First Tree on GitHub"),
      ) ?? null;

    await click(installBtn());
    expect(githubAppMocks.getGithubAppInstallUrl).toHaveBeenCalledTimes(1);
    // The original tab stays mounted and polls; the CTA must lock so a second
    // click can't re-mint and clobber the in-flight attempt's state nonce.
    expect(installBtn()?.disabled).toBe(true);
    await click(installBtn());
    expect(githubAppMocks.getGithubAppInstallUrl).toHaveBeenCalledTimes(1);

    // Retry is explicit + user-initiated, never a timed auto-unlock.
    await click(
      [...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Start over")) ?? null,
    );
    expect(installBtn()?.disabled).toBe(false);
    await unmountRoot(view.root);
  });

  it("skips the create-agent step when the member already has a personal agent", async () => {
    authMock.value = { ...authMock.value, currentOrgHasPersonalAgent: true };
    const { StepCreateAgent } = await import("../onboarding/steps/step-create-agent.js");
    const { flow, root } = await renderOnboardingDom(<StepCreateAgent />, {
      activeStep: "create-agent",
      agentPhase: "idle",
    });
    await flush();
    // A fresh re-entry (refresh / new tab) after the agent already came online
    // but before start-chat lands back here; advancing past the form keeps the
    // member from creating a duplicate agent.
    expect(flow.goNext).toHaveBeenCalledTimes(1);
    expect(flow.createAgent).not.toHaveBeenCalled();
    await unmountRoot(root);
  });

  it("shows the create-agent form when the member has no personal agent yet", async () => {
    authMock.value = { ...authMock.value, currentOrgHasPersonalAgent: false };
    const { StepCreateAgent } = await import("../onboarding/steps/step-create-agent.js");
    const { flow, root } = await renderOnboardingDom(<StepCreateAgent />, {
      activeStep: "create-agent",
      agentPhase: "idle",
    });
    await flush();
    expect(flow.goNext).not.toHaveBeenCalled();
    await unmountRoot(root);
  });

  it("drives create-agent name, runtime, visibility, and submit actions", async () => {
    authMock.value = { ...authMock.value, currentOrgHasPersonalAgent: false };
    const { StepCreateAgent } = await import("../onboarding/steps/step-create-agent.js");
    const setAgentDisplayName = vi.fn();
    const setVisibility = vi.fn();
    const setSelectedRuntime = vi.fn();
    const createAgent = vi.fn(async () => undefined);
    const { flow, container, root } = await renderOnboardingDom(<StepCreateAgent />, {
      activeStep: "create-agent",
      agentDisplayName: "  Release Helper  ",
      setAgentDisplayName,
      visibility: "organization",
      setVisibility,
      createAgent,
      computer: {
        connectedClient: CLIENTS[0] ?? null,
        capabilitiesLoaded: true,
        okRuntimes: ["claude-code", "codex"],
        selectedRuntime: "claude-code",
        setSelectedRuntime,
        cliCommand: "first-tree-dev login token",
        tokenError: null,
        retry: vi.fn(),
      },
    });
    await waitForText("Choose your local coding agent", container);

    const nameInput = container.querySelector<HTMLInputElement>("#onboarding-agent-name");
    expect(nameInput).not.toBeNull();
    if (!nameInput) return;
    await setValue(nameInput, "New helper name");
    expect(setAgentDisplayName).toHaveBeenCalledWith("New helper name");

    const runtimeInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="onboarding-coding-agent"]'),
    );
    await click(runtimeInputs[1] ?? null);
    expect(setSelectedRuntime).toHaveBeenCalledWith("codex");

    const visibilityInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="onboarding-visibility"]'),
    );
    await click(visibilityInputs[1] ?? null);
    expect(setVisibility).toHaveBeenCalledWith("private");

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Create agent")) ?? null,
    );
    expect(createAgent).toHaveBeenCalledWith({
      displayName: "Release Helper",
      clientId: CLIENTS[0]?.id,
      runtimeProvider: "claude-code",
      visibility: "organization",
      organizationId: flow.organizationId,
    });
    await unmountRoot(root);
  });

  it("handles create-agent timeout actions", async () => {
    const { StepCreateAgent } = await import("../onboarding/steps/step-create-agent.js");
    const retryAgent = vi.fn(async () => undefined);
    const finishLater = vi.fn(async () => undefined);
    const { container, root } = await renderOnboardingDom(<StepCreateAgent />, {
      activeStep: "create-agent",
      agentPhase: "timeout",
      retryAgent,
      finishLater,
    });
    await waitForText("taking longer than usual", container);

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Keep waiting")) ?? null,
    );
    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("I'll finish later")) ??
        null,
    );

    expect(retryAgent).toHaveBeenCalledTimes(1);
    expect(finishLater).toHaveBeenCalledTimes(1);
    await unmountRoot(root);
  });

  it("keeps the selected coding agent visible while disconnected and routes reconnect", async () => {
    authMock.value = { ...authMock.value, currentOrgHasPersonalAgent: false };
    const { StepCreateAgent } = await import("../onboarding/steps/step-create-agent.js");
    const goTo = vi.fn();
    const setSelectedRuntime = vi.fn();
    const { flow, container, root } = await renderOnboardingDom(<StepCreateAgent />, {
      activeStep: "create-agent",
      goTo,
      computer: {
        connectedClient: null,
        capabilitiesLoaded: true,
        okRuntimes: [],
        selectedRuntime: "codex",
        setSelectedRuntime,
        cliCommand: "first-tree-dev login token",
        tokenError: null,
        retry: vi.fn(),
      },
    });
    await waitForText("Not ready", container);
    await waitForText("Codex", container);
    const create = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Create agent"),
    );
    expect(create?.disabled).toBe(true);

    const codingAgentInput = container.querySelector<HTMLInputElement>('input[name="onboarding-coding-agent"]');
    expect(codingAgentInput?.disabled).toBe(true);
    await act(async () => {
      codingAgentInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(setSelectedRuntime).not.toHaveBeenCalled();

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("reconnect it")) ?? null,
    );
    expect(goTo).toHaveBeenCalledWith(flow.sequence.indexOf("connect-computer"));
    await unmountRoot(root);
  });

  it("drives StepStartChat admin and invitee start flows", async () => {
    const { StepStartChat } = await import("../onboarding/steps/step-start-chat.js");
    const findButton = (container: ParentNode, text: string): HTMLButtonElement | null =>
      ([...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ??
        null) as HTMLButtonElement | null;

    // Admin · silently detects a bound team tree → switches the tree setup plan
    // to "use bound tree" (no fork, no URL input). The heading is agent + outcome.
    const setTreeBindingPlan = vi.fn();
    const setTreeUrl = vi.fn();
    const markTreeAutoDetectDone = vi.fn();
    const adminAutoDetect = await renderOnboardingDom(<StepStartChat />, {
      activeStep: "start-chat",
      selectedRepoUrls: ["https://github.com/acme/web.git"],
      treeBindingPlan: "createBinding",
      treeUrl: "",
      treeAutoDetectDone: false,
      setTreeBindingPlan,
      setTreeUrl,
      markTreeAutoDetectDone,
    });
    await waitForText("Start working with your agent", adminAutoDetect.container);
    expect(markTreeAutoDetectDone).toHaveBeenCalled();
    expect(setTreeBindingPlan).toHaveBeenCalledWith("useBoundTree");
    expect(setTreeUrl).toHaveBeenCalledWith("https://github.com/acme/context-tree");
    await unmountRoot(adminAutoDetect.root);

    // Admin · bound tree → Start enters the value-first work chat. It does not
    // start tree setup automatically; that now requires a later explicit user
    // consent flow or Settings/Context entry.
    const adminExisting = await renderOnboardingDom(<StepStartChat />, {
      activeStep: "start-chat",
      selectedRepoUrls: ["https://github.com/acme/web.git"],
      treeBindingPlan: "useBoundTree",
      treeUrl: "https://github.com/acme/context-tree",
    });
    await waitForText("Start working with your agent", adminExisting.container);
    await click(findButton(adminExisting.container, "Start chat"));
    await waitForText("Starting your agent", adminExisting.container);
    expect(agentApiMocks.listManagedAgents).toHaveBeenCalled();
    expect(onboardingEventMocks.startOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        agentUuid: "agent-1",
        bootstrap: expect.stringContaining("Nova, welcome aboard."),
        topic: "Get started with First Tree",
        complete: true,
      }),
    );
    expect(onboardingEventMocks.startOnboardingChat.mock.calls.every(([body]) => !("kind" in body))).toBe(true);
    expect(resourceMocks.createTeamResourceForOrg).toHaveBeenCalledWith("org-1", {
      type: "repo",
      name: "acme/web",
      defaultEnabled: "recommended",
      payload: { url: "https://github.com/acme/web.git" },
    });
    expect(adminExisting.flow.completeAndEnterChat).toHaveBeenCalledWith("chat-onboarding");
    await unmountRoot(adminExisting.root);

    // Admin · no repo → honestly just "meet your agent" (intro), no provisioning.
    const adminNoProject = await renderOnboardingDom(<StepStartChat />, {
      activeStep: "start-chat",
      selectedRepoUrls: [],
      treeBindingPlan: "createBinding",
      treeUrl: "",
    });
    await waitForText("Start working with your agent", adminNoProject.container);
    await click(findButton(adminNoProject.container, "Start chat"));
    expect(onboardingEventMocks.startOnboardingChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentUuid: "agent-1", topic: "Get started with First Tree" }),
    );
    expect(onboardingEventMocks.startOnboardingChat.mock.calls.at(-1)?.[0]).not.toHaveProperty("kind");
    expect(adminNoProject.flow.completeAndEnterChat).toHaveBeenCalledWith("chat-onboarding");
    await unmountRoot(adminNoProject.root);

    // Invitee · not-ready via no team tree → the first chat lands in a real
    // chat (runStartChat → completeAndEnterChat), not finishLater.
    orgSettingsMocks.getContextTreeSetting.mockResolvedValueOnce({ repo: "", branch: null });
    const inviteeNoTree = await renderOnboardingDom(<StepStartChat />, { path: "invitee", activeStep: "start-chat" });
    await waitForText("Start working with your agent", inviteeNoTree.container);
    await click(findButton(inviteeNoTree.container, "Start chat"));
    await waitForText("Starting your agent", inviteeNoTree.container);
    expect(inviteeNoTree.flow.completeAndEnterChat).toHaveBeenCalled();
    await unmountRoot(inviteeNoTree.root);

    // Invitee · not-ready via no installation (tree set, GitHub not connected) →
    // the same single not-ready screen + "meet your agent" bailout.
    githubAppMocks.getGithubAppInstallationExists.mockResolvedValueOnce(false);
    const inviteeNoInstall = await renderOnboardingDom(<StepStartChat />, {
      path: "invitee",
      activeStep: "start-chat",
    });
    await waitForText("Start working with your agent", inviteeNoInstall.container);
    await click(findButton(inviteeNoInstall.container, "Start chat"));
    expect(inviteeNoInstall.flow.completeAndEnterChat).toHaveBeenCalled();
    await unmountRoot(inviteeNoInstall.root);

    // Invitee · tree present but the install probe FAILS (unknown) → hold in
    // not-ready, never render the ready action state. An optimistic hasInstallation
    // (null → true) must not launch tree-reading without an authoritative
    // install=true, or the agent would 403 on its first git op.
    githubAppMocks.getGithubAppInstallationExists.mockRejectedValueOnce(new Error("probe failed"));
    const inviteeProbeFail = await renderOnboardingDom(<StepStartChat />, {
      path: "invitee",
      activeStep: "start-chat",
    });
    await waitForText("Start working with your agent", inviteeProbeFail.container);
    expect(findButton(inviteeProbeFail.container, "Start working with your agent")).toBeNull();
    await unmountRoot(inviteeProbeFail.root);

    // Invitee · ready (tree + install) → a single launch, no repo selection. The
    // agent already inherits the team's recommended repos.
    const inviteeReady = await renderOnboardingDom(<StepStartChat />, { path: "invitee", activeStep: "start-chat" });
    await waitForText("Start working with your agent", inviteeReady.container);
    await click(findButton(inviteeReady.container, "Start chat"));
    // Ready invitee also lands in a value-first work chat, not the tree setup
    // chat. The inherited team tree is context for orientation.
    expect(onboardingEventMocks.startOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUuid: "agent-1",
        bootstrap: expect.stringContaining("Please help me get settled into this team on First Tree."),
        topic: "Get settled on First Tree",
      }),
    );
    expect(onboardingEventMocks.reportOnboardingEvent).toHaveBeenCalledWith(
      "kickoff_chat_started",
      expect.objectContaining({ joinPath: "invite" }),
    );
    expect(inviteeReady.flow.completeAndEnterChat).toHaveBeenCalled();
    await unmountRoot(inviteeReady.root);
  });

  it("does not start background tree setup from onboarding start-chat", async () => {
    const { StepStartChat } = await import("../onboarding/steps/step-start-chat.js");
    orgSettingsMocks.getContextTreeSetting.mockResolvedValue({ repo: "", branch: null });

    const view = await renderOnboardingDom(<StepStartChat />, {
      activeStep: "start-chat",
      selectedRepoUrls: ["https://github.com/acme/web.git"],
      treeBindingPlan: "createBinding",
      treeUrl: "",
    });
    await waitForText("Start working with your agent", view.container);
    await click(
      ([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Start")) ??
        null) as HTMLButtonElement | null,
    );
    await waitForText("Starting your agent", view.container);

    expect(onboardingEventMocks.startOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUuid: "agent-1",
        topic: "Get started with First Tree",
        complete: true,
      }),
    );
    expect(contextTreeMocks.initializeContextTree).not.toHaveBeenCalled();
    expect(onboardingEventMocks.treeSetupStartChat).not.toHaveBeenCalled();
    expect(onboardingEventMocks.startOnboardingChat.mock.calls.every(([body]) => !("kind" in body))).toBe(true);
    expect(view.flow.completeAndEnterChat).toHaveBeenCalledWith("chat-onboarding");
    await unmountRoot(view.root);
  });

  it("opens the chat-first tree setup from Context without provisioning or repo registration", async () => {
    const { ContextTreeBuildEntry } = await import("../context-tree-build-entry.js");

    const view = await renderDom(<ContextTreeBuildEntry />);
    await waitForText("Build your Context Tree", view.container);
    await click(
      ([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Build your Context Tree")) ??
        null) as HTMLButtonElement | null,
    );
    await waitForCondition(
      () => onboardingEventMocks.treeSetupStartChat.mock.calls.length === 1,
      "Expected the Context entry to open the tree setup chat",
    );

    expect(contextTreeMocks.initializeContextTree).not.toHaveBeenCalled();
    expect(resourceMocks.listTeamResourcesForOrg).not.toHaveBeenCalled();
    expect(resourceMocks.createTeamResourceForOrg).not.toHaveBeenCalled();
    expect(githubAppMocks.getGithubAppInstallation).not.toHaveBeenCalled();
    expect(githubMocks.listOrgGithubRepos).not.toHaveBeenCalled();
    expect(onboardingEventMocks.startOnboardingChat).not.toHaveBeenCalled();
    expect(onboardingEventMocks.treeSetupStartChat).toHaveBeenCalledTimes(1);
    expect(onboardingEventMocks.treeSetupStartChat).toHaveBeenCalledWith({
      organizationId: "org-1",
      agentUuid: "agent-1",
    });
    await unmountRoot(view.root);
  });

  it("prunes a no-longer-granted repo at start-chat before writing team resources", async () => {
    // A flow can resume directly at start-chat (persisted step index) without ever
    // mounting StepConnectCode, so connect-code's grant prune never runs. The
    // start-chat handler must re-validate the (possibly stale) selection against the
    // current grant list, so a repo removed from the installation since the user
    // picked it is never registered as a team repo resource.
    const { StepStartChat } = await import("../onboarding/steps/step-start-chat.js");
    // Current grants are web + api (GITHUB_REPOS); the draft also carries a repo
    // the app no longer grants.
    githubMocks.listOrgGithubRepos.mockResolvedValue(GITHUB_REPOS);
    const view = await renderOnboardingDom(<StepStartChat />, {
      activeStep: "start-chat",
      selectedRepoUrls: ["https://github.com/acme/web.git", "https://github.com/acme/gone.git"],
      treeBindingPlan: "useBoundTree",
      treeUrl: "https://github.com/acme/context-tree",
    });
    await waitForText("Start working with your agent", view.container);
    await click(
      ([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Start")) ??
        null) as HTMLButtonElement | null,
    );
    await waitForText("Starting your agent", view.container);
    // web is still granted → written; the stale repo is pruned → never written.
    expect(resourceMocks.createTeamResourceForOrg).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ payload: { url: "https://github.com/acme/web.git" } }),
    );
    expect(resourceMocks.createTeamResourceForOrg).not.toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ payload: { url: "https://github.com/acme/gone.git" } }),
    );
    await unmountRoot(view.root);
  });

  it("fails closed at start-chat when the grant list can't be read (no stale write)", async () => {
    // If the current-grant read fails we can't prove the selected repos are still
    // accessible and nothing downstream re-checks grants, so start-chat must NOT
    // write the (possibly stale) selection — it surfaces a retryable error and
    // stays on the form instead.
    const { StepStartChat } = await import("../onboarding/steps/step-start-chat.js");
    githubMocks.listOrgGithubRepos.mockRejectedValue(new Error("github unavailable"));
    const view = await renderOnboardingDom(<StepStartChat />, {
      activeStep: "start-chat",
      selectedRepoUrls: ["https://github.com/acme/web.git"],
      treeBindingPlan: "useBoundTree",
      treeUrl: "https://github.com/acme/context-tree",
    });
    await waitForText("Start working with your agent", view.container);
    await click(
      ([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Start")) ??
        null) as HTMLButtonElement | null,
    );
    await waitForText("Couldn't check your repositories", view.container);
    expect(resourceMocks.createTeamResourceForOrg).not.toHaveBeenCalled();
    expect(chatApiMocks.createAgentChat).not.toHaveBeenCalled();
    expect(view.flow.completeAndEnterChat).not.toHaveBeenCalled();
    await unmountRoot(view.root);
  });

  it("start-chat grant check is authoritative — ignores a stale cached grant list", async () => {
    // The QueryClient is an app-level singleton and finishLater is SPA nav, so a
    // grant list connect-code cached earlier can still be in the cache when the
    // user resumes at start-chat — possibly minutes stale. The write-path check
    // must read CURRENT grants, not trust the cache (guards against re-adding a
    // staleTime). Seed the cache with a stale list that still contains a repo
    // that has since been removed; assert the live read prunes it anyway.
    const { StepStartChat } = await import("../onboarding/steps/step-start-chat.js");
    // Current grants (live) are web + api; the stale cache still has `gone`.
    githubMocks.listOrgGithubRepos.mockResolvedValue(GITHUB_REPOS);
    const view = await renderOnboardingDom(
      <StepStartChat />,
      {
        activeStep: "start-chat",
        selectedRepoUrls: ["https://github.com/acme/web.git", "https://github.com/acme/gone.git"],
        treeBindingPlan: "useBoundTree",
        treeUrl: "https://github.com/acme/context-tree",
      },
      (queryClient) => {
        queryClient.setQueryData(
          ["onboarding", "org-github-repos", "org-1"],
          [
            {
              fullName: "acme/web",
              cloneUrl: "https://github.com/acme/web.git",
              htmlUrl: "",
              private: false,
              defaultBranch: "main",
              pushedAt: NOW,
            },
            {
              fullName: "acme/gone",
              cloneUrl: "https://github.com/acme/gone.git",
              htmlUrl: "",
              private: false,
              defaultBranch: "main",
              pushedAt: NOW,
            },
          ],
        );
      },
    );
    await waitForText("Start working with your agent", view.container);
    await click(
      ([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Start")) ??
        null) as HTMLButtonElement | null,
    );
    await waitForText("Starting your agent", view.container);
    // Live read returned web + api → `gone` is pruned despite being in the cache.
    expect(githubMocks.listOrgGithubRepos).toHaveBeenCalled();
    expect(resourceMocks.createTeamResourceForOrg).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ payload: { url: "https://github.com/acme/web.git" } }),
    );
    expect(resourceMocks.createTeamResourceForOrg).not.toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ payload: { url: "https://github.com/acme/gone.git" } }),
    );
    await unmountRoot(view.root);
  });

  it("edits, reveals, adds, and deletes environment variables (immediate save)", async () => {
    const { ENV_REDACTED_PLACEHOLDER } = await import("@first-tree/shared");
    const { EnvSection } = await import("../agent-detail/env-section.js");
    // onSave invokes the success callback so the delete Undo toast fires, mirroring
    // the real controller resolving the PATCH.
    const onSave = vi.fn((_next: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    const items = [
      { key: "FIRST_TREE_ENV", value: "test", sensitive: false },
      { key: "OPENAI_API_KEY", value: ENV_REDACTED_PLACEHOLDER, sensitive: true },
      // Plaintext sensitive value (optimistic window) → revealable.
      { key: "TOKEN", value: "secret-value", sensitive: true },
    ];

    const { container, root } = await renderDom(<EnvSection items={items} onSave={onSave} />);

    // Reveal / hide only works for the plaintext secret, not the redacted one.
    await click(
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Reveal value"]')].find(
        (button) => !button.disabled,
      ) ?? null,
    );
    expect(container.textContent).toContain("secret-value");
    await click(container.querySelector('button[aria-label="Hide value"]'));
    expect(container.textContent).not.toContain("secret-value");

    // Delete the non-sensitive row → saves the reduced array immediately + Undo toast.
    await click(container.querySelector('button[title="Delete"]'));
    expect(onSave.mock.calls[0]?.[0]).toEqual([items[1], items[2]]);
    await waitForText("Removed FIRST_TREE_ENV", document.body);
    // Undo re-adds it (non-sensitive value is recoverable).
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Undo") ?? null);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toContainEqual({ key: "FIRST_TREE_ENV", value: "test", sensitive: false });

    // Add: key validation, duplicate guard, sensitive-requires-value, then save.
    await click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add")) ?? null);
    await waitForText("Add environment variable", document.body);
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);
    await waitForText("Key must match", document.body);
    const key = document.body.querySelector<HTMLInputElement>("#env-key");
    const value = document.body.querySelector<HTMLInputElement>("#env-value");
    const sensitive = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!key || !value || !sensitive) throw new Error("Env fields missing");
    await setValue(key, "first_tree_env");
    expect(key.value).toBe("FIRST_TREE_ENV");
    await setValue(value, "duplicate");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);
    await waitForText('Another entry already uses key "FIRST_TREE_ENV".', document.body);
    await setValue(key, "NEW_SECRET");
    await setValue(value, "");
    await click(sensitive);
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);
    await waitForText("Value is required for sensitive entries.", document.body);
    await setValue(value, "super-secret");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);
    expect(onSave.mock.calls.at(-1)?.[0]).toContainEqual({ key: "NEW_SECRET", value: "super-secret", sensitive: true });

    // Edit the redacted secret leaving the value empty → keeps the existing ciphertext.
    await click([...container.querySelectorAll('button[title="Edit"]')][1] ?? null);
    await waitForText("Edit environment variable", document.body);
    const editValue = document.body.querySelector<HTMLInputElement>("#env-value");
    if (!editValue) throw new Error("Env edit value missing");
    expect(editValue.placeholder).toBe("Leave empty to keep existing value");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Done") ?? null);
    expect(onSave.mock.calls.at(-1)?.[0]).toContainEqual({
      key: "OPENAI_API_KEY",
      value: ENV_REDACTED_PLACEHOLDER,
      sensitive: true,
    });

    // Deleting a persisted secret can't be undone (its ciphertext is gone) — the
    // toast says so honestly and offers no Undo (a no-op after a tab switch).
    await click([...container.querySelectorAll('button[title="Delete"]')][1] ?? null);
    await waitForText("Removed OPENAI_API_KEY", document.body);
    expect(document.body.textContent).toContain("can't be recovered");

    await unmountRoot(root);
  });

  it("keeps the env dialog open and preserves input when the save fails", async () => {
    const { EnvSection } = await import("../agent-detail/env-section.js");
    // onSave never invokes onSuccess (simulates a rejected/409 save); the page
    // surfaces the failure via the saveError prop.
    const onSave = vi.fn();
    const { container, root } = await renderDom(<EnvSection items={[]} onSave={onSave} saveError="Save failed" />);

    await click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add")) ?? null);
    await waitForText("Add environment variable", document.body);
    const key = document.body.querySelector<HTMLInputElement>("#env-key");
    const value = document.body.querySelector<HTMLInputElement>("#env-value");
    if (!key || !value) throw new Error("Env fields missing");
    await setValue(key, "API_KEY");
    await setValue(value, "v1");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);

    // The save was attempted, but because it never confirmed the dialog stays
    // open with the typed value intact (no silent data loss) and shows the error.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Add environment variable");
    expect(document.body.querySelector<HTMLInputElement>("#env-key")?.value).toBe("API_KEY");
    expect(document.body.querySelector<HTMLInputElement>("#env-value")?.value).toBe("v1");
    expect(document.body.textContent).toContain("Save failed");

    await unmountRoot(root);
  });

  it("blocks every dismiss path while an env save is pending, then preserves input on failure", async () => {
    const { EnvSection } = await import("../agent-detail/env-section.js");
    let setSaving: (v: boolean) => void = () => {};
    const onSave = vi.fn(); // never confirms — simulates an in-flight then failed save
    function Harness() {
      const [saving, setSavingState] = useState(false);
      setSaving = setSavingState;
      return <EnvSection items={[]} onSave={onSave} saving={saving} saveError={saving ? null : "Save failed"} />;
    }
    const { container, root } = await renderDom(<Harness />);

    await click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add")) ?? null);
    await waitForText("Add environment variable", document.body);
    const key = document.body.querySelector<HTMLInputElement>("#env-key");
    const value = document.body.querySelector<HTMLInputElement>("#env-value");
    if (!key || !value) throw new Error("Env fields missing");
    await setValue(key, "API_KEY");
    await setValue(value, "s3cr3t");
    const sensitive = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (sensitive) await click(sensitive);
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);
    expect(onSave).toHaveBeenCalledTimes(1);

    // The save is now in flight.
    await act(async () => setSaving(true));

    // Inputs are locked mid-save so a value typed in the pending window can't be
    // silently dropped when the save resolves.
    expect(document.body.querySelector<HTMLInputElement>("#env-value")?.disabled).toBe(true);

    // The Radix close (X), Escape, and outside click all route through the
    // dialog's onOpenChange — none of them may dismiss it mid-save.
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Close") ?? null);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.textContent).toContain("Add environment variable");
    expect(document.body.querySelector<HTMLInputElement>("#env-key")?.value).toBe("API_KEY");

    // Save resolves as a failure → dialog still open, secret intact, error shown.
    await act(async () => setSaving(false));
    expect(document.body.textContent).toContain("Add environment variable");
    expect(document.body.querySelector<HTMLInputElement>("#env-key")?.value).toBe("API_KEY");
    expect(document.body.querySelector<HTMLInputElement>("#env-value")?.value).toBe("s3cr3t");
    expect(document.body.textContent).toContain("Save failed");

    await unmountRoot(root);
  });

  it("shows a toast when an env row delete fails (no dialog to host the error)", async () => {
    const { EnvSection } = await import("../agent-detail/env-section.js");
    // onSave invokes onError, simulating a rejected/409 delete.
    const onSave = vi.fn((_next: unknown, opts?: { onError?: () => void }) => opts?.onError?.());
    const items = [{ key: "FIRST_TREE_ENV", value: "test", sensitive: false }];
    const { container, root } = await renderDom(<EnvSection items={items} onSave={onSave} />);

    await click(container.querySelector('button[title="Delete"]'));
    expect(onSave).toHaveBeenCalledTimes(1);
    await waitForText("Couldn't remove FIRST_TREE_ENV", document.body);

    await unmountRoot(root);
  });

  it("locks the secret input mid-save so a successful old request can't drop a late edit", async () => {
    const { EnvSection } = await import("../agent-detail/env-section.js");
    let setSaving: (v: boolean) => void = () => {};
    let resolveSuccess: () => void = () => {};
    const onSave = vi.fn((_next: unknown, opts?: { onSuccess?: () => void }) => {
      resolveSuccess = () => opts?.onSuccess?.();
    });
    function Harness() {
      const [saving, s] = useState(false);
      setSaving = s;
      return <EnvSection items={[]} onSave={onSave} saving={saving} />;
    }
    const { container, root } = await renderDom(<Harness />);

    await click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add")) ?? null);
    await waitForText("Add environment variable", document.body);
    const key = document.body.querySelector<HTMLInputElement>("#env-key");
    const value = document.body.querySelector<HTMLInputElement>("#env-value");
    const sensitive = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!key || !value || !sensitive) throw new Error("Env fields missing");
    await setValue(key, "API_KEY");
    await setValue(value, "secret1");
    await click(sensitive);
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);
    expect(onSave.mock.calls[0]?.[0]).toEqual([{ key: "API_KEY", value: "secret1", sensitive: true }]);

    // Save is in flight: the inputs are disabled, so the user CANNOT type a late
    // "correction" into the still-open dialog — there is no unsubmitted edit that
    // the succeeding old request could silently drop.
    await act(async () => setSaving(true));
    expect(document.body.querySelector<HTMLInputElement>("#env-value")?.disabled).toBe(true);
    expect(document.body.querySelector<HTMLInputElement>("#env-key")?.disabled).toBe(true);

    // The original request succeeds and closes the dialog. Only the submitted
    // secret1 was ever sent — exactly one save, no silent second value.
    await act(async () => {
      resolveSuccess();
      setSaving(false);
    });
    expect(document.body.textContent).not.toContain("Add environment variable");
    expect(onSave).toHaveBeenCalledTimes(1);

    await unmountRoot(root);
  });

  it("clears a stale validation error so a later save failure is shown, not masked", async () => {
    const { EnvSection } = await import("../agent-detail/env-section.js");
    function Harness() {
      const [saveError, setSaveError] = useState<string | null>(null);
      // The save fails (no onSuccess) and surfaces an error to the dialog.
      const onSave = (_next: EnvEntryLike[]) => setSaveError("Save failed");
      return (
        <EnvSection items={[{ key: "EXISTING", value: "x", sensitive: false }]} onSave={onSave} saveError={saveError} />
      );
    }
    const { container, root } = await renderDom(<Harness />);

    await click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Add")) ?? null);
    await waitForText("Add environment variable", document.body);
    const key = document.body.querySelector<HTMLInputElement>("#env-key");
    const value = document.body.querySelector<HTMLInputElement>("#env-value");
    if (!key || !value) throw new Error("Env fields missing");

    // Trigger a local validation error (duplicate key), then fix it and resubmit.
    await setValue(key, "EXISTING");
    await setValue(value, "v");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);
    await waitForText('Another entry already uses key "EXISTING".', document.body);
    await setValue(key, "NEWKEY");
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Add") ?? null);

    // The real save failure shows; the stale validation message no longer masks it.
    await waitForText("Save failed", document.body);
    expect(document.body.textContent).not.toContain("Another entry already uses key");

    await unmountRoot(root);
  });
});

// Minimal structural shape for the env onSave callback in the test above.
type EnvEntryLike = { key: string; value: string; sensitive: boolean };
