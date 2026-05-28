import type { FastifyInstance, FastifyReply } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RouteHandler = (request: Record<string, unknown>, reply: FastifyReply) => unknown;
type Route = {
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  path: string;
  handler: RouteHandler;
};

const assertAllAgentsVisibleInOrgMock = vi.fn();
const createChatMock = vi.fn();
const deleteAgentMock = vi.fn();
const fetchUserAvatarForHumanAgentMock = vi.fn();
const forceDisconnectAgentMock = vi.fn();
const getAgentMock = vi.fn();
const getAgentAvatarImageMock = vi.fn();
const getAgentClientIdMock = vi.fn();
const getChatAgentStatusesMock = vi.fn();
const getClientMock = vi.fn();
const getCallerEngagementMock = vi.fn();
const getPresenceMock = vi.fn();
const hasActiveConnectionMock = vi.fn();
const leaveChatMock = vi.fn();
const leaveMeChatMock = vi.fn();
const markMeChatUnreadMock = vi.fn();
const mintContextTreeInstallationTokenMock = vi.fn();
const notifyRecipientsMock = vi.fn();
const prepareImageOutboundMock = vi.fn();
const reactivateAgentMock = vi.fn();
const rebindAgentMock = vi.fn();
const requireAgentAccessMock = vi.fn();
const requireChatAccessMock = vi.fn();
const resolveChatGithubEntityMock = vi.fn();
const sendMessageMock = vi.fn();
const sendToClientMock = vi.fn();
const setAgentAvatarImageMock = vi.fn();
const setOfflineMock = vi.fn();
const suspendAgentMock = vi.fn();
const updateAgentMock = vi.fn();
const mockedModules = [
  "../scope/require-resource.js",
  "../services/agent.js",
  "../services/agent-chat-status.js",
  "../services/chat.js",
  "../services/client.js",
  "../services/connection-manager.js",
  "../services/github-app-installations.js",
  "../services/github-app-token.js",
  "../services/github-entity-live.js",
  "../services/image-broadcast.js",
  "../services/me-chat.js",
  "../services/message.js",
  "../services/notifier.js",
  "../services/presence.js",
  "../services/session.js",
] as const;

function setupMocks(): void {
  vi.doMock("../scope/require-resource.js", () => ({
    assertAllAgentsVisibleInOrg: assertAllAgentsVisibleInOrgMock,
    requireAgentAccess: requireAgentAccessMock,
    requireChatAccess: requireChatAccessMock,
  }));
  vi.doMock("../services/agent.js", () => ({
    MAX_AVATAR_IMAGE_BYTES: 256,
    SUPPORTED_AVATAR_IMAGE_MIMES: ["image/png", "image/webp"],
    agentAvatarImageUrl: (uuid: string, updatedAt: Date | null) =>
      updatedAt ? `/api/v1/public/agents/${uuid}/avatar?v=${updatedAt.getTime()}` : null,
    clearAgentAvatarImage: vi.fn(async () => {}),
    deleteAgent: deleteAgentMock,
    fetchUserAvatarForHumanAgent: fetchUserAvatarForHumanAgentMock,
    getAgent: getAgentMock,
    getAgentAvatarImage: getAgentAvatarImageMock,
    getAgentSkills: vi.fn(async () => [{ name: "review", description: "Review code" }]),
    legacyWireAgentType: (type: string) => (type === "agent" ? "personal_assistant" : type),
    reactivateAgent: reactivateAgentMock,
    rebindAgent: rebindAgentMock,
    resolveAvatarImageUrl: ({
      uuid,
      avatarImageUpdatedAt,
      userAvatarUrl,
    }: {
      uuid: string;
      avatarImageUpdatedAt?: Date | null;
      userAvatarUrl?: string | null;
    }) =>
      avatarImageUpdatedAt ? `/api/v1/public/agents/${uuid}/avatar?v=${avatarImageUpdatedAt.getTime()}` : userAvatarUrl,
    setAgentAvatarImage: setAgentAvatarImageMock,
    suspendAgent: suspendAgentMock,
    updateAgent: updateAgentMock,
    updateAgentSkills: vi.fn(async () => {}),
  }));
  vi.doMock("../services/agent-chat-status.js", () => ({ getChatAgentStatuses: getChatAgentStatusesMock }));
  vi.doMock("../services/chat.js", () => ({
    createChat: createChatMock,
    ensureParticipant: vi.fn(),
    leaveChat: leaveChatMock,
  }));
  vi.doMock("../services/client.js", () => ({ getClient: getClientMock }));
  vi.doMock("../services/connection-manager.js", () => ({
    forceDisconnect: forceDisconnectAgentMock,
    getAgentClientId: getAgentClientIdMock,
    hasActiveConnection: hasActiveConnectionMock,
    sendToClient: sendToClientMock,
  }));
  vi.doMock("../services/github-app-installations.js", () => ({
    findInstallationByOrg: vi.fn(async () => ({ installationId: 42 })),
  }));
  vi.doMock("../services/github-app-token.js", () => ({
    mintContextTreeInstallationToken: mintContextTreeInstallationTokenMock,
  }));
  vi.doMock("../services/github-entity-live.js", () => ({ resolveChatGithubEntity: resolveChatGithubEntityMock }));
  vi.doMock("../services/image-broadcast.js", () => ({ prepareImageOutbound: prepareImageOutboundMock }));
  vi.doMock("../services/me-chat.js", () => ({
    addMeChatParticipants: vi.fn(async () => {}),
    getCallerEngagement: getCallerEngagementMock,
    joinMeChat: vi.fn(async () => {}),
    leaveMeChat: leaveMeChatMock,
    markMeChatRead: vi.fn(async () => ({ unreadCount: 0, mentionCount: 0 })),
    markMeChatUnread: markMeChatUnreadMock,
    resolveChatTitle: vi.fn((topic: string | null, preview: string | null) => topic ?? preview ?? "Untitled"),
    setChatEngagement: vi.fn(async () => {}),
  }));
  vi.doMock("../services/message.js", () => ({ sendMessage: sendMessageMock }));
  vi.doMock("../services/notifier.js", () => ({ notifyRecipients: notifyRecipientsMock }));
  vi.doMock("../services/presence.js", () => ({
    getPresence: getPresenceMock,
    setOffline: setOfflineMock,
  }));
  vi.doMock("../services/session.js", () => ({ extractSummary: (content: unknown) => String(content) }));
}

function createReply(): FastifyReply {
  const reply = {
    header: vi.fn(() => reply),
    send: vi.fn((body?: unknown) => body),
    status: vi.fn(() => reply),
  };
  return reply as unknown as FastifyReply;
}

function createDb(options: {
  executeResults?: unknown[];
  selectResults?: unknown[];
  terminalOrderByCalls?: number[];
  terminalWhereCalls?: number[];
  updateResults?: unknown[];
}): Record<string, unknown> {
  const selectResults = [...(options.selectResults ?? [])];
  const executeResults = [...(options.executeResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  let orderByCalls = 0;
  let whereCalls = 0;
  const nextSelect = (): unknown => selectResults.shift() ?? [];
  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    limit: () => nextSelect(),
    orderBy: () => {
      orderByCalls += 1;
      return options.terminalOrderByCalls?.includes(orderByCalls) ? nextSelect() : selectChain;
    },
    where: () => {
      whereCalls += 1;
      return options.terminalWhereCalls?.includes(whereCalls) ? nextSelect() : selectChain;
    },
  };
  const updateChain = {
    returning: () => updateResults.shift() ?? [],
    set: () => updateChain,
    where: () => updateChain,
  };
  return {
    execute: () => executeResults.shift() ?? [],
    select: () => selectChain,
    update: () => updateChain,
  };
}

function createApp(db: Record<string, unknown>): { app: FastifyInstance; routes: Route[] } {
  const routes: Route[] = [];
  const register = (method: Route["method"]) => (path: string, optsOrHandler: unknown, maybeHandler?: unknown) => {
    const handler = typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler;
    if (typeof handler !== "function") throw new Error(`missing ${method} ${path} handler`);
    routes.push({ method, path, handler: handler as RouteHandler });
  };
  const app = {
    addContentTypeParser: vi.fn(),
    config: { oauth: { githubApp: { appId: "1" } } },
    db,
    delete: register("DELETE"),
    get: register("GET"),
    log: { warn: vi.fn() },
    notifier: {},
    patch: register("PATCH"),
    post: register("POST"),
    put: register("PUT"),
  };
  return { app: app as unknown as FastifyInstance, routes };
}

function findRoute(routes: Route[], method: Route["method"], path: string): RouteHandler {
  const route = routes.find((item) => item.method === method && item.path === path);
  if (!route) throw new Error(`route not registered: ${method} ${path}`);
  return route.handler;
}

function agent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "agent-bot",
    name: "atlas",
    displayName: "Atlas",
    type: "agent",
    status: "active",
    clientId: null,
    runtimeProvider: "claude-code",
    createdAt: new Date("2026-05-28T00:00:00.000Z"),
    updatedAt: new Date("2026-05-28T00:01:00.000Z"),
    ...overrides,
  };
}

describe("chat and agent route branches", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    for (const mock of [
      assertAllAgentsVisibleInOrgMock,
      createChatMock,
      deleteAgentMock,
      fetchUserAvatarForHumanAgentMock,
      forceDisconnectAgentMock,
      getAgentMock,
      getAgentAvatarImageMock,
      getAgentClientIdMock,
      getChatAgentStatusesMock,
      getClientMock,
      getCallerEngagementMock,
      getPresenceMock,
      hasActiveConnectionMock,
      leaveChatMock,
      leaveMeChatMock,
      markMeChatUnreadMock,
      mintContextTreeInstallationTokenMock,
      notifyRecipientsMock,
      prepareImageOutboundMock,
      reactivateAgentMock,
      rebindAgentMock,
      requireAgentAccessMock,
      requireChatAccessMock,
      resolveChatGithubEntityMock,
      sendMessageMock,
      sendToClientMock,
      setAgentAvatarImageMock,
      setOfflineMock,
      suspendAgentMock,
      updateAgentMock,
    ]) {
      mock.mockReset();
    }
  });

  afterEach(() => {
    for (const modulePath of mockedModules) vi.doUnmock(modulePath);
    vi.resetModules();
  });

  it("serializes chat detail, GitHub entities, pagination, and workspace actions", async () => {
    setupMocks();
    const chat = {
      id: "chat-1",
      organizationId: "org-1",
      topic: "Launch review",
      metadata: {},
      createdAt: new Date("2026-05-28T00:00:00.000Z"),
      updatedAt: new Date("2026-05-28T00:01:00.000Z"),
    };
    const scope = { humanAgentId: "human-1", organizationId: "org-1" };
    requireChatAccessMock.mockResolvedValue({ chat, scope });
    getCallerEngagementMock.mockResolvedValue("active");
    mintContextTreeInstallationTokenMock.mockResolvedValue({ ok: true, token: "ghs_token" });
    resolveChatGithubEntityMock.mockImplementation(async (input: Record<string, unknown>) =>
      input.entityKey === "skip" ? null : { ...input, title: "Live title", state: "open" },
    );
    leaveChatMock.mockResolvedValue([
      { agentId: "human-1", role: "member", joinedAt: new Date("2026-05-28T00:00:00.000Z") },
    ]);
    markMeChatUnreadMock.mockResolvedValue({ unreadCount: 1, mentionCount: 0 });
    leaveMeChatMock.mockResolvedValue({ left: true });
    prepareImageOutboundMock.mockImplementation(async (_db, _notifier, _chatId, body: unknown) => body);
    sendMessageMock.mockResolvedValue({
      message: {
        id: "msg-new",
        chatId: "chat-1",
        senderId: "human-1",
        format: "text",
        content: "Hello @atlas",
        source: "web",
        createdAt: new Date("2026-05-28T00:02:00.000Z"),
      },
      recipients: ["agent-bot"],
    });
    getChatAgentStatusesMock.mockResolvedValue([{ agentId: "agent-bot", main: "working" }]);

    const db = createDb({
      executeResults: [[{ content: "First message" }]],
      selectResults: [
        [
          {
            agentId: "human-1",
            role: "member",
            joinedAt: new Date("2026-05-28T00:00:00.000Z"),
            name: "ada",
            displayName: "Ada",
            type: "human",
            avatarColorToken: "hue-1",
            avatarImageUpdatedAt: new Date("2026-05-28T00:00:00.000Z"),
          },
        ],
        [{ accessMode: "watcher" }],
        [
          {
            entityType: "pull_request",
            entityKey: "repo#1",
            boundVia: "direct",
            boundAt: new Date("2026-05-28T00:02:00.000Z"),
          },
          {
            entityType: "pull_request",
            entityKey: "repo#1",
            boundVia: "older",
            boundAt: new Date("2026-05-28T00:01:00.000Z"),
          },
          {
            entityType: "issue",
            entityKey: "skip",
            boundVia: "fixes_link",
            boundAt: new Date("2026-05-28T00:00:00.000Z"),
          },
        ],
        [
          {
            id: "msg-2",
            chatId: "chat-1",
            senderId: "agent-bot",
            format: "text",
            content: "Second",
            metadata: {},
            inReplyTo: null,
            source: "agent",
            createdAt: new Date("2026-05-28T00:02:00.000Z"),
            deliveryStatus: "acked",
          },
          {
            id: "msg-1",
            chatId: "chat-1",
            senderId: "human-1",
            format: "text",
            content: "First",
            metadata: {},
            inReplyTo: null,
            source: "web",
            createdAt: new Date("2026-05-28T00:01:00.000Z"),
            deliveryStatus: "sent",
          },
        ],
      ],
      terminalOrderByCalls: [1],
      terminalWhereCalls: [1],
      updateResults: [
        [
          {
            id: "chat-1",
            topic: null,
            createdAt: new Date("2026-05-28T00:00:00.000Z"),
            updatedAt: new Date("2026-05-28T00:03:00.000Z"),
          },
        ],
      ],
    });
    const { app, routes } = createApp(db);
    const { chatRoutes } = await import("../api/chats.js");
    await chatRoutes(app);

    const detail = await findRoute(routes, "GET", "/:chatId")({ params: { chatId: "chat-1" } }, createReply());
    expect(detail).toMatchObject({
      id: "chat-1",
      firstMessagePreview: "First message",
      viewerMembershipKind: "watching",
    });

    const statuses = await findRoute(
      routes,
      "GET",
      "/:chatId/agent-status",
    )({ params: { chatId: "chat-1" } }, createReply());
    expect(statuses).toEqual([{ agentId: "agent-bot", main: "working" }]);

    const github = await findRoute(
      routes,
      "GET",
      "/:chatId/github-entities",
    )({ params: { chatId: "chat-1" } }, createReply());
    expect(github).toEqual({ items: [expect.objectContaining({ entityKey: "repo#1", boundVia: "direct" })] });

    const patched = await findRoute(
      routes,
      "PATCH",
      "/:chatId",
    )({ body: { topic: "" }, params: { chatId: "chat-1" } }, createReply());
    expect(patched).toMatchObject({ id: "chat-1", topic: null });

    const messages = await findRoute(
      routes,
      "GET",
      "/:chatId/messages",
    )({ params: { chatId: "chat-1" }, query: { cursor: "2026-05-28T00:03:00.000Z", limit: "1" } }, createReply());
    expect(messages).toMatchObject({
      nextCursor: "2026-05-28T00:02:00.000Z",
      items: [expect.objectContaining({ id: "msg-2" })],
    });

    const leaveReply = createReply();
    await findRoute(routes, "POST", "/:chatId/leave")({ params: { chatId: "chat-1" } }, leaveReply);
    expect(leaveReply.status).toHaveBeenCalledWith(200);

    const sendReply = createReply();
    await findRoute(
      routes,
      "POST",
      "/:chatId/messages",
    )({ body: { content: "Hello @atlas" }, params: { chatId: "chat-1" } }, sendReply);
    expect(sendMessageMock).toHaveBeenCalledWith(
      app.db,
      "chat-1",
      "human-1",
      expect.objectContaining({ content: "Hello @atlas", source: "web" }),
      expect.objectContaining({ enforceGroupMention: true, extractMentionsFromContent: true }),
    );
    expect(notifyRecipientsMock).toHaveBeenCalledWith(app.notifier, ["agent-bot"], "msg-new");
    expect(sendReply.status).toHaveBeenCalledWith(201);

    expect(await findRoute(routes, "POST", "/:chatId/unread")({ params: { chatId: "chat-1" } }, createReply())).toEqual(
      {
        mentionCount: 0,
        unreadCount: 1,
      },
    );
    const participantsReply = createReply();
    await findRoute(
      routes,
      "POST",
      "/:chatId/participants",
    )({ body: { participantIds: ["agent-bot"] }, params: { chatId: "chat-1" } }, participantsReply);
    expect(assertAllAgentsVisibleInOrgMock).toHaveBeenCalledWith(app.db, scope, ["agent-bot"]);
    expect(participantsReply.status).toHaveBeenCalledWith(204);
    const workspaceJoinReply = createReply();
    await findRoute(routes, "POST", "/:chatId/workspace-join")({ params: { chatId: "chat-1" } }, workspaceJoinReply);
    expect(workspaceJoinReply.status).toHaveBeenCalledWith(204);
    expect(
      await findRoute(routes, "POST", "/:chatId/workspace-leave")({ params: { chatId: "chat-1" } }, createReply()),
    ).toEqual({
      left: true,
    });
  });

  it("covers agent lifecycle, connection, avatar, and public avatar route branches", async () => {
    setupMocks();
    fetchUserAvatarForHumanAgentMock.mockResolvedValue("https://avatars.example.test/ada.png");
    requireAgentAccessMock.mockResolvedValue({
      agent: agent({ type: "human", avatarImageUpdatedAt: null }),
      scope: { role: "member", humanAgentId: "human-1", organizationId: "org-1" },
    });
    getAgentMock.mockResolvedValue(agent({ clientId: null }));
    updateAgentMock.mockResolvedValue(agent({ clientId: "client-1" }));
    rebindAgentMock.mockResolvedValue(agent({ clientId: "client-1" }));
    suspendAgentMock.mockResolvedValue(agent({ status: "suspended" }));
    reactivateAgentMock.mockResolvedValue(agent({ status: "active" }));
    forceDisconnectAgentMock.mockReturnValue(true);
    hasActiveConnectionMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
    getAgentClientIdMock.mockReturnValueOnce("client-1").mockReturnValueOnce(null);
    getPresenceMock
      .mockResolvedValueOnce({
        status: "online",
        clientId: "client-1",
        runtimeState: { status: "working" },
        lastSeenAt: new Date(Date.now() - 120_000),
      })
      .mockResolvedValueOnce({
        status: "online",
        clientId: null,
        runtimeState: { status: "idle" },
        lastSeenAt: new Date("2026-05-28T00:00:00.000Z"),
      });
    getClientMock.mockResolvedValue({
      id: "client-1",
      hostname: "workstation",
      os: "linux",
      sdkVersion: "1.2.3",
      connectedAt: new Date("2026-05-28T00:00:00.000Z"),
    });
    createChatMock.mockResolvedValue({
      id: "chat-1",
      type: "group",
      createdAt: new Date("2026-05-28T00:00:00.000Z"),
      updatedAt: new Date("2026-05-28T00:01:00.000Z"),
      participants: [{ agentId: "agent-bot", role: "member", joinedAt: new Date("2026-05-28T00:00:00.000Z") }],
    });
    setAgentAvatarImageMock.mockResolvedValue(new Date("2026-05-28T00:02:00.000Z"));
    getAgentAvatarImageMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: Buffer.from("avatar"),
      mime: "image/png",
      updatedAt: new Date("2026-05-28T00:02:00.000Z"),
    });

    const { app, routes } = createApp(createDb({}));
    const { agentRoutes, publicAgentAvatarRoutes } = await import("../api/agents.js");
    await agentRoutes(app);
    await publicAgentAvatarRoutes(app);

    const read = await findRoute(routes, "GET", "/:uuid")({ params: { uuid: "agent-bot" } }, createReply());
    expect(read).toMatchObject({ avatarImageUrl: "https://avatars.example.test/ada.png", uuid: "agent-bot" });

    await expect(
      findRoute(
        routes,
        "PATCH",
        "/:uuid",
      )({ body: { managerId: "member-2" }, params: { uuid: "agent-bot" } }, createReply()),
    ).rejects.toThrow("Only admins can reassign");

    requireAgentAccessMock.mockResolvedValue({
      agent: agent(),
      scope: { role: "admin", humanAgentId: "human-1", organizationId: "org-1" },
    });
    const patched = await findRoute(
      routes,
      "PATCH",
      "/:uuid",
    )({ body: { clientId: "client-1" }, params: { uuid: "agent-bot" } }, createReply());
    expect(patched).toMatchObject({ clientId: "client-1", uuid: "agent-bot" });
    expect(sendToClientMock).toHaveBeenCalledWith("client-1", expect.objectContaining({ type: "agent:pinned" }));

    const rebound = await findRoute(
      routes,
      "PATCH",
      "/:uuid/rebind",
    )({ body: { clientId: "client-1", runtimeProvider: "claude-code" }, params: { uuid: "agent-bot" } }, createReply());
    expect(rebound).toMatchObject({ clientId: "client-1" });

    const disconnectReply = createReply();
    await findRoute(routes, "POST", "/:uuid/disconnect")({ params: { uuid: "agent-bot" } }, disconnectReply);
    expect(setOfflineMock).toHaveBeenCalledWith(app.db, "agent-bot");
    expect(disconnectReply.send).toHaveBeenCalledWith({ disconnected: true });

    expect(
      await findRoute(routes, "POST", "/:uuid/suspend")({ params: { uuid: "agent-bot" } }, createReply()),
    ).toMatchObject({
      status: "suspended",
    });
    expect(
      await findRoute(routes, "POST", "/:uuid/reactivate")({ params: { uuid: "agent-bot" } }, createReply()),
    ).toMatchObject({
      status: "active",
    });

    const deleteReply = createReply();
    await findRoute(routes, "DELETE", "/:uuid")({ params: { uuid: "agent-bot" } }, deleteReply);
    expect(deleteAgentMock).toHaveBeenCalledWith(app.db, "agent-bot");
    expect(deleteReply.status).toHaveBeenCalledWith(204);

    const avatarReply = createReply();
    await findRoute(
      routes,
      "PUT",
      "/:uuid/avatar",
    )(
      {
        body: Buffer.from("png"),
        headers: { "content-type": "image/png; charset=binary" },
        params: { uuid: "agent-bot" },
      },
      avatarReply,
    );
    expect(setAgentAvatarImageMock).toHaveBeenCalledWith(app.db, "agent-bot", Buffer.from("png"), "image/png");
    expect(avatarReply.status).toHaveBeenCalledWith(200);

    const clearAvatarReply = createReply();
    await findRoute(routes, "DELETE", "/:uuid/avatar")({ params: { uuid: "agent-bot" } }, clearAvatarReply);
    expect(clearAvatarReply.status).toHaveBeenCalledWith(204);

    const staleReply = createReply();
    await findRoute(routes, "POST", "/:uuid/test")({ params: { uuid: "agent-bot" } }, staleReply);
    expect(staleReply.send).toHaveBeenCalledWith(expect.objectContaining({ status: "stale" }));

    const offlineReply = createReply();
    await findRoute(routes, "POST", "/:uuid/test")({ params: { uuid: "agent-bot" } }, offlineReply);
    expect(offlineReply.send).toHaveBeenCalledWith(expect.objectContaining({ status: "stale" }));

    const createChatReply = createReply();
    await findRoute(routes, "POST", "/:uuid/chats")({ params: { uuid: "agent-bot" } }, createChatReply);
    expect(createChatReply.status).toHaveBeenCalledWith(201);
    expect(createChatMock).toHaveBeenCalledWith(app.db, "human-1", { type: "group", participantIds: ["agent-bot"] });

    const missingAvatarReply = createReply();
    await findRoute(routes, "GET", "/:uuid/avatar")({ params: { uuid: "agent-bot" }, query: {} }, missingAvatarReply);
    expect(missingAvatarReply.status).toHaveBeenCalledWith(404);

    const imageReply = createReply();
    await findRoute(routes, "GET", "/:uuid/avatar")({ params: { uuid: "agent-bot" }, query: {} }, imageReply);
    expect(imageReply.header).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(imageReply.send).toHaveBeenCalledWith(Buffer.from("avatar"));
  });
});
