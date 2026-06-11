// @vitest-environment happy-dom

import type { Agent, ChatDetail, ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../../api/activity.js";
import type { MessageWithDelivery, PaginatedMessages } from "../../../../api/chats.js";
import type { SessionEventRow } from "../../../../api/sessions.js";
import { agentSessionsQueryKey } from "../../../../api/sessions.js";
import { ToastProvider } from "../../../../components/ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  listClients: vi.fn(),
}));

const agentStatusMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  getAgentSkills: vi.fn(),
  listAgents: vi.fn(),
}));

const attachmentMocks = vi.hoisted(() => ({
  fetchAttachmentBase64: vi.fn(),
  uploadImageAttachment: vi.fn(),
}));

const chatMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  listChatMessages: vi.fn(),
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
  listSessionEvents: sessionMocks.listSessionEvents,
  listSessionOutputs: sessionMocks.listSessionOutputs,
}));

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentIdentityMap: () => (id: string | null | undefined) => {
    if (!id) return null;
    return {
      name: AGENT_SLUGS[id] ?? id,
      displayName: AGENT_NAMES[id] ?? id,
      avatarImageUrl: null,
      avatarColorToken: id === "agent-1" ? "hue-2" : null,
    };
  },
  useAgentNameMap: () => (id: string | null | undefined) => (id ? (AGENT_NAMES[id] ?? id) : "unknown"),
  useAgentSlugToIdMap: () => (slug: string | null | undefined) => {
    if (!slug) return null;
    return Object.entries(AGENT_SLUGS).find(([, value]) => value === slug)?.[0] ?? null;
  },
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
      documentContext: {
        kind: "snapshot",
        docs: [{ path: "docs/plan.md", content: "# Plan\nShip carefully.", sha256: "sha", size: 21 }],
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
      documentContext: {
        kind: "snapshot",
        docs: [{ path: "docs/plan.md", content: "# Plan\nShip carefully.", sha256: "sha", size: 21 }],
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
  queryClient.setQueryData(["session-events", "agent-1", detail.id], SESSION_EVENTS);
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
  route = "/?docChat=chat-1&docAgent=agent-1&docPath=docs/plan.md",
): Promise<{ container: HTMLElement; root: Root }> {
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
  return { container, root };
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
  attachmentMocks.uploadImageAttachment.mockResolvedValue({ id: "uploaded-image", mimeType: "image/png", size: 42 });
  chatMocks.getChat.mockResolvedValue(chatDetail());
  chatMocks.listChatMessages.mockResolvedValue(BASE_MESSAGES);
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
  sessionMocks.listSessionEvents.mockResolvedValue(SESSION_EVENTS);
  sessionMocks.listSessionOutputs.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChatView", () => {
  it("renders timeline chrome, sidebar controls, rename, restore, and read-only join states", async () => {
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
    await waitForText(container, "Participants");
    await waitForText(container, "Release checklist");

    await click(container.querySelector('button[aria-label="Show conversations"]'));
    expect(onShowConversations).toHaveBeenCalledTimes(1);

    await click(buttonByTitle(container, "Click to rename"));
    const renameInput = container.querySelector<HTMLInputElement>("input");
    if (!renameInput) throw new Error("Rename input missing");
    await setValue(renameInput, "Renamed launch");
    await click(buttonByTitle(container, "Save"));
    await waitForCondition(() => chatMocks.renameChat.mock.calls.length > 0, "Expected rename");
    expect(chatMocks.renameChat).toHaveBeenCalledWith("chat-1", "Renamed launch");

    await click(container.querySelector('button[aria-label="Dismiss"]'));

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
    await waitForText(readOnly.container, "Join failed");
    await click(buttonByText(readOnly.container, "Join to reply"));
    expect(onJoin).toHaveBeenCalledTimes(1);
    await act(async () => readOnly.root.unmount());

    await act(async () => root.unmount());
  });

  it("sends text, blocks unaddressed image sends, then sends uploaded image batches", async () => {
    const { ChatView } = await import("../chat-view.js");
    const { container, root } = await renderDom(<ChatView agentId="agent-1" chatId="chat-1" />, undefined, "/");

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    expect(textarea.placeholder).toContain("Type @ to pick a recipient");
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
    await waitForText(container, "@mention a group member");
    expect(chatMocks.sendFileMessageBatch).not.toHaveBeenCalled();

    await setValue(textarea, "@design image attached");
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendFileMessageBatch.mock.calls.length > 0, "Expected image send");
    expect(attachmentMocks.uploadImageAttachment).toHaveBeenCalledWith(file);
    expect(chatMocks.sendFileMessageBatch).toHaveBeenCalledWith(
      "chat-1",
      {
        caption: "@design image attached",
        attachments: [{ imageId: "uploaded-image", mimeType: "image/png", filename: "preview.png", size: 3 }],
      },
      { mentions: ["agent-2"] },
    );

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
        queryClient.setQueryData(["session-events", "agent-1", "chat-empty"], { items: [], nextCursor: null });
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
});
