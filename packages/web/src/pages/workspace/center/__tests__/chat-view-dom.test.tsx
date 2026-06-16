// @vitest-environment happy-dom

import type { Agent, ChatDetail, ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router";
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

function optionByText(container: ParentNode, text: string): HTMLLabelElement | null {
  return [...container.querySelectorAll("label")].find((label) => label.textContent?.includes(text)) ?? null;
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

  it("does not re-render an old request markdown body when request state changes", async () => {
    const { ChatView } = await import("../chat-view.js");
    const request = message({
      id: "req-render",
      senderId: "agent-1",
      format: "request",
      content: "Lifecycle **body** stays memoized.",
      metadata: {
        mentions: ["human-agent-self"],
        request: {
          subject: "Render isolation",
          questions: [{ id: "q1", prompt: "Proceed?", kind: "single", options: ["Yes"], required: true }],
        },
      },
      source: "api",
      createdAt: "2026-05-28T12:00:00.000Z",
    });
    const answer = message({
      id: "req-answer",
      senderId: "human-agent-self",
      format: "card",
      content: { resolved: true },
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

    await waitForText(container, "Lifecycle");
    await waitForText(container, "Awaiting your answer");
    await flush();
    markdownMocks.render.mockClear();

    await act(async () => {
      queryClient.setQueryData(["chat-messages", "chat-1"], messages([request, answer]));
    });
    await flush();

    await waitForText(container, "RESOLVED");
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
      // No live request in this chat → nothing to thread under.
      undefined,
    );

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
            subject: "Deploy",
            questions: [
              {
                id: "q1",
                prompt: "Deploy color?",
                kind: "single",
                options: ["Blue-green", "Rolling update"],
                required: true,
              },
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
    await waitForText(container, "Awaiting your answer");
    await waitForCondition(() => textarea.value === "", "Expected late request dock to clear auto-primed @");

    // Decoupled: clicking an option highlights the pill but does NOT fill the
    // composer — the draft stays empty (the auto-primed @ has been cleared).
    await click(optionByText(container, "Blue-green"));
    expect(textarea.value).toBe("");
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected option answer send");
    // Sending merges the selection into a canonical line and resolves.
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith("chat-1", "Deploy color? → Blue-green", ["agent-1"], {
      inReplyTo: "req-1",
      resolves: { request: "req-1", kind: "answered" },
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
            subject: "Deploy",
            questions: [
              {
                id: "q1",
                prompt: "Deploy color?",
                kind: "single",
                options: ["Blue-green", "Rolling update"],
                required: true,
              },
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

    await waitForText(container, "Awaiting your answer");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");

    // No option picked + empty composer → Send disabled.
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(true);

    // Typing a free-text answer (without picking an option) must enable Send —
    // this was the reported bug.
    await setValue(textarea, "Neither — let's hold the deploy");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(false);

    // ...and sending resolves the question with the free text as the answer.
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected free-text answer send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith(
      "chat-1",
      "Deploy color? → Neither — let's hold the deploy",
      ["agent-1"],
      { inReplyTo: "req-opt", resolves: { request: "req-opt", kind: "answered" } },
    );

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
    await waitForText(container, "Awaiting your answer");
    expect(textarea.value).toBe("");

    await setValue(textarea, "@");
    await flush();
    expect(textarea.value).toBe("@");

    await act(async () => root.unmount());
  });

  it("resolves a blocking free-text question via a text reply; an attached image is not sent while blocked", async () => {
    const { ChatView } = await import("../chat-view.js");
    const dockMessages = messages([
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
    const { container, root } = await renderDom(
      <ChatView agentId="agent-1" chatId="chat-1" />,
      (client) => seedChat(client, chatDetail(), dockMessages),
      "/",
    );

    await waitForText(container, "Awaiting your answer");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Composer textarea missing");
    await setValue(textarea, "Screenshot evidence attached");
    // While a question blocks me there is no image/judge reply path — the send
    // is the answer and it resolves via a text reply. An attached image is left
    // pending (not sent) so it can be sent normally once the block lifts.
    const file = new File(["abc"], "evidence.png", { type: "image/png" });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("File input missing");
    await changeFiles(fileInput, [file]);
    await click(container.querySelector('button[aria-label="Send"]'));
    await waitForCondition(() => chatMocks.sendChatMessage.mock.calls.length > 0, "Expected text resolve send");
    expect(chatMocks.sendChatMessage).toHaveBeenCalledWith(
      "chat-1",
      "Evidence? → Screenshot evidence attached",
      ["agent-1"],
      { inReplyTo: "req-file", resolves: { request: "req-file", kind: "answered" } },
    );
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

  // Requirement D — the right rail's DescriptionSection auto-opens for chats
  // that have a description, when the user has no stored rail preference.
  describe("description-driven right-rail default", () => {
    const SIDEBAR_KEY = "first-tree:chat-right-sidebar:open:v1";
    // Distinct from BASE_MESSAGES' "Description"-free body so the assertion
    // can't accidentally match unrelated chrome.
    const DESCRIPTION_MD = "Status: shipping **DescBody** soon.";

    function sidebarOpen(container: ParentNode): boolean {
      return container.querySelector('aside[aria-label="Chat details"]') !== null;
    }

    it("auto-opens the rail and renders the DescriptionSection markdown when a chat HAS a description and no stored preference", async () => {
      const { ChatView } = await import("../chat-view.js");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, withDescription),
        "/",
      );

      await waitForCondition(() => sidebarOpen(container), "Expected rail to auto-open for a chat with a description");
      const aside = container.querySelector('aside[aria-label="Chat details"]');
      if (!aside) throw new Error("Sidebar aside missing");
      // DescriptionSection eyebrow + markdown body (bold renders as <strong>).
      expect(aside.textContent).toContain("Description");
      expect(aside.textContent).toContain("shipping");
      expect([...aside.querySelectorAll("strong")].some((el) => el.textContent === "DescBody")).toBe(true);

      await act(async () => root.unmount());
    });

    it("keeps the rail collapsed when a chat has NO description and no stored preference", async () => {
      const { ChatView } = await import("../chat-view.js");
      const noDescription = chatDetail({ description: null });
      chatMocks.getChat.mockResolvedValue(noDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, noDescription),
        "/",
      );

      await waitForText(container, "Launch planning");
      // Give the description-default effect a chance to (not) fire.
      await flush();
      expect(sidebarOpen(container)).toBe(false);

      await act(async () => root.unmount());
    });

    // The actual regression: ChatView is NOT remounted on chat switch (the
    // chat-detail query just refetches by chatId). The old once-per-mount guard
    // applied the default only to the FIRST chat — a second chat with a
    // description stayed collapsed. The per-chat-keyed fix must auto-open the
    // second chat too.
    it("auto-opens the rail for a SECOND chat after switching chatId on a mounted ChatView", async () => {
      const { ChatView } = await import("../chat-view.js");
      // First chat: no description → rail stays collapsed.
      const first = chatDetail({ id: "chat-1", description: null });
      const second = chatDetail({
        id: "chat-2",
        title: "Second chat",
        topic: "Second chat",
        description: DESCRIPTION_MD,
      });
      chatMocks.getChat.mockImplementation((id: string) => Promise.resolve(id === "chat-2" ? second : first));

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const queryClient = createClient();
      seedChat(queryClient, first);
      seedChat(queryClient, second);

      const renderAt = async (chatId: string): Promise<void> => {
        await act(async () => {
          root.render(
            <MemoryRouter initialEntries={["/"]}>
              <QueryClientProvider client={queryClient}>
                <ToastProvider>
                  <ChatView agentId="agent-1" chatId={chatId} />
                </ToastProvider>
              </QueryClientProvider>
            </MemoryRouter>,
          );
        });
        await flush();
      };

      await renderAt("chat-1");
      await waitForText(container, "Launch planning");
      await flush();
      expect(sidebarOpen(container)).toBe(false);

      // Switch to the second chat WITHOUT remounting (same root, new chatId).
      await renderAt("chat-2");
      await waitForCondition(
        () => sidebarOpen(container),
        "Expected rail to auto-open for the SECOND chat after a chatId switch (regression: once-per-mount guard)",
      );
      const aside = container.querySelector('aside[aria-label="Chat details"]');
      expect(aside?.textContent).toContain("DescBody");

      await act(async () => root.unmount());
    });

    it("does not auto-open when the user has an explicit stored 'closed' preference, even with a description", async () => {
      const { ChatView } = await import("../chat-view.js");
      localStorage.setItem(SIDEBAR_KEY, "0");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);
      const { container, root } = await renderDom(
        <ChatView agentId="agent-1" chatId="chat-1" />,
        (queryClient) => seedChat(queryClient, withDescription),
        "/",
      );

      await waitForText(container, "Launch planning");
      await flush();
      expect(sidebarOpen(container)).toBe(false);

      await act(async () => root.unmount());
    });

    // The doc-preview-deep-link regression: a described chat entered while a
    // doc-preview already owns the right rail (params present on first mount)
    // must STILL auto-open its DescriptionSection once the preview closes. The
    // pre-fix ordering marked the chat "applied" before the `hasDocPreview`
    // bail, so closing the preview hit the per-chat guard and the rail never
    // opened. The fix bails WITHOUT marking, so the preview-close re-run applies
    // the default. ChatView must NOT remount across the close — navigation is
    // driven through the live router so `descriptionDefaultChatRef` survives.
    it("auto-opens a described chat's rail after a doc-preview deep link closes (no remount)", async () => {
      const { ChatView } = await import("../chat-view.js");
      const withDescription = chatDetail({ description: DESCRIPTION_MD });
      chatMocks.getChat.mockResolvedValue(withDescription);

      // Capture the live router's navigate so the test can clear the
      // doc-preview params on the SAME mounted tree (simulating the preview
      // closing) without remounting ChatView.
      let navigate: ((to: string) => void) | null = null;
      function NavProbe(): null {
        navigate = useNavigate();
        return null;
      }

      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const queryClient = createClient();
      seedChat(queryClient, withDescription);

      // First mount carries doc-preview params → `hasDocPreview` is true, so the
      // auto-open is suppressed and (crucially) the chat is NOT marked applied.
      await act(async () => {
        root.render(
          <MemoryRouter
            initialEntries={["/?docChat=chat-1&docMsg=msg-1&docAttachment=00000000-0000-4000-8000-000000000001"]}
          >
            <QueryClientProvider client={queryClient}>
              <ToastProvider>
                <NavProbe />
                <ChatView agentId="agent-1" chatId="chat-1" />
              </ToastProvider>
            </QueryClientProvider>
          </MemoryRouter>,
        );
      });
      await flush();
      await waitForText(container, "Launch planning");
      await flush();
      // Preview owns the rail → DescriptionSection / chat-details aside hidden.
      expect(sidebarOpen(container)).toBe(false);

      // Close the preview by clearing the doc params on the live router. This
      // flips `hasDocPreview` to false and re-runs the auto-open effect WITHOUT
      // remounting ChatView.
      if (!navigate) throw new Error("NavProbe did not capture navigate");
      await act(async () => {
        navigate?.("/");
      });
      await waitForCondition(
        () => sidebarOpen(container),
        "Expected the described chat's rail to auto-open after the doc-preview closed (regression: mark-before-docPreview-guard)",
      );
      const aside = container.querySelector('aside[aria-label="Chat details"]');
      expect(aside?.textContent).toContain("Description");
      expect([...(aside?.querySelectorAll("strong") ?? [])].some((el) => el.textContent === "DescBody")).toBe(true);

      await act(async () => root.unmount());
    });
  });
});
