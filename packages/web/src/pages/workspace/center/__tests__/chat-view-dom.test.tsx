// @vitest-environment happy-dom

import {
  type Agent,
  type ChatDetail,
  type ChatParticipantDetail,
  encodeProviderRetryEventMessage,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../../api/activity.js";
import type { MessageWithDelivery, PaginatedMessages } from "../../../../api/chats.js";
import type { ChatSessionEventsResponse, SessionEventRow } from "../../../../api/sessions.js";
import { agentSessionsQueryKey } from "../../../../api/sessions.js";
import { ToastProvider } from "../../../../components/ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  listClients: vi.fn(),
  getClient: vi.fn(),
  startRuntimeAuth: vi.fn(),
}));

const markdownMocks = vi.hoisted(() => ({
  render: vi.fn(),
}));

const agentStatusMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  getAgentSkills: vi.fn(),
  listAgents: vi.fn(),
}));

const attachmentMocks = vi.hoisted(() => ({
  downloadAttachment: vi.fn(),
  fetchAttachmentBase64: vi.fn(),
  uploadAttachment: vi.fn(),
  uploadImageAttachment: vi.fn(),
  uploadMimeFor: vi.fn((file: File) => file.type || "application/octet-stream"),
}));

const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  listChatMessages: vi.fn(),
  listChatOpenRequests: vi.fn(),
  patchChatEngagement: vi.fn(),
  readFileAsBase64: vi.fn(),
  renameChat: vi.fn(),
  sendChatMessage: vi.fn(),
  sendFileMessageBatch: vi.fn(),
}));

const imageStoreMocks = vi.hoisted(() => ({
  getImage: vi.fn(),
  putImage: vi.fn(),
}));

const meChatMocks = vi.hoisted(() => ({
  addMeChatParticipants: vi.fn(),
}));

const readStateMocks = vi.hoisted(() => ({
  getReadState: vi.fn(),
  setReadState: vi.fn(),
}));

const sessionMocks = vi.hoisted(() => ({
  listChatSessionEvents: vi.fn(),
  listSessionEvents: vi.fn(),
  listSessionOutputs: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    agentId: "human-agent-self",
    memberId: "member-self",
    role: "admin",
  },
}));

vi.mock("../../../../api/activity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/activity.js")>()),
  listClients: activityMocks.listClients,
  getClient: activityMocks.getClient,
  startRuntimeAuth: activityMocks.startRuntimeAuth,
}));

vi.mock("../../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId] as const,
  fetchChatAgentStatuses: agentStatusMocks.fetchChatAgentStatuses,
}));

vi.mock("../../../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/agents.js")>()),
  getAgentSkills: agentMocks.getAgentSkills,
  listAgents: agentMocks.listAgents,
}));

vi.mock("../../../../api/attachments.js", () => attachmentMocks);

vi.mock("../../../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/chats.js")>()),
  ...chatMocks,
}));

vi.mock("../../../../api/image-store.js", () => imageStoreMocks);

vi.mock("../../../../api/me-chats.js", () => meChatMocks);

vi.mock("../../../../api/read-state-store.js", () => readStateMocks);

vi.mock("../../../../api/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/sessions.js")>()),
  listChatSessionEvents: sessionMocks.listChatSessionEvents,
  listSessionEvents: sessionMocks.listSessionEvents,
  listSessionOutputs: sessionMocks.listSessionOutputs,
}));

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../../components/ui/markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../components/ui/markdown.js")>();
  return {
    ...actual,
    Markdown: (props: import("../../../../components/ui/markdown.js").MarkdownProps) => {
      markdownMocks.render(props.children);
      return actual.Markdown(props);
    },
  };
});

function resolveAgentIdentityForTest(id: string | null | undefined) {
  if (!id) return null;
  return {
    name: AGENT_SLUGS[id] ?? id,
    displayName: AGENT_NAMES[id] ?? id,
    avatarImageUrl: null,
    avatarColorToken: id === "agent-1" ? "hue-2" : null,
  };
}

function resolveAgentNameForTest(id: string | null | undefined): string {
  return id ? (AGENT_NAMES[id] ?? id) : "unknown";
}

function resolveAgentSlugForTest(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return Object.entries(AGENT_SLUGS).find(([, value]) => value === slug)?.[0] ?? null;
}

vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentIdentityMap: () => resolveAgentIdentityForTest,
  useAgentNameMap: () => resolveAgentNameForTest,
  useAgentSlugToIdMap: () => resolveAgentSlugForTest,
}));

vi.mock("../../../../lib/use-org-agents.js", () => ({
  useOrgAgents: () => ({ data: { items: ORG_AGENTS, nextCursor: null } }),
  useOrgAgentsSearch: () => ({ data: { items: ORG_AGENTS, nextCursor: null }, isFetching: false }),
}));

vi.mock("../../../../lib/visibility-interval.js", () => ({
  runVisibilityAwareInterval: (tick: () => void | Promise<void>) => {
    void tick();
    return () => undefined;
  },
}));

const NOW = "2026-05-28T12:00:00.000Z";

const AGENT_NAMES: Record<string, string> = {
  "agent-1": "Nova",
  "agent-2": "Design Critique",
  "human-agent-self": "Gandy",
  "human-agent-alice": "Alice",
};

const AGENT_SLUGS: Record<string, string> = {
  "agent-1": "nova",
  "agent-2": "design",
  "human-agent-self": "gandy",
  "human-agent-alice": "alice",
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

const ORG_AGENTS = [
  agent({ uuid: "human-agent-self", name: "gandy", displayName: "Gandy", type: "human", clientId: null }),
  agent(),
  agent({ uuid: "agent-2", name: "design", displayName: "Design Critique", managerId: "member-alice" }),
  // A teammate's agent pinned to a computer the caller does NOT own — its
  // `clientId` is absent from `listClients()` (the caller's `/me/clients`).
  agent({
    uuid: "agent-teammate",
    name: "teammate",
    displayName: "Teammate Agent",
    managerId: "member-alice",
    clientId: "client-teammate",
  }),
];

function participant(overrides: Partial<ChatParticipantDetail> & { agentId: string }): ChatParticipantDetail {
  return {
    agentId: overrides.agentId,
    role: overrides.role ?? "member",
    mode: overrides.mode ?? "full",
    joinedAt: overrides.joinedAt ?? NOW,
    name: overrides.name ?? AGENT_SLUGS[overrides.agentId] ?? overrides.agentId,
    displayName: overrides.displayName ?? AGENT_NAMES[overrides.agentId] ?? overrides.agentId,
    type: overrides.type ?? "agent",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
  };
}

const PARTICIPANTS: ChatParticipantDetail[] = [
  participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
  participant({ agentId: "human-agent-alice", type: "human", name: "alice", displayName: "Alice" }),
  participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
  participant({ agentId: "agent-2", name: "design", displayName: "Design Critique" }),
];

function chatDetail(overrides: Partial<ChatDetail> = {}): ChatDetail {
  return {
    id: overrides.id ?? "chat-1",
    organizationId: overrides.organizationId ?? "org-1",
    type: overrides.type ?? "group",
    topic: overrides.topic ?? "Launch planning",
    description: overrides.description ?? null,
    descriptionUpdatedAt: overrides.descriptionUpdatedAt ?? null,
    lastReadAt: overrides.lastReadAt ?? null,
    lifecyclePolicy: overrides.lifecyclePolicy ?? null,
    metadata: overrides.metadata ?? { source: "github", entityUrl: "https://github.com/acme/web/pull/42" },
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    participants: overrides.participants ?? PARTICIPANTS,
    title: overrides.title ?? "Launch planning",
    firstMessagePreview: overrides.firstMessagePreview ?? "Please review the launch checklist.",
    engagementStatus: overrides.engagementStatus ?? "active",
    viewerMembershipKind: overrides.viewerMembershipKind ?? "participant",
  };
}

function message(overrides: Partial<MessageWithDelivery> & { id: string; senderId: string }): MessageWithDelivery {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    format: overrides.format ?? "text",
    content: overrides.content ?? "Please review docs/plan.md and @nova.",
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt ?? NOW,
    deliveryStatus: overrides.deliveryStatus,
  };
}

function messages(items: MessageWithDelivery[]): PaginatedMessages {
  return { items, nextCursor: null };
}

const BASE_MESSAGES = messages([
  message({
    id: "msg-1",
    senderId: "human-agent-self",
    createdAt: "2026-05-28T11:55:00.000Z",
    metadata: {
      mentions: ["agent-1"],
      attachments: [
        {
          attachmentId: "00000000-0000-4000-8000-000000000001",
          kind: "document",
          mimeType: "text/markdown",
          filename: "plan.md",
          size: 21,
          sha256: "a".repeat(64),
          source: { path: "docs/plan.md" },
        },
      ],
      documentContext: {
        kind: "snapshot",
        failedMentions: [{ raw: "secrets.env", reason: "hidden-segment" }],
      },
    },
  }),
  message({
    id: "msg-2",
    senderId: "agent-1",
    content: "I found one rollout risk in docs/plan.md and secrets.env.",
    source: "api",
    createdAt: "2026-05-28T11:56:00.000Z",
    deliveryStatus: "acked",
    metadata: {
      attachments: [
        {
          attachmentId: "00000000-0000-4000-8000-000000000001",
          kind: "document",
          mimeType: "text/markdown",
          filename: "plan.md",
          size: 21,
          sha256: "a".repeat(64),
          source: { path: "docs/plan.md" },
        },
      ],
      documentContext: {
        kind: "snapshot",
        failedMentions: [{ raw: "secrets.env", reason: "hidden-segment" }],
      },
    },
  }),
  message({
    id: "msg-3",
    senderId: "agent-2",
    format: "file",
    content: {
      caption: "Preview image for @nova.",
      attachments: [{ imageId: "image-1", mimeType: "image/png", filename: "preview.png", size: 42 }],
    },
    source: "api",
    createdAt: "2026-05-28T11:57:00.000Z",
  }),
  message({
    id: "msg-4",
    senderId: "agent-1",
    format: "card",
    content: { unsupported: true },
    source: "api",
    createdAt: "2026-05-28T11:58:00.000Z",
  }),
]);

const SESSION_EVENTS: { items: SessionEventRow[]; nextCursor: number | null } = {
  items: [
    {
      id: "event-1",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 1,
      kind: "tool_call",
      payload: { toolUseId: "tool-1", name: "Bash", args: { cmd: "pnpm test" }, status: "pending" },
      createdAt: "2026-05-28T11:56:10.000Z",
    },
    {
      id: "event-2",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 2,
      kind: "assistant_text",
      payload: { text: "Checking the rollout path now." },
      createdAt: "2026-05-28T11:56:20.000Z",
    },
    {
      id: "event-3",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 3,
      kind: "error",
      payload: { source: "runtime", message: "Example recoverable runtime error" },
      createdAt: "2026-05-28T11:56:30.000Z",
    },
    {
      id: "event-4",
      agentId: "agent-1",
      chatId: "chat-1",
      seq: 4,
      kind: "token_usage",
      payload: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      createdAt: "2026-05-28T11:56:40.000Z",
    },
  ],
  nextCursor: null,
};

function chatSessionEvents(
  ...feeds: Array<{
    agentId: string;
    events: { items: SessionEventRow[]; nextCursor: number | null };
  }>
): ChatSessionEventsResponse {
  return {
    feeds: feeds.map(({ agentId, events }) => ({ agentId, ...events })),
  };
}

function installBrowserStubs(): void {
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
  });
  Object.defineProperty(window.URL, "createObjectURL", { configurable: true, value: () => "blob:test-image" });
  Object.defineProperty(window.URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("48rem") || query.includes("80rem"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  class TestResizeObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  }
  class TestIntersectionObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: TestIntersectionObserver });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 0),
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
    removeItem: (key: string) => data.delete(key),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function createClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(["agents", "org-list"], { items: ORG_AGENTS, nextCursor: null });
  queryClient.setQueryData(
    ["chat-agent-status", "chat-1"],
    [
      {
        agentId: "agent-1",
        main: "working",
        reachable: true,
        engagement: "active",
        working: true,
        needsYou: false,
        errored: false,
        activity: {
          agentId: "agent-1",
          kind: "assistant_text",
          label: "Thinking",
          detail: "Checking the rollout path.",
          startedAt: NOW,
          turnText: "Checking the rollout path.",
        },
      },
      {
        agentId: "agent-2",
        main: "ready",
        reachable: true,
        engagement: "active",
        working: false,
        needsYou: false,
        errored: false,
        activity: null,
      },
    ],
  );
  queryClient.setQueryData(["chat-right-sidebar", "github-entities", "chat-1"], {
    items: [
      {
        entityType: "pull_request",
        entityKey: "acme/web#42",
        htmlUrl: "https://github.com/acme/web/pull/42",
        title: "Release checklist",
        state: "open",
        boundVia: "direct",
      },
    ],
  });
  queryClient.setQueryData(agentSessionsQueryKey("agent-1"), []);
  return queryClient;
}

function seedChat(
  queryClient: QueryClient,
  detail: ChatDetail = chatDetail(),
  page: PaginatedMessages = BASE_MESSAGES,
) {
  queryClient.setQueryData(["chat-detail", detail.id], detail);
  queryClient.setQueryData(["chat-messages-cache", detail.id], page.items.slice(0, 1));
  queryClient.setQueryData(["chat-messages", detail.id], page);
  queryClient.setQueryData(
    ["chat-session-events", detail.id],
    chatSessionEvents({ agentId: "agent-1", events: SESSION_EVENTS }),
  );
  queryClient.setQueryData(["chat-read-state", detail.id], {
    chatId: detail.id,
    bottomVisibleMessageId: "msg-1",
    latestKnownMessageId: "msg-1",
    updatedAt: Date.now(),
  });
}

async function renderDom(
  element: ReactElement,
  seed?: (queryClient: QueryClient) => void,
  route = "/?docChat=chat-1&docMsg=msg-1&docAttachment=00000000-0000-4000-8000-000000000001",
): Promise<{ container: HTMLElement; queryClient: QueryClient; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createClient();
  seedChat(queryClient);
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
  return { container, queryClient, root };
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

async function changeFiles(element: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(element, "files", { configurable: true, value: files });
  await act(async () => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function buttonByTitle(container: ParentNode, title: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

/** The AskTakeover overlay's option button (role radio/checkbox) containing `text`. */
function askOption(container: ParentNode, text: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"],[role="checkbox"]')].find((b) =>
      b.textContent?.includes(text),
    ) ?? null
  );
}

/** The AskTakeover overlay's free-text answer textarea (Other, or the pure free-text box). */
function askTextarea(container: ParentNode): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>(
    'textarea[placeholder^="Type your answer"], textarea[placeholder^="Other"]',
  );
}

beforeEach(() => {
  installBrowserStubs();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { agentId: "human-agent-self", memberId: "member-self", role: "admin" };
  activityMocks.listClients.mockResolvedValue([
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
      capabilities: {},
    } satisfies HubClient,
  ]);
  activityMocks.getClient.mockResolvedValue({
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
    capabilities: {},
  } satisfies HubClient);
  activityMocks.startRuntimeAuth.mockResolvedValue({ ref: "auth-ref", started: true });
  agentStatusMocks.fetchChatAgentStatuses.mockResolvedValue([
    {
      agentId: "agent-1",
      main: "working",
      reachable: true,
      engagement: "active",
      working: true,
      needsYou: false,
      errored: false,
      activity: {
        agentId: "agent-1",
        kind: "assistant_text",
        label: "Thinking",
        detail: "Checking the rollout path.",
        startedAt: NOW,
        turnText: "Checking the rollout path.",
      },
    },
    {
      agentId: "agent-2",
      main: "ready",
      reachable: true,
      engagement: "active",
      working: false,
      needsYou: false,
      errored: false,
      activity: null,
    },
  ]);
  agentMocks.getAgentSkills.mockResolvedValue({ skills: [{ name: "review", description: "Review a patch." }] });
  agentMocks.listAgents.mockResolvedValue({ items: ORG_AGENTS, nextCursor: null });
  attachmentMocks.fetchAttachmentBase64.mockResolvedValue({ base64: "image-base64", mimeType: "image/png" });
  attachmentMocks.uploadAttachment.mockResolvedValue({ id: "uploaded-image", mimeType: "image/png", size: 42 });
  attachmentMocks.uploadImageAttachment.mockImplementation((file: File) => attachmentMocks.uploadAttachment(file));
  chatMocks.getChat.mockResolvedValue(chatDetail());
  chatMocks.listChatMessages.mockResolvedValue(BASE_MESSAGES);
  chatMocks.listChatOpenRequests.mockResolvedValue({ items: [] });
  chatMocks.patchChatEngagement.mockResolvedValue({ chatId: "chat-1", engagementStatus: "active" });
  chatMocks.readFileAsBase64.mockResolvedValue("image-base64");
  chatMocks.renameChat.mockResolvedValue({ id: "chat-1", topic: "Renamed launch" });
  chatMocks.sendChatMessage.mockImplementation((chatId: string, content: string) =>
    Promise.resolve(
      message({
        id: "msg-sent",
        chatId,
        senderId: "human-agent-self",
        content,
        createdAt: "2026-05-28T12:01:00.000Z",
      }),
    ),
  );
  chatMocks.sendFileMessageBatch.mockImplementation((chatId: string, content: unknown) =>
    Promise.resolve(
      message({
        id: "msg-file",
        chatId,
        senderId: "human-agent-self",
        format: "file",
        content,
        createdAt: "2026-05-28T12:02:00.000Z",
      }),
    ),
  );
  imageStoreMocks.getImage.mockResolvedValue(null);
  imageStoreMocks.putImage.mockResolvedValue(undefined);
  meChatMocks.addMeChatParticipants.mockResolvedValue({ ok: true });
  readStateMocks.getReadState.mockResolvedValue(null);
  readStateMocks.setReadState.mockResolvedValue(undefined);
  sessionMocks.listSessionEvents.mockImplementation((requestedAgentId: string) =>
    Promise.resolve(
      requestedAgentId === "agent-1"
        ? SESSION_EVENTS
        : {
            items: [],
            nextCursor: null,
          },
    ),
  );
  sessionMocks.listChatSessionEvents.mockResolvedValue(
    chatSessionEvents({ agentId: "agent-1", events: SESSION_EVENTS }),
  );
  sessionMocks.listSessionOutputs.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChatView", () => {
  it("renders typed GitHub/GitLab header links only for anchored provider chats", async () => {
    const { ChatView } = await import("../chat-view.js");
    const cases = [
      {
        id: "chat-github-link",
        metadata: {
          source: "github",
          entityType: "pull_request",
          entityKey: "acme/web#42",
          entityUrl: "https://github.com/acme/web/pull/42",
        },
        title: "View on GitHub",
        href: "https://github.com/acme/web/pull/42",
      },
      {
        id: "chat-gitlab-link",
        metadata: {
          source: "gitlab",
          entityType: "pull_request",
          entityKey: "501:pull_request:42",
          entityUrl: "https://gitlab.internal/acme/web/-/merge_requests/42",
        },
        title: "View on GitLab",
        href: "https://gitlab.internal/acme/web/-/merge_requests/42",
      },
      {
        id: "chat-gitlab-no-url",
        metadata: {
          source: "gitlab",
          entityType: "pull_request",
          entityKey: "501:pull_request:43",
        },
        title: null,
        href: null,
      },
      { id: "chat-manual-link", metadata: {}, title: null, href: null },
    ] as const;

    for (const entry of cases) {
      const detail = chatDetail({
        id: entry.id,
        title: `Header ${entry.id}`,
        topic: `Header ${entry.id}`,
        metadata: entry.metadata,
      });
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId={entry.id} initialChatDetail={detail} />,
        undefined,
        "/",
      );
      await waitForText(container, `Header ${entry.id}`);
      const link = entry.title ? container.querySelector<HTMLAnchorElement>(`a[title="${entry.title}"]`) : null;
      if (entry.href) {
        expect(link?.href).toBe(entry.href);
        expect(link?.target).toBe("_blank");
        expect(link?.rel).toBe("noopener noreferrer");
      } else {
        expect(container.querySelector('a[title^="View on "]')).toBeNull();
      }
      await act(async () => root.unmount());
    }
  });

  it("hides chat-management affordances on the trial surface even when read-only (route-scoped)", async () => {
    const { ChatView } = await import("../chat-view.js");
    // A persisted-open sidebar must NOT re-appear on the trial surface.
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    // `isTrial` + `readOnly` together = the watcher branch of a `/quickstart`
    // chat. The trial-chrome guarantee is route-scoped, so the participant /
    // details cluster, the chat-details sidebar toggle, and rename must all be
    // gone here — `readOnly` alone would not hide them all (nor the hovercard).
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" isTrial readOnly />,
      undefined,
      "/",
    );

    await waitForText(container, "Launch planning");

    expect(container.querySelector('button[aria-label="Add participant"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Show chat details"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Hide chat details"]')).toBeNull();
    expect(buttonByTitle(container, "Click to rename")).toBeNull();

    await act(async () => root.unmount());
  });

  it("uses matching initial chat detail without an immediate detail refetch", async () => {
    const { ChatView } = await import("../chat-view.js");
    const initialChatDetail = chatDetail({ title: "Initial detail title", topic: "Initial detail title" });

    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" initialChatDetail={initialChatDetail} />,
      (queryClient) => {
        queryClient.removeQueries({ queryKey: ["chat-detail", "chat-1"], exact: true });
      },
      "/",
    );

    await waitForText(container, "Initial detail title");
    expect(chatMocks.getChat).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("keeps full chat details on the generic narrow Workspace path", async () => {
    const { ChatView } = await import("../chat-view.js");
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    const onShowConversations = vi.fn();
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" narrow onShowConversations={onShowConversations} />,
      undefined,
      "/",
    );

    await waitForText(container, "Launch planning");
    await waitForText(container, "Example recoverable runtime error");
    await waitForText(container, "Preview image for");
    expect(container.querySelector<HTMLElement>("[data-error-header]")?.style.overflowWrap).toBe("anywhere");
    expect(container.querySelector<HTMLElement>("[data-error-message]")?.style.overflowWrap).toBe("anywhere");
    expect(container.querySelector('[data-mobile-chat-details-sheet="true"]')).toBeNull();
    expect(container.querySelector('aside[aria-label="Chat details"]')).not.toBeNull();
    expect(container.textContent).toContain("GitHub");
    expect(container.querySelector('button[aria-label$="Open participants."]')).toBeNull();
    expect(container.querySelector('button[aria-label="Show chat details"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Hide agent final messages"]')).toBeNull();
    // Generic narrow Workspace keeps click-to-rename: it is gated on mobile
    // presentation, not viewport width, so resizing to the narrow breakpoint
    // does not drop the pre-existing rename affordance.
    expect(buttonByTitle(container, "Click to rename")).not.toBeNull();

    await click(container.querySelector('button[aria-label="Show conversations"]'));
    expect(onShowConversations).toHaveBeenCalledTimes(1);

    await click(container.querySelector('button[aria-label="Hide chat options"]'));
    expect(container.querySelector('aside[aria-label="Chat details"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("uses a mobile chat details sheet with participants and read-only GitHub follows", async () => {
    const { ChatView } = await import("../chat-view.js");
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");
    const onShowConversations = vi.fn();
    const { container, root } = await renderDom(
      <ChatView
        agentId="agent-1"
        chatId="chat-1"
        narrow
        presentation="mobile"
        onShowConversations={onShowConversations}
      />,
      undefined,
      "/",
    );

    await waitForText(container, "Launch planning");
    expect(container.querySelector('[data-mobile-chat-details-sheet="true"]')).toBeNull();
    expect(container.querySelector('aside[aria-label="Chat details"]')).toBeNull();
    // Mobile presentation keeps the header context-only: no click-to-rename.
    expect(buttonByTitle(container, "Click to rename")).toBeNull();
    // Q4: mobile chat detail exits with a back arrow, not the hamburger.
    expect(container.querySelector('button[aria-label="Back to conversations"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Show conversations"]')).toBeNull();

    await click(container.querySelector('button[aria-label="Show chat details"]'));
    await waitForText(container, "Participants · 4");
    expect(container.querySelector('[data-mobile-chat-details-sheet="true"]')).not.toBeNull();
    expect(container.querySelector('aside[aria-label="Chat details"]')).toBeNull();
    expect(container.textContent).toContain("Add");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Following in this chat");
    expect(container.textContent).toContain("Release checklist");
    expect(container.querySelector('[data-mobile-github-section="true"] a[target="_blank"]')).not.toBeNull();

    await click(container.querySelector('button[aria-label="Close chat details"]'));
    expect(container.querySelector('[data-mobile-chat-details-sheet="true"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("renders restore and read-only join states", async () => {
    const { ChatView } = await import("../chat-view.js");
    const deleted = chatDetail({ engagementStatus: "deleted", title: "Deleted launch" });
    chatMocks.getChat.mockResolvedValue(deleted);
    const deletedView = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
      seedChat(queryClient, deleted);
    });
    await waitForText(deletedView.container, "Restore");
    await click(buttonByText(deletedView.container, "Restore"));
    await waitForCondition(() => chatMocks.patchChatEngagement.mock.calls.length > 0, "Expected restore");
    expect(chatMocks.patchChatEngagement).toHaveBeenCalledWith("chat-1", "active");
    await act(async () => deletedView.root.unmount());

    const onJoin = vi.fn();
    const readOnly = await renderDom(
      <ChatView
        agentId="agent-1"
        chatId="chat-1"
        readOnly
        titleFallback="Fallback title"
        joinAction={{ error: "Join failed", joining: false, onJoin }}
      />,
    );
    await waitForText(readOnly.container, "watching");
    expect(readOnly.container.querySelector("[data-compose-status-bar]")).not.toBeNull();
    await waitForText(readOnly.container, "Join failed");
    await click(buttonByText(readOnly.container, "Join to reply"));
    expect(onJoin).toHaveBeenCalledTimes(1);
    await act(async () => readOnly.root.unmount());
  });

  it("loads secondary-agent activity into the timeline so inspector summaries have evidence", async () => {
    const { ChatView } = await import("../chat-view.js");
    const secondaryEvents = {
      items: [
        {
          id: "event-agent-2",
          agentId: "agent-2",
          chatId: "chat-1",
          seq: 1,
          kind: "assistant_text" as const,
          payload: { text: "Reviewing the mobile interaction." },
          createdAt: "2026-05-28T11:59:00.000Z",
        },
      ],
      nextCursor: null,
    };
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
      queryClient.setQueryData(
        ["chat-session-events", "chat-1"],
        chatSessionEvents(
          { agentId: "agent-1", events: SESSION_EVENTS },
          { agentId: "agent-2", events: secondaryEvents },
        ),
      );
      queryClient.setQueryData(
        ["chat-agent-status", "chat-1"],
        [
          {
            agentId: "agent-1",
            main: "ready",
            reachable: true,
            engagement: "active",
            working: false,
            errored: false,
            activity: null,
          },
          {
            agentId: "agent-2",
            main: "working",
            reachable: true,
            engagement: "active",
            working: true,
            errored: false,
            activity: {
              agentId: "agent-2",
              kind: "assistant_text",
              label: "Writing",
              startedAt: NOW,
              turnText: "Reviewing the mobile interaction.",
            },
          },
        ],
      );
    });

    await waitForCondition(
      () => container.querySelector('[data-working-agent="agent-2"]') !== null,
      "Expected secondary agent timeline evidence",
    );
    await click(container.querySelector('button[aria-label^="Open agent activity"]'));
    expect(container.querySelector('button[aria-label*="Design Critique"][aria-label*="Reviewing"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("uses one Escape to close Activity without also dismissing open chat details", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);

    await waitForCondition(
      () => container.querySelector('button[aria-label="Show chat details"]') !== null,
      "Expected chat details trigger",
    );
    await click(container.querySelector('button[aria-label="Show chat details"]'));
    await waitForCondition(
      () => container.querySelector('aside[aria-label="Chat details"]') !== null,
      "Expected chat details to be open",
    );
    await click(container.querySelector('button[aria-label^="Open agent activity"]'));
    await waitForCondition(
      () => container.querySelector("[data-live-activity-inspector]") !== null,
      "Expected Activity Inspector to open",
    );
    await waitForCondition(
      () => document.activeElement?.getAttribute("aria-label") === "Close agent activity",
      "Expected focus to enter Activity Inspector",
    );

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await flush();

    expect(container.querySelector("[data-live-activity-inspector]")).toBeNull();
    expect(container.querySelector('aside[aria-label="Chat details"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("renders provider retry events as non-fatal timeline rows when severity is not error", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
      queryClient.setQueryData(
        ["chat-session-events", "chat-1"],
        chatSessionEvents({
          agentId: "agent-1",
          events: {
            items: [
              {
                id: "retry-event",
                agentId: "agent-1",
                chatId: "chat-1",
                seq: 1,
                kind: "error",
                payload: {
                  source: "runtime",
                  message: encodeProviderRetryEventMessage({
                    event: "provider_retry_scheduled",
                    provider: "codex",
                    scope: "provider_turn",
                    category: "transient_transport",
                    reasonCode: "provider_transient_transport",
                    attempt: 1,
                    maxAttempts: 2,
                    retryMode: "foreground",
                    delayMs: 500,
                    replaySafety: "pre_visible",
                    userSeverity: "info",
                    messagePreview: "fetch failed",
                  }),
                },
                createdAt: "2026-05-28T11:56:30.000Z",
              },
            ] satisfies SessionEventRow[],
            nextCursor: null,
          },
        }),
      );
    });

    await waitForText(container, "Retrying provider");
    expect(container.textContent).toContain("fetch failed");
    expect(container.querySelector("[data-error-agent]")).toBeNull();
    await act(async () => root.unmount());
  });

  // The in-chat "needs login" entry point: a terminal credential failure means
  // the provider is installed but logged out, so the error row offers an inline
  // "Connect <provider>" that starts the in-product login for the failing
  // agent's client. Keyed strictly on `category === "credential"` + a resolvable
  // client id.
  describe("in-chat login entry point", () => {
    function credentialErrorEvents(agentId: string): { items: SessionEventRow[]; nextCursor: number | null } {
      return {
        items: [
          {
            id: "cred-fail",
            agentId,
            chatId: "chat-1",
            seq: 1,
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_failure_terminal",
                provider: "claude-code",
                scope: "session_start",
                category: "credential",
                reasonCode: "provider_credential_invalid",
                userSeverity: "error",
                messagePreview: "not logged in",
              }),
            },
            createdAt: "2026-05-28T11:56:30.000Z",
          },
        ] satisfies SessionEventRow[],
        nextCursor: null,
      };
    }

    function capacityErrorEvents(agentId: string): { items: SessionEventRow[]; nextCursor: number | null } {
      return {
        items: [
          {
            id: "capacity-wait",
            agentId,
            chatId: "chat-1",
            seq: 1,
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_retry_scheduled",
                provider: "claude-code",
                scope: "provider_turn",
                category: "provider_capacity",
                reasonCode: "capacity_wait_required",
                retryMode: "background",
                userSeverity: "warning",
                messagePreview: "at capacity",
              }),
            },
            createdAt: "2026-05-28T11:56:30.000Z",
          },
        ] satisfies SessionEventRow[],
        nextCursor: null,
      };
    }

    it("renders a Connect button on a credential failure when the agent's client resolves", async () => {
      const { ChatView } = await import("../chat-view.js");
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        // agent-1 has clientId "client-1" in ORG_AGENTS.
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: credentialErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "not logged in");
      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected the in-chat login button for a credential failure",
      );

      // Clicking starts the in-product login for the resolved client + provider.
      await click(buttonByText(container, "Connect Claude Code"));
      await waitForCondition(
        () => activityMocks.startRuntimeAuth.mock.calls.length > 0,
        "Expected the login click to start runtime auth",
      );
      expect(activityMocks.startRuntimeAuth).toHaveBeenCalledWith("client-1", { provider: "claude-code" });

      await act(async () => root.unmount());
    });

    it("does NOT render a Connect button for a non-credential failure (provider capacity)", async () => {
      const { ChatView } = await import("../chat-view.js");
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: capacityErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "at capacity");
      await flush();
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });

    it("does NOT render a Connect button when the failing agent has no client (clientId null)", async () => {
      const { ChatView } = await import("../chat-view.js");
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        // The failing agent is not in the org roster, so clientIdForAgent → null.
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-unbound", events: credentialErrorEvents("agent-unbound") }),
        );
      });

      await waitForText(container, "not logged in");
      await flush();
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });

    // Fix 1: ownership gate. The button mirrors the server's `assertClientOwner`
    // — it renders only when the failing agent's resolved client is in the
    // caller's own `/me/clients` set, so a teammate's agent on a computer the
    // caller does not own gets the error WITHOUT a button.
    it("does NOT render a Connect button when the failing agent's client is not owned by the caller", async () => {
      const { ChatView } = await import("../chat-view.js");
      // `listClients()` (the caller's own computers) returns only client-1, so
      // agent-teammate's client-teammate is resolvable but unowned.
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-teammate", events: credentialErrorEvents("agent-teammate") }),
        );
      });

      await waitForText(container, "not logged in");
      await flush();
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });

    it("renders a Connect button when the caller owns the failing agent's client (positive ownership case)", async () => {
      const { ChatView } = await import("../chat-view.js");
      // agent-1 → client-1, and listClients() returns client-1 → owned.
      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: credentialErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "not logged in");
      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected the in-chat login button when the caller owns the client",
      );

      await act(async () => root.unmount());
    });

    // Fix 2: a `claude-code-tui` credential failure shares the Claude Code
    // keychain, so it maps to the `claude-code` login target — the button is
    // labeled "Connect Claude Code" and the click starts a `claude-code` login.
    it("maps a claude-code-tui credential failure to the claude-code login target", async () => {
      const { ChatView } = await import("../chat-view.js");
      function tuiCredentialErrorEvents(agentId: string): {
        items: SessionEventRow[];
        nextCursor: number | null;
      } {
        return {
          items: [
            {
              id: "tui-cred-fail",
              agentId,
              chatId: "chat-1",
              seq: 1,
              kind: "error",
              payload: {
                source: "runtime",
                message: encodeProviderRetryEventMessage({
                  event: "provider_failure_terminal",
                  provider: "claude-code-tui",
                  scope: "session_start",
                  category: "credential",
                  reasonCode: "provider_credential_invalid",
                  userSeverity: "error",
                  messagePreview: "not logged in",
                }),
              },
              createdAt: "2026-05-28T11:56:30.000Z",
            },
          ] satisfies SessionEventRow[],
          nextCursor: null,
        };
      }

      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: tuiCredentialErrorEvents("agent-1") }),
        );
      });

      await waitForText(container, "not logged in");
      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected a Claude Code login button for a claude-code-tui credential failure",
      );

      await click(buttonByText(container, "Connect Claude Code"));
      await waitForCondition(
        () => activityMocks.startRuntimeAuth.mock.calls.length > 0,
        "Expected the login click to start runtime auth",
      );
      // The TUI failure is normalized to the claude-code Connect target.
      expect(activityMocks.startRuntimeAuth).toHaveBeenCalledWith("client-1", { provider: "claude-code" });

      await act(async () => root.unmount());
    });

    // Fix 3: the single-client poll must disarm once the attempt resolves. After
    // the click arms the poll, a terminal `lastAuthError` recorded at/after the
    // click resolves it — `getClient` must stop being re-polled.
    it("stops polling the single client once a terminal login failure is observed", async () => {
      const { ChatView } = await import("../chat-view.js");
      const clientBase = {
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
      } as const;
      // Mount fetch: clean entry (no pending / no error) so the button reads
      // "Connect Claude Code". After the first poll the client reports a terminal
      // failure stamped now, which the poll predicate treats as resolved.
      const cleanClient: HubClient = { ...clientBase, capabilities: {} };
      const failedClient: HubClient = {
        ...clientBase,
        capabilities: {
          "claude-code": {
            state: "ok",
            available: true,
            detectedAt: NOW,
            lastAuthError: { reason: "timeout", at: new Date().toISOString() },
          },
        },
      };
      let getClientCalls = 0;
      activityMocks.getClient.mockImplementation(() => {
        getClientCalls += 1;
        // First fetch (mount): clean; every fetch after the click: terminal failure.
        return Promise.resolve(getClientCalls <= 1 ? cleanClient : failedClient);
      });

      const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (queryClient) => {
        queryClient.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: credentialErrorEvents("agent-1") }),
        );
      });

      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected the in-chat login button",
      );
      await click(buttonByText(container, "Connect Claude Code"));

      // Let the post-click refetch + any disarm settle, then snapshot the call
      // count and confirm it does not keep climbing (the poll disarmed).
      await flush();
      await flush();
      const settledCalls = activityMocks.getClient.mock.calls.length;
      await flush();
      await flush();
      expect(activityMocks.getClient.mock.calls.length).toBe(settledCalls);

      await act(async () => root.unmount());
    });

    // Fix (Bug 2): the ErrorRow is a persistent timeline event, so after a
    // SUCCESSFUL in-chat login the control must stop re-inviting login. Drive a
    // real success transition — pending appears, then clears with `state: "ok"`
    // and no `lastAuthError` — and assert the row flips to a terminal "Signed in"
    // affordance with NO live Connect button.
    it("shows a terminal signed-in state (not a Connect button) after a successful in-chat login", async () => {
      const { ChatView } = await import("../chat-view.js");
      const clientBase = {
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
      } as const;
      // Mount: clean (Connect). The click's refetch delivers a live pending login
      // (the daemon launched browser sign-in); the next single-row refetch
      // delivers the resolved entry — pending cleared, still installed
      // (`state: "ok"`), no `lastAuthError` — a successful resolution. The mock is
      // phase-driven and we drive the resolving refetch by invalidating the
      // single-row query, so the transition is deterministic (no dependence on the
      // wall-clock poll cadence).
      const cleanClient: HubClient = { ...clientBase, capabilities: {} };
      const pendingClient: HubClient = {
        ...clientBase,
        capabilities: {
          "claude-code": {
            state: "ok",
            available: true,
            detectedAt: NOW,
            pendingAuth: { method: "browser", expiresAt: new Date(Date.now() + 60_000).toISOString() },
          },
        },
      };
      const signedInClient: HubClient = {
        ...clientBase,
        capabilities: { "claude-code": { state: "ok", available: true, detectedAt: NOW } },
      };
      let phase: "clean" | "pending" | "signed-in" = "clean";
      activityMocks.getClient.mockImplementation(() => {
        if (phase === "clean") return Promise.resolve(cleanClient);
        if (phase === "pending") return Promise.resolve(pendingClient);
        return Promise.resolve(signedInClient);
      });

      const { container, root, queryClient } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, (qc) => {
        qc.setQueryData(
          ["chat-session-events", "chat-1"],
          chatSessionEvents({ agentId: "agent-1", events: credentialErrorEvents("agent-1") }),
        );
      });

      await waitForCondition(
        () => buttonByText(container, "Connect Claude Code") !== null,
        "Expected the in-chat login button before sign-in",
      );
      // The click's refetch picks up the launched (pending) login.
      phase = "pending";
      await click(buttonByText(container, "Connect Claude Code"));
      await waitForCondition(
        () => container.textContent?.includes("sign-in page is opening") ?? false,
        "Expected the in-flight (pending) login state while the daemon drives sign-in",
      );

      // The daemon completes the login and re-probes: the resolving refetch
      // delivers the signed-in entry. Drive it deterministically by invalidating
      // the single-row query the button reads from.
      phase = "signed-in";
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["clients", "single", "client-1"] });
      });
      await waitForCondition(
        () => container.textContent?.includes("Signed in to Claude Code") ?? false,
        "Expected the terminal signed-in affordance after a successful login",
      );
      // And the Connect button must be gone — no re-invitation to log in.
      expect(buttonByText(container, "Connect Claude Code")).toBeNull();

      await act(async () => root.unmount());
    });
  });

  it("does not re-render old message markdown when the composer draft changes", async () => {
    const { ChatView } = await import("../chat-view.js");
    const page = messages([
      message({
        id: "stable-markdown",
        senderId: "agent-1",
        content: "Stable **markdown** body for render isolation.",
        source: "api",
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (queryClient) => seedChat(queryClient, chatDetail(), page),
      "/",
    );

    await waitForText(container, "Stable");
    await flush();
    markdownMocks.render.mockClear();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await setValue(textarea, "typing in the composer");

    expect(markdownMocks.render).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("renders a request as a normal message and does not re-render its body when a reply arrives", async () => {
    const { ChatView } = await import("../chat-view.js");
    const request = message({
      id: "req-render",
      senderId: "agent-1",
      format: "request",
      content: "Lifecycle **body** stays memoized.",
      metadata: {
        mentions: ["human-agent-self"],
        request: {
          options: [
            { label: "Proceed", description: "go ahead" },
            { label: "Hold", description: "wait" },
          ],
        },
      },
      source: "api",
      createdAt: "2026-05-28T12:00:00.000Z",
    });
    const answer = message({
      id: "req-answer",
      senderId: "human-agent-self",
      format: "markdown",
      content: "Proceed sounds good to me.",
      metadata: { resolves: { request: "req-render", kind: "answered" } },
      inReplyTo: "req-render",
      source: "web",
      createdAt: "2026-05-28T12:01:00.000Z",
    });
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([request])),
      "/",
    );

    // The request renders as a normal message body — no status-label chrome
    // (no "RESOLVED"/"OPEN" badge), since the timeline no longer special-cases
    // `format="request"`. Viewer agent-1 is not the target, so there is no
    // answer overlay either.
    await waitForText(container, "Lifecycle");
    expect(container.textContent).not.toContain("RESOLVED");
    await flush();
    markdownMocks.render.mockClear();

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], messages([request, answer]));
    });
    await flush();

    // The reply arrives as its own message; the request row is memoized and its
    // markdown body is not re-rendered.
    await waitForText(container, "Proceed sounds good to me.");
    expect(markdownMocks.render).not.toHaveBeenCalledWith("Lifecycle **body** stays memoized.");
    await act(async () => root.unmount());
  });

  // R3: opening an attachment preview (new `docChat` + `docAttachment` params)
  // collapses the right sidebar so the preview rail gets the slot, then restores
  // it when the preview params clear. Keys on the new params — before the fix
  // `hasDocPreview` still read the legacy `docPath`, so the collapse never fired.
  it("collapses the right sidebar while an attachment preview is open, restores after", async () => {
    const { ChatView } = await import("../chat-view.js");
    localStorage.setItem("first-tree:chat-right-sidebar:open:v1", "1");

    // With no doc-preview params the sidebar is open → Participants visible.
    const open = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, undefined, "/");
    await waitForText(open.container, "Participants");
    await act(async () => open.root.unmount());

    // With the attachment-preview params present the sidebar collapses →
    // Participants no longer rendered even though localStorage says "open".
    const preview = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      undefined,
      "/?docChat=chat-1&docMsg=msg-1&docAttachment=00000000-0000-4000-8000-000000000001",
    );
    await waitForText(preview.container, "Launch planning");
    await flush();
    expect(preview.container.textContent).not.toContain("Participants");
    await act(async () => preview.root.unmount());
  });

  it("sends text, blocks unaddressed image sends, then sends uploaded image batches", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, undefined, "/");

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    // Group chat, no @mention yet: the placeholder carries the rule, and the
    // tip bubble is NOT shown until a blocked send is actually attempted.
    expect(textarea.placeholder).toContain("In a group, @mention who this is for");
    expect(container.textContent).not.toContain("or no one gets this");

    // Blocked TEXT send: typing without an @mention then pressing Enter pops the
    // tip bubble and sends nothing. The send button stays clickable (not
    // `disabled`) so a click would trigger the same tip.
    await setValue(textarea, "no recipient here");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(false);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForText(container, "@mention someone, or no one gets this");
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await setValue(textarea, "Please review @nova");
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected text send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Please review @nova", ["agent-1"]);

    await setValue(textarea, "");
    const file = new File(["abc"], "preview.png", { type: "image/png" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("File input missing");
    await changeFiles(fileInput, [file]);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    // Image-only send with no @mention is blocked too; the tip bubble pops for
    // both text and image attempts.
    await waitForText(container, "@mention someone, or no one gets this");
    expect(chatMocks.sendFileMessageBatch).not.toHaveBeenCalled();

    await setValue(textarea, "@design image attached");
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendFileMessageBatch.mock.calls.length > 0, "Expected image send");
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(file);
    expect(chatMocks.sendFileMessageBatch).toHaveBeenCalledWith(
      "chat-1",
      {
        caption: "@design image attached",
        attachments: [{ imageId: "uploaded-image", mimeType: "image/png", filename: "preview.png", size: 3 }],
      },
      { mentions: ["agent-2"] },
      // No live request in this chat → nothing to thread under.
      undefined,
    );

    await act(async () => root.unmount());
  });

  it("clears the mention tip when switching to another group chat", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      undefined,
      "/",
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    // Trigger the tip in chat-1 (group, no @mention).
    await setValue(textarea, "no recipient");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForText(container, "@mention someone, or no one gets this");

    // Switch to another group chat on the SAME long-lived ChatView instance
    // (identical provider wrappers → React updates the chatId prop rather than
    // remounting). The tip must not leak into the new chat before any blocked
    // send there.
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/"]}>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <ChatView agentId="agent-1" chatId="chat-2" />
            </ToastProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    // Pre-paint: the render gate (tip's origin chat ≠ viewed chat) keeps the
    // stale bubble from painting even before effects flush — assert right after
    // the commit, with no intervening flush.
    expect(container.textContent).not.toContain("@mention someone, or no one gets this");
    await flush();
    expect(container.textContent).not.toContain("@mention someone, or no one gets this");

    await act(async () => root.unmount());
  });

  it("clears a stale auto-primed @ when a request dock arrives late and clean-resolves option answers", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-1",
        senderId: "agent-1",
        format: "request",
        content: "Pick the deploy color.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            options: [
              { label: "Blue-green", description: "blue-green deploy" },
              { label: "Rolling update", description: "rolling deploy" },
            ],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForCondition(() => textarea.value === "@", "Expected group focus to prime @ before dock data arrives");

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], dockMessages);
    });
    await flush();
    await waitForText(container, "Reply");
    await waitForCondition(() => textarea.value === "", "Expected late request dock to clear auto-primed @");

    // Decoupled: clicking an option highlights the pill but does NOT fill the
    // composer — the draft stays empty (the auto-primed @ has been cleared).
    // Answering happens in the overlay: the composer stays empty.
    await click(askOption(container, "Blue-green"));
    expect(textarea.value).toBe("");
    await click(buttonByText(container, "Reply"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected option answer send");
    // The answer is the selected option label, resolving the question.
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Blue-green", ["agent-1"], {
      inReplyTo: "req-1",
      resolves: { request: "req-1", kind: "answered" },
    });

    await act(async () => root.unmount());
  });

  it("resolves an options answer via the overlay Reply button (gated on a selection)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-enter",
        senderId: "agent-1",
        format: "request",
        content: "Pick the deploy color.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            options: [
              { label: "Blue-green", description: "blue-green deploy" },
              { label: "Rolling update", description: "rolling deploy" },
            ],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], dockMessages);
    });
    await flush();
    await waitForText(container, "Reply");

    // Reply is disabled until an option is picked, then resolves with the label.
    expect(buttonByText(container, "Reply")?.disabled).toBe(true);
    await click(askOption(container, "Blue-green"));
    expect(buttonByText(container, "Reply")?.disabled).toBe(false);
    await click(buttonByText(container, "Reply"));
    await waitForCondition(
      () => chatMocks.sendChatMessage.mock.calls.length > 0,
      "Expected the options answer to resolve",
    );
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Blue-green", ["agent-1"], {
      inReplyTo: "req-enter",
      resolves: { request: "req-enter", kind: "answered" },
    });

    await act(async () => root.unmount());
  });

  it("surfaces a buried open ask (outside the message window) via the open-requests source", async () => {
    const { ChatView } = await import("../chat-view.js");
    // An open ask that is NOT in the loaded 50-message timeline — only the
    // window-independent open-requests source knows about it.
    const buriedAsk = message({
      id: "req-buried",
      senderId: "agent-1",
      format: "request",
      content: "Approve the migration?",
      metadata: {
        mentions: ["human-agent-self"],
        request: {
          options: [
            { label: "Approve", description: "go" },
            { label: "Hold", description: "wait" },
          ],
        },
      },
      createdAt: "2026-05-28T11:00:00.000Z",
    });
    chatMocks.listChatOpenRequests.mockResolvedValue({ items: [buriedAsk] });

    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      // Timeline seeded WITHOUT the request — it is past the loaded window.
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    await act(async () => {
      queryClient.setQueryData(["chat-open-requests", "chat-1"], { items: [buriedAsk] });
    });
    await flush();

    // The blocking takeover still appears, driven by the open-requests source.
    await waitForText(container, "Approve the migration?");
    expect(buttonByText(container, "Reply")).toBeTruthy();
    expect(buttonByText(container, "Skip")).toBeTruthy();

    await act(async () => root.unmount());
  });

  it("Skip resolves the question with a skipped answer (no temporary dismiss)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-skip",
        senderId: "agent-1",
        format: "request",
        content: "Pick the deploy color.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            options: [
              { label: "Blue-green", description: "blue-green deploy" },
              { label: "Rolling update", description: "rolling deploy" },
            ],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], dockMessages);
    });
    await flush();
    await waitForText(container, "Skip");

    // Skip is always enabled and resolves the question with a skipped answer —
    // it does NOT just dismiss the overlay (the open request would persist).
    expect(buttonByText(container, "Skip")?.disabled).toBe(false);
    await click(buttonByText(container, "Skip"));
    await waitForCondition(
      () => chatMocks.sendChatMessage.mock.calls.length > 0,
      "Expected Skip to resolve the question",
    );
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "(Skipped — no answer provided.)", ["agent-1"], {
      inReplyTo: "req-skip",
      resolves: { request: "req-skip", kind: "answered" },
    });

    await act(async () => root.unmount());
  });

  it("enables Send and resolves when an option question is answered with free text (no option picked)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-opt",
        senderId: "agent-1",
        format: "request",
        content: "Pick the deploy color.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            options: [
              { label: "Blue-green", description: "blue-green deploy" },
              { label: "Rolling update", description: "rolling deploy" },
            ],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), dockMessages),
      "/",
    );

    await waitForText(container, "Reply");
    const other = askTextarea(container);
    if (!other) throw new Error("Overlay free-text input missing");

    // No option picked + empty Other → Reply disabled.
    expect(buttonByText(container, "Reply")?.disabled).toBe(true);

    // Typing a free-text answer (without picking an option) enables Reply.
    await setValue(other, "Neither — let's hold the deploy");
    expect(buttonByText(container, "Reply")?.disabled).toBe(false);

    // ...and Reply resolves with the free text as the answer.
    await click(buttonByText(container, "Reply"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected free-text answer send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Neither — let's hold the deploy", ["agent-1"], {
      inReplyTo: "req-opt",
      resolves: { request: "req-opt", kind: "answered" },
    });

    await act(async () => root.unmount());
  });

  it("does not clear a user-typed @ after an earlier focus auto-prime", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
      message({
        id: "req-manual-mention",
        senderId: "agent-1",
        format: "request",
        content: "Discuss the deploy.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            subject: "Deploy",
            questions: [{ id: "q1", prompt: "Concerns?", kind: "free", required: true }],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);
    const { container, queryClient, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), messages([])),
      "/",
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: true }));
    });
    await flush();
    await waitForCondition(() => textarea.value === "@", "Expected initial group focus to auto-prime @");

    await setValue(textarea, "");
    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], dockMessages);
    });
    await flush();
    await waitForText(container, "Reply");
    expect(textarea.value).toBe("");

    await setValue(textarea, "@");
    await flush();
    expect(textarea.value).toBe("@");

    await act(async () => root.unmount());
  });

  // Shared free-text (legacy-shape → free-text fallback) blocking ask used by the
  // text-resolve and image-resolve cases below.
  const freeTextDockMessages = () =>
    messages([
      message({
        id: "req-file",
        senderId: "agent-1",
        format: "request",
        content: "Attach the rollout screenshot.",
        metadata: {
          mentions: ["human-agent-self"],
          request: {
            subject: "Evidence",
            questions: [{ id: "q1", prompt: "Evidence?", kind: "free", required: true }],
          },
        },
        createdAt: "2026-05-28T12:00:00.000Z",
      }),
    ]);

  it("resolves a blocking free-text question via a typed text answer", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), freeTextDockMessages()),
      "/",
    );

    await waitForText(container, "Reply");
    const answerBox = askTextarea(container);
    if (!answerBox) throw new Error("Overlay free-text input missing");
    await setValue(answerBox, "Screenshot evidence attached");
    await click(buttonByText(container, "Reply"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected text resolve send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Screenshot evidence attached", ["agent-1"], {
      inReplyTo: "req-file",
      resolves: { request: "req-file", kind: "answered" },
    });
    expect(chatMocks.sendFileMessageBatch).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("resolves a blocking free-text question with an attached image via a file-batch resolve", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), freeTextDockMessages()),
      "/",
    );

    await waitForText(container, "Reply");
    const answerBox = askTextarea(container);
    if (!answerBox) throw new Error("Overlay free-text input missing");
    await setValue(answerBox, "Screenshot evidence attached");
    // The ask card now owns image attachments — its file input is the first one
    // in the DOM (the overlay renders above the covered composer). Attaching an
    // image makes the resolving reply a `format="file"` batch that STILL carries
    // `metadata.resolves`, so the question resolves exactly like a text answer.
    const file = new File(["abc"], "evidence.png", { type: "image/png" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("File input missing");
    await changeFiles(fileInput, [file]);
    await click(buttonByText(container, "Reply"));
    await waitForCondition(
      () => chatMocks.sendFileMessageBatch.mock.calls.length > 0,
      "Expected image file-batch resolve",
    );
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(file);
    expect(chatMocks.sendFileMessageBatch).toHaveBeenCalledWith(
      "chat-1",
      {
        caption: "Screenshot evidence attached",
        attachments: [{ imageId: "uploaded-image", mimeType: "image/png", filename: "evidence.png", size: 3 }],
      },
      { mentions: ["agent-1"] },
      { inReplyTo: "req-file", resolves: { request: "req-file", kind: "answered" } },
    );
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("resolves a blocking free-text question with an attached document via metadata refs", async () => {
    attachmentMocks.uploadAttachment.mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      mimeType: "application/pdf",
      size: 3,
    });
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), freeTextDockMessages()),
      "/",
    );

    await waitForText(container, "Reply");
    const file = new File(["pdf"], "evidence.pdf", { type: "application/pdf" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("File input missing");
    await changeFiles(fileInput, [file]);
    await waitForText(container, "evidence.pdf");
    await click(buttonByText(container, "Reply"));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected document resolve send");
    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(file);
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "", ["agent-1"], {
      inReplyTo: "req-file",
      resolves: { request: "req-file", kind: "answered" },
      attachments: [
        {
          attachmentId: "11111111-1111-4111-8111-111111111111",
          kind: "file",
          mimeType: "application/pdf",
          filename: "evidence.pdf",
          size: 3,
        },
      ],
    });
    expect(chatMocks.sendFileMessageBatch).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("handles empty and direct-chat branches", async () => {
    const { ChatView } = await import("../chat-view.js");
    const emptyDetail = chatDetail({
      id: "chat-empty",
      title: "Empty direct",
      type: "direct",
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
    const empty = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-empty" />,
      (queryClient) => {
        seedChat(queryClient, emptyDetail, messages([]));
        queryClient.setQueryData(
          ["chat-session-events", "chat-empty"],
          chatSessionEvents({ agentId: "agent-1", events: { items: [], nextCursor: null } }),
        );
      },
      "/",
    );
    await waitForText(empty.container, "Send a message to start the conversation");
    const textarea = empty.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Direct composer textarea missing");
    await waitForCondition(() => textarea.value.includes("Hi Nova!"), "Expected direct-chat greeting");
    await setValue(textarea, "hello there");
    await click(empty.container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected direct send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-empty", "hello there", ["agent-1"]);
    await act(async () => empty.root.unmount());
  });

  function directDetail(): ChatDetail {
    return chatDetail({
      id: "chat-empty",
      title: "Empty direct",
      type: "direct",
      participants: [
        participant({ agentId: "human-agent-self", type: "human", name: "gandy", displayName: "Gandy" }),
        participant({ agentId: "agent-1", name: "nova", displayName: "Nova" }),
      ],
    });
  }

  it("mobile composer: one-line rest, 44-unit send hit area, simplified placeholder, Enter does not send", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-empty" narrow presentation="mobile" />,
      (queryClient) => {
        seedChat(queryClient, directDetail(), messages([]));
        queryClient.setQueryData(
          ["chat-session-events", "chat-empty"],
          chatSessionEvents({ agentId: "agent-1", events: { items: [], nextCursor: null } }),
        );
      },
      "/",
    );
    await waitForText(container, "Send a message to start the conversation");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    const timeline = container.querySelector<HTMLElement>("[data-chat-timeline-scroll]");
    const footer = container.querySelector<HTMLElement>("[data-chat-composer-footer]");
    if (!textarea || !send || !timeline || !footer) throw new Error("Mobile composer or timeline missing");

    expect(timeline.style.padding).toContain("var(--sp-4)");
    expect(footer.style.paddingInline).toBe("var(--sp-4)");

    // Resting height is one row: the auto-resize hook measures the `rows`-sized
    // empty box, so `rows` (not just the min-height floor) must drop to 1.
    expect(Number(textarea.rows)).toBe(1);
    // Send is the ONLY send path on mobile (Enter inserts a newline), so its hit
    // area must clear the touch minimum.
    expect(Number.parseInt(send.style.width, 10)).toBe(44);
    expect(Number.parseInt(send.style.height, 10)).toBe(44);
    // Placeholder drops the desktop keyboard-shortcut teaching text.
    await setValue(textarea, "");
    expect(textarea.placeholder).not.toContain("for commands");
    expect(textarea.placeholder).not.toContain("to mention");

    // Enter inserts a newline and sends nothing; the button is the only send.
    await setValue(textarea, "hello there");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(chatMocks.sendChatMessage).not.toHaveBeenCalled();
    await click(send);
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected button send on mobile");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-empty", "hello there", ["agent-1"]);

    await act(async () => root.unmount());
  });

  it("desktop composer unchanged: two-row rest, compact send, full placeholder, Enter sends", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-empty" />,
      (queryClient) => {
        seedChat(queryClient, directDetail(), messages([]));
        queryClient.setQueryData(
          ["chat-session-events", "chat-empty"],
          chatSessionEvents({ agentId: "agent-1", events: { items: [], nextCursor: null } }),
        );
      },
      "/",
    );
    await waitForText(container, "Send a message to start the conversation");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    const timeline = container.querySelector<HTMLElement>("[data-chat-timeline-scroll]");
    const footer = container.querySelector<HTMLElement>("[data-chat-composer-footer]");
    if (!textarea || !send || !timeline || !footer) throw new Error("Desktop composer or timeline missing");

    expect(timeline.style.padding).toContain("var(--sp-6)");
    expect(footer.style.paddingInline).toBe("var(--sp-6)");

    expect(Number(textarea.rows)).toBe(2);
    expect(Number.parseInt(send.style.width, 10)).toBe(28);
    expect(Number.parseInt(send.style.height, 10)).toBe(28);
    await setValue(textarea, "");
    expect(textarea.placeholder).toContain("for commands");

    // Desktop keeps Enter-to-send.
    await setValue(textarea, "hello there");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected Enter send on desktop");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-empty", "hello there", ["agent-1"]);

    await act(async () => root.unmount());
  });

  it("renders an agent worktree-path link as plain text while keeping real web links (issue 831)", async () => {
    const { ChatView } = await import("../chat-view.js");
    const worktree = "/Users/u/.first-tree/data/workspaces/a/worktrees/build-tree";
    // An agent reporting tree-build progress: a markdown link to its local
    // worktree directory (a 404 trap) alongside a genuine external URL.
    const page = messages([
      message({
        id: "msg-worktree",
        senderId: "agent-1",
        source: "api",
        content: `Built the tree at [${worktree}](${worktree}). Docs: https://example.com/guide`,
        createdAt: "2026-05-28T11:59:00.000Z",
      }),
    ]);
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (queryClient) => {
        seedChat(queryClient, chatDetail(), page);
      },
      "/",
    );

    await waitForText(container, "Built the tree at");

    const anchorHrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    // The worktree directory path has no web route — it must NOT be a live
    // anchor (clicking would 404 against the cloud origin), but the path text
    // is preserved as plain text.
    expect(container.querySelector(`a[href="${worktree}"]`)).toBeNull();
    expect(anchorHrefs).not.toContain(worktree);
    expect(container.textContent).toContain("worktrees/build-tree");
    // A genuine external link in the same message still renders as an anchor.
    expect(anchorHrefs).toContain("https://example.com/guide");

    await act(async () => root.unmount());
  });

  it("opens the image lightbox on thumbnail click and closes on Escape", async () => {
    // BASE_MESSAGES' msg-3 is a one-image message ("preview.png").
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);
    const thumb = () => container.querySelector<HTMLButtonElement>('button[aria-label="Open image preview.png"]');
    await waitForCondition(() => thumb() !== null, "image thumbnail did not render");

    await click(thumb());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('img[alt="preview.png"]')).not.toBeNull();
    expect(dialog?.querySelector('button[aria-label="Download original"]')).not.toBeNull();
    expect(dialog?.querySelector('button[aria-label="Close"]')).not.toBeNull();
    // Single image: no prev/next paging affordances.
    expect(dialog?.querySelector('button[aria-label="Next image"]')).toBeNull();

    // Radix listens for Escape on document; this closes the lightbox.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitForCondition(
      () => document.querySelector('[role="dialog"]') === null,
      "lightbox did not close on Escape",
    );

    await act(async () => root.unmount());
  });

  it("bounds the image thumbnail by the message column (no fixed-px overflow on narrow/mobile)", async () => {
    // The inline maxWidth must stay container-relative (`min(..., 100%)`), not a
    // bare fixed cap that would override `img { max-width: 100% }` and overflow
    // the narrow mobile message column. Layout isn't measurable in jsdom, so
    // assert the container-aware declaration is present.
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />);
    const thumbImg = () => container.querySelector<HTMLImageElement>('button[aria-label="Open image preview.png"] img');
    await waitForCondition(() => thumbImg() !== null, "image thumbnail did not render");

    const style = thumbImg()?.getAttribute("style") ?? "";
    expect(style).toContain("100%");
    expect(style).toContain("min(");

    await act(async () => root.unmount());
  });

  // The chat summary (`chat.description`) now renders in the pinned ChatSummary
  // between the chat header and the message stream — NOT in the right rail.
  describe("pinned summary", () => {
    // Distinct from BASE_MESSAGES' body so assertions can't match unrelated chrome.
    const DESCRIPTION_MD = "Status: shipping **DescBody** soon.";

    function sidebarOpen(container: ParentNode): boolean {
      return container.querySelector('aside[aria-label="Chat details"]') !== null;
    }
    function chatSummaryButton(container: ParentNode): HTMLButtonElement | null {
      return container.querySelector<HTMLButtonElement>('button[aria-label$="summary"]');
    }

    it("renders the description's first line collapsed and the full markdown when expanded", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, withDescription),
        "/",
      );

      await waitForCondition(
        () => chatSummaryButton(container) !== null,
        "Expected the summary to render for a chat with a description",
      );
      const button = chatSummaryButton(container);
      if (!button) throw new Error("summary button missing");
      // Collapsed bar = the first line with markdown markers stripped.
      expect(button.textContent).toContain("Status: shipping DescBody soon.");

      // Expand → faithful markdown (bold renders as <strong>DescBody</strong>).
      await act(async () => {
        button.click();
      });
      expect(chatSummaryButton(container)?.textContent).toContain("Summary");
      expect(chatSummaryButton(container)?.textContent).not.toContain("Status: shipping DescBody soon.");
      await waitForCondition(
        () => [...container.querySelectorAll("strong")].some((el) => el.textContent === "DescBody"),
        "Expected the expanded summary to render the description markdown",
      );

      await act(async () => root.unmount());
    });

    it("auto-expands an unread summary version on entry", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const unreadDescription = chatDetail({
        description: DESCRIPTION_MD,
        descriptionUpdatedAt: "2026-05-28T12:05:00.000Z",
        lastReadAt: "2026-05-28T12:00:00.000Z",
      });
      chatMocks.getChat.mockResolvedValue(unreadDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, unreadDescription),
        "/",
      );

      await waitForCondition(
        () =>
          chatSummaryButton(container)?.getAttribute("aria-label") === "Collapse summary" &&
          [...container.querySelectorAll("strong")].some((el) => el.textContent === "DescBody"),
        "Expected the unread summary version to auto-expand on entry",
      );
      expect(chatSummaryButton(container)?.textContent).toContain("Summary");

      await act(async () => root.unmount());
    });

    it("renders no summary when the chat has no description", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const noDescription = chatDetail({ description: null });
      chatMocks.getChat.mockResolvedValue(noDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, noDescription),
        "/",
      );

      await waitForText(container, "Launch planning");
      await flush();
      expect(chatSummaryButton(container)).toBeNull();

      await act(async () => root.unmount());
    });

    it("does NOT auto-open the right rail for a described chat — the summary lives in the summary", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, withDescription),
        "/",
      );

      await waitForCondition(() => chatSummaryButton(container) !== null, "Expected the summary to render");
      await flush();
      // The rail no longer pops open just because the chat has a description.
      expect(sidebarOpen(container)).toBe(false);

      await act(async () => root.unmount());
    });

    it("exposes no edit affordance — read-only", async () => {
      localStorage.clear();
      const { ChatView } = await import("../chat-view.js");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, withDescription),
        "/",
      );

      await waitForCondition(() => chatSummaryButton(container) !== null, "Expected the summary to render");
      const button = chatSummaryButton(container);
      if (!button) throw new Error("summary button missing");
      // Expand and confirm the expanded surface still exposes no edit affordance.
      await act(async () => {
        button.click();
      });
      await flush();
      const headerRoot = button.parentElement;
      if (!headerRoot) throw new Error("summary root missing");
      // Read-only is self-evident: the only control is the expand/collapse toggle —
      // no edit button / input / textarea (the footer + info hint were removed).
      expect(headerRoot.querySelectorAll("button")).toHaveLength(1);
      expect(headerRoot.querySelector("input")).toBeNull();
      expect(headerRoot.querySelector("textarea")).toBeNull();

      await act(async () => root.unmount());
    });
  });
});
