import type { Attention } from "@first-tree/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const assertAgentManageableByUserMock = vi.fn();
const assertClientOwnerMock = vi.fn();
const broadcastToAdminsMock = vi.fn();
const claimClientMock = vi.fn();
const createAgentMappingMock = vi.fn();
const deriveAuthStateMock = vi.fn();
const disconnectClientMock = vi.fn();
const extractLastUpdateAttemptMock = vi.fn();
const forceDisconnectClientMock = vi.fn();
const getAttentionMock = vi.fn();
const getClientMock = vi.fn();
const getMeDocPreviewMock = vi.fn();
const listAttentionsMock = vi.fn();
const requireChatAccessMock = vi.fn();
const requireOrgMembershipMock = vi.fn();
const respondAttentionMock = vi.fn();
const retireClientMock = vi.fn();
const updateClientCapabilitiesMock = vi.fn();

type RouteHandler = (request: Record<string, unknown>, reply: FastifyReply) => unknown;
type Route = {
  method: "DELETE" | "GET" | "PATCH" | "POST";
  path: string;
  handler: RouteHandler;
};

const readyCapability = {
  state: "ok",
  available: true,
  authenticated: true,
  authMethod: "none",
  detectedAt: "2026-05-28T00:00:00.000Z",
};

function setupMocks(): void {
  vi.doMock("../scope/require-user.js", () => ({ requireUser: () => ({ userId: "user-1" }) }));
  vi.doMock("../scope/require-org.js", () => ({
    requireOrgMembership: requireOrgMembershipMock,
  }));
  vi.doMock("../scope/require-resource.js", () => ({
    assertAgentManageableByUser: assertAgentManageableByUserMock,
    requireChatAccess: requireChatAccessMock,
  }));
  vi.doMock("../services/admin-broadcast.js", () => ({ broadcastToAdmins: broadcastToAdminsMock }));
  vi.doMock("../services/adapter-mapping.js", () => ({ createAgentMapping: createAgentMappingMock }));
  vi.doMock("../services/attention.js", () => ({
    getAttention: getAttentionMock,
    listAttentions: listAttentionsMock,
    respondAttention: respondAttentionMock,
  }));
  vi.doMock("../services/auth.js", () => ({ expiryToSeconds: () => 86_400 }));
  vi.doMock("../services/client.js", () => ({
    assertClientOwner: assertClientOwnerMock,
    claimClient: claimClientMock,
    deriveAuthState: deriveAuthStateMock,
    disconnectClient: disconnectClientMock,
    extractLastUpdateAttempt: extractLastUpdateAttemptMock,
    getClient: getClientMock,
    retireClient: retireClientMock,
    updateClientCapabilities: updateClientCapabilitiesMock,
  }));
  vi.doMock("../services/connection-manager.js", () => ({ forceDisconnectClient: forceDisconnectClientMock }));
  vi.doMock("../services/me-doc.js", () => ({ getMeDocPreview: getMeDocPreviewMock }));
}

function createReply(): FastifyReply {
  const reply = {
    send: vi.fn((body?: unknown) => body),
    status: vi.fn(() => reply),
  };
  // Minimal FastifyReply double for direct route-handler unit tests.
  return reply as unknown as FastifyReply;
}

function createDb(results: unknown[], terminalWhereCalls: number[] = []): { select: () => unknown } {
  let whereCalls = 0;
  const next = (): unknown => results.shift() ?? [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    limit: () => next(),
    orderBy: () => next(),
    where: () => {
      whereCalls += 1;
      return terminalWhereCalls.includes(whereCalls) ? next() : chain;
    },
  };
  return { select: () => chain };
}

function createApp(
  dbResults: unknown[] = [],
  terminalWhereCalls: number[] = [],
): { app: FastifyInstance; routes: Route[] } {
  const routes: Route[] = [];
  const register = (method: Route["method"]) => (path: string, optsOrHandler: unknown, maybeHandler?: unknown) => {
    const handler = typeof optsOrHandler === "function" ? optsOrHandler : maybeHandler;
    if (typeof handler !== "function") throw new Error(`missing ${method} ${path} handler`);
    routes.push({ method, path, handler: handler as RouteHandler });
  };
  const app = {
    config: { auth: { refreshTokenExpiry: "7d" } },
    db: createDb(dbResults, terminalWhereCalls),
    delete: register("DELETE"),
    get: register("GET"),
    log: { info: vi.fn() },
    notifier: { notifyChatMessage: vi.fn(async () => {}) },
    patch: register("PATCH"),
    post: register("POST"),
  };
  // Test double implements the FastifyInstance surface these route modules use.
  return { app: app as unknown as FastifyInstance, routes };
}

function findRoute(routes: Route[], method: Route["method"], path: string): RouteHandler {
  const route = routes.find((item) => item.method === method && item.path === path);
  if (!route) throw new Error(`route not registered: ${method} ${path}`);
  return route.handler;
}

function attention(overrides: Partial<Attention> = {}): Attention {
  return {
    id: "attention-1",
    originAgentId: "agent-bot",
    originChatId: "chat-1",
    targetHumanId: "human-1",
    subject: "Approve",
    body: "Ship it?",
    requiresResponse: true,
    state: "open",
    response: null,
    respondedBy: null,
    respondedAt: null,
    cancelled: false,
    cancelledReason: null,
    createdAt: "2026-05-28T00:00:00.000Z",
    closedAt: null,
    metadata: {},
    ...overrides,
  };
}

describe("small API route handlers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    assertAgentManageableByUserMock.mockReset();
    assertClientOwnerMock.mockReset();
    broadcastToAdminsMock.mockReset();
    claimClientMock.mockReset();
    createAgentMappingMock.mockReset();
    deriveAuthStateMock.mockReset();
    disconnectClientMock.mockReset();
    extractLastUpdateAttemptMock.mockReset();
    forceDisconnectClientMock.mockReset();
    getAttentionMock.mockReset();
    getClientMock.mockReset();
    getMeDocPreviewMock.mockReset();
    listAttentionsMock.mockReset();
    requireChatAccessMock.mockReset();
    requireOrgMembershipMock.mockReset();
    respondAttentionMock.mockReset();
    retireClientMock.mockReset();
    updateClientCapabilitiesMock.mockReset();
  });

  it("serves client detail, capabilities, disconnect, retire, and claim handlers", async () => {
    setupMocks();
    deriveAuthStateMock.mockReturnValue("ok");
    extractLastUpdateAttemptMock.mockReturnValue({ status: "ok" });
    forceDisconnectClientMock.mockReturnValue(["agent-1"]);
    getClientMock.mockResolvedValue({
      id: "client-1",
      userId: "user-1",
      status: "connected",
      sdkVersion: "1.2.3",
      hostname: "workstation",
      os: "linux",
      connectedAt: new Date("2026-05-28T00:00:00.000Z"),
      lastSeenAt: new Date("2026-05-28T00:01:00.000Z"),
      metadata: { capabilities: { codex: readyCapability } },
    });
    claimClientMock.mockResolvedValue({
      previousUserId: "user-0",
      supersededChatIds: ["chat-1"],
      unpinnedAgentIds: ["agent-1", "agent-2"],
    });
    const { app, routes } = createApp();
    const { clientRoutes } = await import("../api/clients.js");
    await clientRoutes(app);

    const detail = await findRoute(routes, "GET", "/:clientId")({ params: { clientId: "client-1" } }, createReply());
    expect(detail).toMatchObject({ authState: "ok", capabilities: { codex: readyCapability }, id: "client-1" });
    expect(assertClientOwnerMock).toHaveBeenCalledWith(app.db, "client-1", { userId: "user-1" });

    const patchReply = createReply();
    await findRoute(
      routes,
      "PATCH",
      "/:clientId/capabilities",
    )({ body: { capabilities: { codex: readyCapability } }, params: { clientId: "client-1" } }, patchReply);
    expect(updateClientCapabilitiesMock).toHaveBeenCalledWith(app.db, "client-1", { codex: readyCapability });
    expect(patchReply.status).toHaveBeenCalledWith(204);

    const disconnected = await findRoute(
      routes,
      "POST",
      "/:clientId/disconnect",
    )({ params: { clientId: "client-1" } }, createReply());
    expect(disconnected).toEqual({ agentIds: ["agent-1"], disconnected: true });
    expect(disconnectClientMock).toHaveBeenCalledWith(app.db, "client-1");

    const deleteReply = createReply();
    await findRoute(routes, "DELETE", "/:clientId")({ params: { clientId: "client-1" } }, deleteReply);
    expect(retireClientMock).toHaveBeenCalledWith(app.db, "client-1");
    expect(deleteReply.status).toHaveBeenCalledWith(204);

    const claimReply = createReply();
    await findRoute(routes, "POST", "/:clientId/claim")({ params: { clientId: "client-1" }, log: app.log }, claimReply);
    expect(claimClientMock).toHaveBeenCalledWith(app.db, "client-1", "user-1");
    expect(app.notifier.notifyChatMessage).toHaveBeenCalledWith("chat-1", "");
    expect(claimReply.send).toHaveBeenCalledWith({
      clientId: "client-1",
      previousUserId: "user-0",
      unpinnedAgentCount: 2,
    });
  });

  it("previews me-docs after chat access, speaker membership, and agent-name checks", async () => {
    setupMocks();
    getMeDocPreviewMock.mockResolvedValue({
      ref: { type: "workspace", chatId: "chat-1", agentId: "agent-1", basePath: "notes", path: "README.md" },
      path: "notes/README.md",
      content: "# Notes",
    });
    const { app, routes } = createApp([[{ agentId: "agent-1" }], [{ name: "atlas" }]]);
    const { meDocsRoutes } = await import("../api/me-docs.js");
    await meDocsRoutes(app, { workspacesRoot: "/tmp/workspaces" });

    const result = await findRoute(
      routes,
      "GET",
      "/chats/:chatId/docs/preview",
    )(
      {
        params: { chatId: "chat-1" },
        query: { agentId: "agent-1", basePath: "notes", path: "README.md" },
      },
      createReply(),
    );

    expect(requireChatAccessMock).toHaveBeenCalled();
    expect(getMeDocPreviewMock).toHaveBeenCalledWith({
      agentId: "agent-1",
      agentName: "atlas",
      basePath: "notes",
      chatId: "chat-1",
      path: "README.md",
      workspacesRoot: "/tmp/workspaces",
    });
    expect(result).toMatchObject({ content: "# Notes", path: "notes/README.md" });
  });

  it("lists and creates adapter mappings with org and human-agent guards", async () => {
    setupMocks();
    requireOrgMembershipMock.mockResolvedValue({
      memberId: "member-1",
      organizationId: "org-1",
      role: "member",
      userId: "user-1",
    });
    createAgentMappingMock.mockResolvedValue({
      id: 7,
      platform: "slack",
      externalUserId: "U123",
      agentId: "human-1",
      boundVia: "manual",
      displayName: "Ada",
      createdAt: new Date("2026-05-28T00:00:00.000Z"),
    });
    const { app, routes } = createApp([
      [
        {
          id: 1,
          platform: "slack",
          externalUserId: "U1",
          agentId: "human-1",
          boundVia: "manual",
          displayName: "Ada",
          createdAt: new Date("2026-05-28T00:00:00.000Z"),
        },
      ],
      [{ id: "human-1", type: "human", status: "active", organizationId: "org-1" }],
    ]);
    const { orgAdapterMappingRoutes } = await import("../api/orgs/adapter-mappings.js");
    await orgAdapterMappingRoutes(app);

    const listed = await findRoute(routes, "GET", "/")({ params: { orgId: "org-1" } }, createReply());
    expect(listed).toEqual([expect.objectContaining({ agentId: "human-1", createdAt: "2026-05-28T00:00:00.000Z" })]);

    const reply = createReply();
    await findRoute(
      routes,
      "POST",
      "/",
    )(
      {
        body: {
          platform: "slack",
          externalUserId: "U123",
          agentId: "human-1",
          boundVia: "manual",
          displayName: "Ada",
        },
        params: { orgId: "org-1" },
      },
      reply,
    );
    expect(assertAgentManageableByUserMock).toHaveBeenCalledWith(app.db, "user-1", "human-1");
    expect(createAgentMappingMock).toHaveBeenCalledWith(app.db, {
      agentId: "human-1",
      boundVia: "manual",
      displayName: "Ada",
      externalUserId: "U123",
      platform: "slack",
    });
    expect(reply.status).toHaveBeenCalledWith(201);
  });

  it("lists, reads, responds to, and emits user attention updates", async () => {
    setupMocks();
    const first = attention({ id: "attention-1", createdAt: "2026-05-28T00:00:00.000Z" });
    const second = attention({ id: "attention-2", createdAt: "2026-05-28T00:01:00.000Z" });
    getAttentionMock.mockResolvedValue(first);
    listAttentionsMock.mockResolvedValueOnce([first]).mockResolvedValueOnce([second, first]);
    respondAttentionMock.mockResolvedValue({ ...first, state: "responded", response: "yes" });
    const { app, routes } = createApp(
      [
        [{ agentId: "human-1" }, { agentId: "human-2" }],
        [{ agentId: "human-1" }],
        [{ agentId: "human-1" }],
        [{ organizationId: "org-1" }],
        [{ organizationId: "org-1" }],
      ],
      [1, 2, 3],
    );
    const attentionApi = await import("../api/attention.js");
    await attentionApi.attentionRoutes(app);

    const listed = await findRoute(routes, "GET", "/")({ query: { limit: "5", state: "all" } }, createReply());
    expect(listed).toEqual([second, first]);
    expect(listAttentionsMock).toHaveBeenCalledTimes(2);

    const read = await findRoute(routes, "GET", "/:id")({ params: { id: "attention-1" } }, createReply());
    expect(read).toEqual(first);

    const reply = createReply();
    await findRoute(routes, "POST", "/:id/respond")({ body: { text: "yes" }, params: { id: "attention-1" } }, reply);
    expect(respondAttentionMock).toHaveBeenCalledWith(app.db, "human-1", "attention-1", { text: "yes" });
    expect(reply.status).toHaveBeenCalledWith(200);

    await attentionApi.emitAttentionOpened(app, first);
    await attentionApi.emitAttentionCancelled(app, first);
    expect(broadcastToAdminsMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "attention:opened", organizationId: "org-1" }),
    );
    expect(broadcastToAdminsMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "attention:cancelled", organizationId: "org-1" }),
    );
  });
});
