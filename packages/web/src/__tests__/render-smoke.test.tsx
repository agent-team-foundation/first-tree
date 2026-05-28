import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentDetailPage } from "../pages/agent-detail.js";
import { ClientsPage } from "../pages/clients.js";
import { ChatView } from "../pages/workspace/center/chat-view.js";
import { AgentContext } from "../pages/workspace/context/agent-context.js";
import { ConversationList } from "../pages/workspace/conversations/index.js";
import { NewChatDraft } from "../pages/workspace/conversations/new-chat-draft.js";
import { GitHubSection } from "../pages/workspace/right-sidebar/github-section.js";

const authState = vi.hoisted(() => ({
  value: {
    isAuthenticated: true,
    meLoaded: true,
    user: {
      id: "user-1",
      username: "ada",
      displayName: "Ada Lovelace",
      avatarUrl: null,
    },
    memberships: [],
    currentMembership: null,
    organizationId: "org-1",
    memberId: "member-1",
    role: "admin",
    agentId: "agent-human",
    teamDisplayName: "Compute Team",
    orgHasOtherMembers: true,
    onboardingStep: "completed",
    onboardingDismissedAt: "2026-05-01T00:00:00.000Z",
    onboardingCompletedAt: "2026-05-01T00:00:00.000Z",
    dismissOnboarding: async () => {},
    restoreOnboarding: async () => {},
    markOnboardingCompleted: async () => {},
    login: async () => {},
    adoptTokens: async () => {},
    selectOrganization: async () => {},
    refreshMe: async () => {},
    logout: () => {},
  },
}));

vi.mock("../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authState.value,
}));

vi.mock("../api/chats.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/chats.js")>();
  return {
    ...original,
    getChat: async () => chatDetail,
    listChatMessages: async () => emptyMessages,
    patchChatEngagement: async () => chatDetail,
    readFileAsBase64: async () => "ZmFrZQ==",
    renameChat: async () => chatDetail,
    sendChatMessage: async () => message("msg-new", "agent-human", "Sent"),
    sendFileMessage: async () => message("msg-file", "agent-human", { imageId: "img-1", mimeType: "image/png" }),
  };
});

vi.mock("../api/image-store.js", () => ({
  getImage: async () => null,
  putImage: async () => "img-1",
}));

vi.mock("../api/me-chats.js", () => ({
  createMeChat: async () => ({ chatId: "chat-1" }),
  listMeChats: async () => ({ nextCursor: null, rows: [chatRow("chat-1", "Manual"), chatRow("chat-2", "GitHub")] }),
}));

vi.mock("../api/agent-status.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/agent-status.js")>();
  return {
    ...original,
    fetchChatAgentStatuses: async () => [
      {
        agentId: "agent-bot",
        reachable: true,
        errored: false,
        needsYou: false,
        working: true,
        engagement: "none",
        main: "working",
        activity: {
          agentId: "agent-bot",
          kind: "tool_call",
          label: "Bash",
          startedAt: "2026-05-28T00:00:00.000Z",
        },
      },
    ],
  };
});

vi.mock("../api/attention.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/attention.js")>();
  return {
    ...original,
    listAttentionsInChat: async () => [],
  };
});

vi.mock("../api/sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/sessions.js")>();
  return {
    ...original,
    listAgentSessions: async () => [],
    listSessionEvents: async () => [],
  };
});

vi.mock("../api/message-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/message-store.js")>();
  return {
    ...original,
    cacheMessages: async () => {},
    getCachedMessages: async () => [],
  };
});

vi.mock("../api/read-state-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/read-state-store.js")>();
  return {
    ...original,
    getReadState: async () => null,
    setReadState: async () => {},
  };
});

function agent(uuid: string, displayName: string, name: string | null, type = "autonomous") {
  return {
    uuid,
    name,
    displayName,
    type,
    status: "active",
    visibility: "public",
    managerId: "member-1",
    clientId: "client-1",
    runtimeProvider: "claude-code",
    runtimeState: { status: "idle", updatedAt: "2026-05-28T00:00:00.000Z" },
    avatarImageUrl: null,
    avatarColorToken: "hue-1",
    profile: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

const humanAgent = agent("agent-human", "Ada", "ada", "human");
const botAgent = agent("agent-bot", "Atlas", "atlas");
const agentsPage = { items: [humanAgent, botAgent], nextCursor: null };

const client = {
  id: "client-1",
  userId: "user-1",
  status: "connected",
  authState: "ok",
  sdkVersion: "0.0.0-test",
  hostname: "ada-workstation",
  os: "linux",
  agentCount: 1,
  connectedAt: "2026-05-28T00:00:00.000Z",
  lastSeenAt: "2026-05-28T00:00:00.000Z",
  capabilities: {
    providers: {
      "claude-code": { available: true, authenticated: true, version: "1.0.0" },
      codex: { available: false, authenticated: false },
    },
  },
};

const agentConfig = {
  version: 3,
  runtimeProvider: "claude-code",
  payload: {
    runtimeProvider: "claude-code",
    model: "claude-sonnet-4-5",
    systemPrompt: { type: "preset", preset: "claude_code", append: "Be concise." },
    mcpServers: [],
    env: [],
    gitRepos: [],
  },
};

const chatParticipant = {
  agentId: "agent-bot",
  role: "member",
  mode: "speaker",
  joinedAt: "2026-05-28T00:00:00.000Z",
  name: "atlas",
  displayName: "Atlas",
  type: "autonomous",
  avatarColorToken: "hue-2",
  avatarImageUrl: null,
};

const chatDetail = {
  id: "chat-1",
  organizationId: "org-1",
  type: "group",
  topic: "Launch review",
  lifecyclePolicy: null,
  metadata: {},
  createdAt: "2026-05-28T00:00:00.000Z",
  updatedAt: "2026-05-28T00:00:00.000Z",
  participants: [
    { ...chatParticipant, agentId: "agent-human", name: "ada", displayName: "Ada", type: "human" },
    chatParticipant,
  ],
  title: "Launch review",
  firstMessagePreview: "Ready for review",
  engagementStatus: "active",
  viewerMembershipKind: "participant",
};

const githubEntityPage = {
  items: [
    {
      entityType: "pull_request",
      entityKey: "agent-team-foundation/first-tree#42",
      boundVia: "direct",
      htmlUrl: "https://github.com/agent-team-foundation/first-tree/pull/42",
      title: "Raise test coverage",
      state: "merged",
      number: 42,
    },
    {
      entityType: "issue",
      entityKey: "agent-team-foundation/first-tree#43",
      boundVia: "fixes_link",
      htmlUrl: "https://github.com/agent-team-foundation/first-tree/issues/43",
      title: "Track coverage gap",
      state: "closed",
      number: 43,
    },
    {
      entityType: "discussion",
      entityKey: "agent-team-foundation/first-tree#44",
      boundVia: "agent_created",
      htmlUrl: "https://github.com/agent-team-foundation/first-tree/discussions/44",
      title: "Coverage strategy",
      state: "draft",
      number: 44,
    },
    {
      entityType: "commit",
      entityKey: "agent-team-foundation/first-tree@abc123",
      boundVia: "direct",
      htmlUrl: "https://github.com/agent-team-foundation/first-tree/commit/abc123",
      title: null,
      state: null,
      number: null,
    },
  ],
};

function message(id: string, senderId: string, content: unknown) {
  return {
    id,
    chatId: "chat-1",
    senderId,
    content,
    contentType: typeof content === "string" ? "text" : "file",
    createdAt: "2026-05-28T00:00:00.000Z",
    metadata: {},
    deliveryStatus: "sent",
  };
}

const emptyMessages = { items: [message("msg-1", "agent-human", "Hello @atlas")], nextCursor: null };
const chatRows = {
  rows: [chatRow("chat-1", "Launch review"), chatRow("chat-2", "PR triage")],
  nextCursor: null,
};

function chatRow(chatId: string, title: string) {
  return {
    chatId,
    type: "group",
    membershipKind: "participant",
    source: chatId === "chat-2" ? "github" : "manual",
    entityType: chatId === "chat-2" ? "pull_request" : null,
    title,
    topic: title,
    participants: [
      { agentId: "agent-human", displayName: "Ada", type: "human", avatarColorToken: "hue-1", avatarImageUrl: null },
      {
        agentId: "agent-bot",
        displayName: "Atlas",
        type: "autonomous",
        avatarColorToken: "hue-2",
        avatarImageUrl: null,
      },
    ],
    participantCount: 2,
    lastMessageAt: "2026-05-28T00:00:00.000Z",
    lastMessagePreview: "Ready for review",
    unreadMentionCount: chatId === "chat-2" ? 1 : 0,
    canReply: true,
    engagementStatus: "active",
    liveActivity: null,
    pendingQuestionAgentIds: [],
    failedAgentIds: [],
    busyAgentIds: chatId === "chat-1" ? ["agent-bot"] : [],
    chatHasOpenQuestion: false,
    chatHasExplicitMentionToMe: chatId === "chat-2",
  };
}

function createClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
      },
    },
  });
  queryClient.setQueryData(["agents", "org-list"], agentsPage);
  queryClient.setQueryData(["managed-agents", "name-map"], [botAgent]);
  queryClient.setQueryData(["activity"], {
    total: 1,
    running: 1,
    byState: { idle: 0, working: 1, blocked: 0, error: 0 },
    clients: 1,
    agents: [
      {
        agentId: "agent-bot",
        clientId: "client-1",
        runtimeType: "claude-code",
        runtimeState: "working",
        activeSessions: 1,
        totalSessions: 3,
        runtimeUpdatedAt: "2026-05-28T00:00:00.000Z",
        type: "agent",
        managedByMe: true,
      },
    ],
  });
  queryClient.setQueryData(["clients", "org"], [client]);
  queryClient.setQueryData(["clients", "me"], [client]);
  queryClient.setQueryData(
    ["members"],
    [{ id: "member-1", userId: "user-1", displayName: "Ada Lovelace", role: "admin", status: "active" }],
  );
  queryClient.setQueryData(["agent", "agent-bot"], botAgent);
  queryClient.setQueryData(["agent-config", "agent-bot"], agentConfig);
  queryClient.setQueryData(["agent-client-status", "agent-bot"], {
    clientId: "client-1",
    hostname: "ada-workstation",
    status: "connected",
    authState: "ok",
    offlineSince: null,
  });
  queryClient.setQueryData(["agent-sessions-active", "agent-bot"], []);
  queryClient.setQueryData(["clients"], [client]);
  queryClient.setQueryData(["me", "chats", "all", "active", false, null, null], chatRows);
  queryClient.setQueryData(["me", "chats", "all", "active", false, null, null, null], chatRows);
  queryClient.setQueryData(["me", "chats", "all", "active", false, undefined, undefined, undefined], chatRows);
  queryClient.setQueryData(["me", "chats", "all", "active", false, "", "", ""], chatRows);
  queryClient.setQueryData(["chat-messages-cache", "chat-1"], []);
  queryClient.setQueryData(["chat-messages", "chat-1"], emptyMessages);
  queryClient.setQueryData(["session-events", "agent-bot", "chat-1"], []);
  queryClient.setQueryData(["chat-detail", "chat-1"], chatDetail);
  queryClient.setQueryData(["chat-attentions", "chat-1"], []);
  queryClient.setQueryData(["chat-right-sidebar", "github-entities", "chat-1"], githubEntityPage);
  queryClient.setQueryData(["chat-read-state", "chat-1"], null);
  queryClient.setQueryData(["agent-skills", null], { skills: [] });
  queryClient.setQueryData(["agent-skills", "agent-bot"], { skills: [] });
  queryClient.setQueryData(["chat-agent-status", "chat-1"], []);
  return queryClient;
}

function render(ui: ReactElement, route = "/"): string {
  const queryClient = createClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("primary web surfaces render from cached query data", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { search: "" } },
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("renders the computer inventory page", () => {
    const html = render(<ClientsPage />);
    expect(html).toContain("Computers");
    expect(html).toContain("ada-workstation");
  });

  it("renders the agent detail shell", () => {
    const html = render(
      <Routes>
        <Route path="/agents/:uuid/*" element={<AgentDetailPage />}>
          <Route path="profile" element={<div>profile slot</div>} />
        </Route>
      </Routes>,
      "/agents/agent-bot/profile",
    );
    expect(html).toContain("Atlas");
    expect(html).toContain("profile slot");
  });

  it("renders the conversation list and new-chat draft", () => {
    const html = render(
      <div>
        <ConversationList
          selectedChatId="chat-1"
          onSelectChat={() => {}}
          onNewChat={() => {}}
          engagement="active"
          onEngagementChange={() => {}}
          unread={false}
          onUnreadChange={() => {}}
          watching={false}
          onWatchingChange={() => {}}
          origin={[]}
          onOriginChange={() => {}}
          participants={[]}
          onParticipantsChange={() => {}}
          onClearFilters={() => {}}
          group="recency"
          onGroupChange={() => {}}
        />
        <NewChatDraft onCreated={() => {}} />
      </div>,
    );
    expect(html).toContain("New chat");
    expect(html).toContain("What&#x27;s the task?");
  });

  it("renders an open chat timeline", () => {
    const html = render(<ChatView agentId="agent-bot" chatId="chat-1" titleFallback="Launch review" />);
    expect(html).toContain("Launch review");
    expect(html).toContain("Hello @atlas");
  });

  it("renders workspace context and GitHub right rail sections", () => {
    const html = render(
      <div>
        <AgentContext agentId="agent-bot" />
        <GitHubSection chatId="chat-1" />
      </div>,
    );

    expect(html).toContain("Atlas");
    expect(html).toContain("ada-workstation");
    expect(html).toContain("Working");
    expect(html).toContain("agent-team-foundation/first-tree#42");
    expect(html).toContain("Raise test coverage");
    expect(html).toContain("Auto-linked from");
    expect(html).toContain("Created by an agent");
  });
});
