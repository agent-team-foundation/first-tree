import type { FastifyInstance, FastifyReply } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authServiceMock = vi.hoisted(() => ({
  expiryToSeconds: vi.fn(() => 86_400),
  generateConnectToken: vi.fn(),
  pickDefaultMembership: vi.fn(),
}));
const clientServiceMock = vi.hoisted(() => ({
  deriveAuthState: vi.fn(() => "ok"),
  extractCapabilities: vi.fn(() => ({ codex: { state: "ok" } })),
  extractLastUpdateAttempt: vi.fn(() => null),
  listClients: vi.fn(),
  listMyPinnedAgents: vi.fn(),
}));
const cryptoMock = vi.hoisted(() => ({
  decryptValue: vi.fn(),
  encryptValue: vi.fn((value: string) => `encrypted:${value}`),
}));
const githubAppMock = vi.hoisted(() => {
  class GithubAppApiError extends Error {
    status: number;
    constructor(status: number, message = "github app failed") {
      super(message);
      this.status = status;
    }
  }
  return {
    GithubAppApiError,
    refreshAppUserToken: vi.fn(),
  };
});
const githubOauthMock = vi.hoisted(() => {
  class GithubApiError extends Error {
    status: number;
    constructor(status: number, message = "github failed") {
      super(message);
      this.status = status;
    }
  }
  return {
    GithubApiError,
    listUserRepos: vi.fn(),
  };
});
const invitationMock = vi.hoisted(() => ({
  buildInviteUrl: vi.fn((origin: string, token: string) => `${origin}/invite/${token}`),
  findActiveByToken: vi.fn(),
  getActiveInvitation: vi.fn(),
  recordRedemption: vi.fn(),
}));
const membershipMock = vi.hoisted(() => ({
  countActiveMembersByOrgs: vi.fn(),
  ensureMembership: vi.fn(),
  leaveOrganization: vi.fn(),
  listActiveMemberships: vi.fn(),
  selfCreateOrganization: vi.fn(),
}));
const accessControlMock = vi.hoisted(() => ({
  listAgentsManagedByUser: vi.fn(),
}));
const agentServiceMock = vi.hoisted(() => ({
  resolveAvatarImageUrl: vi.fn(() => "https://cdn.example.test/avatar.png"),
}));

const MOCKED_MODULES = [
  "../scope/require-user.js",
  "../services/access-control.js",
  "../services/agent.js",
  "../services/auth.js",
  "../services/client.js",
  "../services/crypto.js",
  "../services/github-app.js",
  "../services/github-oauth.js",
  "../services/invitation.js",
  "../services/membership.js",
  "../utils/public-url.js",
];

function setupRouteMocks(): void {
  vi.doMock("../scope/require-user.js", () => ({ requireUser: () => ({ userId: "user-1" }) }));
  vi.doMock("../services/access-control.js", () => accessControlMock);
  vi.doMock("../services/agent.js", () => agentServiceMock);
  vi.doMock("../services/auth.js", () => authServiceMock);
  vi.doMock("../services/client.js", () => clientServiceMock);
  vi.doMock("../services/crypto.js", () => cryptoMock);
  vi.doMock("../services/github-app.js", () => githubAppMock);
  vi.doMock("../services/github-oauth.js", () => githubOauthMock);
  vi.doMock("../services/invitation.js", () => invitationMock);
  vi.doMock("../services/membership.js", () => membershipMock);
  vi.doMock("../utils/public-url.js", () => ({ resolvePublicUrl: () => "https://hub.example.test" }));
}

type RouteHandler = (request: Record<string, unknown>, reply: FastifyReply) => unknown;
type Route = {
  method: "GET" | "PATCH" | "POST";
  path: string;
  handler: RouteHandler;
  options?: unknown;
};
type DbDouble = {
  select: () => {
    from: () => {
      innerJoin: () => unknown;
      where: () => unknown;
      limit: () => unknown;
    };
  };
  update: () => {
    set: (values: unknown) => {
      where: () => unknown;
    };
  };
};

function createReply(): FastifyReply {
  const reply = {
    send: vi.fn((body?: unknown) => body),
    status: vi.fn(() => reply),
  };
  return reply as unknown as FastifyReply;
}

function createDb(selectResults: unknown[] = []): DbDouble & { updates: unknown[] } {
  const updates: unknown[] = [];
  const nextSelect = (): unknown => selectResults.shift() ?? [];
  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    limit: () => nextSelect(),
  };
  return {
    updates,
    select: () => selectChain,
    update: () => ({
      set: (values: unknown) => {
        updates.push(values);
        return { where: async () => [] };
      },
    }),
  };
}

function createApp(db: DbDouble = createDb()): { app: FastifyInstance; routes: Route[] } {
  const routes: Route[] = [];
  const register = (method: Route["method"]) => (path: string, optionsOrHandler: unknown, maybeHandler?: unknown) => {
    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
    if (typeof handler !== "function") throw new Error(`missing ${method} ${path} handler`);
    routes.push({
      method,
      path,
      handler: handler as RouteHandler,
      options: typeof optionsOrHandler === "function" ? undefined : optionsOrHandler,
    });
  };
  const app = {
    config: {
      auth: { refreshTokenExpiry: "7d" },
      channel: "dev",
      oauth: { githubApp: { clientId: "github-client", clientSecret: "github-secret" } },
      rateLimit: { loginMax: 7 },
      secrets: { encryptionKey: "encryption-key", jwtSecret: "jwt-secret" },
    },
    db,
    get: register("GET"),
    log: { info: vi.fn(), warn: vi.fn() },
    patch: register("PATCH"),
    post: register("POST"),
  };
  return { app: app as unknown as FastifyInstance, routes };
}

function findRoute(routes: Route[], method: Route["method"], path: string): Route {
  const route = routes.find((item) => item.method === method && item.path === path);
  if (!route) throw new Error(`route not registered: ${method} ${path}`);
  return route;
}

describe("meRoutes unit branches", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    authServiceMock.expiryToSeconds.mockReturnValue(86_400);
    authServiceMock.generateConnectToken.mockResolvedValue({ token: "connect-token", expiresIn: 600 });
    authServiceMock.pickDefaultMembership.mockReturnValue(null);
    clientServiceMock.deriveAuthState.mockReturnValue("ok");
    clientServiceMock.extractCapabilities.mockReturnValue({ codex: { state: "ok" } });
    clientServiceMock.extractLastUpdateAttempt.mockReturnValue(null);
    clientServiceMock.listClients.mockResolvedValue([]);
    clientServiceMock.listMyPinnedAgents.mockResolvedValue([]);
    cryptoMock.decryptValue.mockReset();
    cryptoMock.encryptValue.mockImplementation((value: string) => `encrypted:${value}`);
    githubAppMock.refreshAppUserToken.mockReset();
    githubOauthMock.listUserRepos.mockReset();
    invitationMock.findActiveByToken.mockReset();
    invitationMock.getActiveInvitation.mockReset();
    invitationMock.recordRedemption.mockReset();
    membershipMock.countActiveMembersByOrgs.mockResolvedValue(new Map<string, number>());
    membershipMock.ensureMembership.mockReset();
    membershipMock.leaveOrganization.mockReset();
    membershipMock.listActiveMemberships.mockResolvedValue([]);
    membershipMock.selfCreateOrganization.mockReset();
    accessControlMock.listAgentsManagedByUser.mockResolvedValue([]);
    agentServiceMock.resolveAvatarImageUrl.mockReturnValue("https://cdn.example.test/avatar.png");
  });

  afterEach(() => {
    for (const moduleId of MOCKED_MODULES) vi.doUnmock(moduleId);
    vi.resetModules();
  });

  it("handles unavailable, undecodable, scope-missing, and upstream GitHub repo tokens", async () => {
    setupRouteMocks();
    const db = createDb([
      [],
      [{ metadata: { accessToken: "bad-token" } }],
      [{ metadata: { accessToken: "encrypted-token" } }],
      [{ metadata: { accessToken: "encrypted-token" } }],
    ]);
    const { app, routes } = createApp(db);
    await import("../api/me.js").then((mod) => mod.meRoutes(app));
    const route = findRoute(routes, "GET", "/me/github/repos").handler;

    let reply = createReply();
    await route({}, reply);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      error: "GitHub access token unavailable — please reconnect your account",
    });

    cryptoMock.decryptValue.mockImplementationOnce(() => {
      throw new Error("bad ciphertext");
    });
    reply = createReply();
    await route({}, reply);
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ error: "GitHub access token could not be decoded — please reconnect" });

    cryptoMock.decryptValue.mockReturnValue("plain-token");
    githubOauthMock.listUserRepos.mockRejectedValueOnce(new githubOauthMock.GithubApiError(403));
    reply = createReply();
    await route({}, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      error: "GitHub access token is missing the `repo` scope. Please reconnect your GitHub account.",
      code: "scope_missing",
    });

    githubOauthMock.listUserRepos.mockRejectedValueOnce(new Error("network down"));
    reply = createReply();
    await route({}, reply);
    expect(reply.status).toHaveBeenCalledWith(502);
    expect(reply.send).toHaveBeenCalledWith({
      error: "Couldn't reach GitHub. Try again, or reconnect your GitHub account.",
    });
    expect(app.log.warn).toHaveBeenCalledTimes(2);
  });

  it("refreshes expired GitHub App user tokens and maps refresh failures", async () => {
    setupRouteMocks();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const db = createDb([
      [
        {
          metadata: {
            accessToken: "encrypted-access",
            accessTokenExpiresAt: expired,
            refreshToken: "encrypted-refresh",
          },
        },
      ],
      [
        {
          metadata: {
            accessToken: "encrypted-access",
            accessTokenExpiresAt: expired,
            refreshToken: "encrypted-refresh",
          },
        },
      ],
    ]);
    const { app, routes } = createApp(db);
    await import("../api/me.js").then((mod) => mod.meRoutes(app));
    const route = findRoute(routes, "GET", "/me/github/repos").handler;

    cryptoMock.decryptValue.mockReturnValueOnce("expired-token").mockReturnValueOnce("refresh-token");
    githubAppMock.refreshAppUserToken.mockResolvedValueOnce({
      accessToken: "fresh-token",
      accessTokenExpiresAt: "2026-05-28T08:00:00.000Z",
      refreshToken: "fresh-refresh",
      refreshTokenExpiresAt: "2026-06-28T00:00:00.000Z",
    });
    githubOauthMock.listUserRepos.mockResolvedValueOnce([{ fullName: "agent-team-foundation/first-tree" }]);

    const success = await route({}, createReply());
    expect(success).toEqual({ repos: [{ fullName: "agent-team-foundation/first-tree" }] });
    expect(githubAppMock.refreshAppUserToken).toHaveBeenCalledWith("github-client", "github-secret", "refresh-token");
    expect(db.updates[0]).toMatchObject({
      metadata: {
        accessToken: "encrypted:fresh-token",
        refreshToken: "encrypted:fresh-refresh",
      },
    });

    cryptoMock.decryptValue.mockReturnValueOnce("expired-token").mockReturnValueOnce("refresh-token");
    githubAppMock.refreshAppUserToken.mockRejectedValueOnce(new githubAppMock.GithubAppApiError(401));
    const reply = createReply();
    await route({}, reply);
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      error: "Your GitHub session has expired. Please sign in again.",
      code: "refresh_failed",
    });
  });

  it("serves connect tokens, managed agents, clients, org joins, and leave checks", async () => {
    setupRouteMocks();
    const db = createDb([
      [{ username: "ada", displayName: "Ada Lovelace" }],
      [{ username: "ada", displayName: "Ada Lovelace" }],
      [{ id: "member-1", userId: "user-1" }],
      [{ id: "member-2", userId: "user-2" }],
    ]);
    const { app, routes } = createApp(db);
    await import("../api/me.js").then((mod) => mod.meRoutes(app));

    const connectRoute = findRoute(routes, "POST", "/me/connect-tokens");
    expect(connectRoute.options).toMatchObject({ config: { rateLimit: { max: 7, timeWindow: "1 minute" } } });
    const connect = await connectRoute.handler({}, createReply());
    expect(connect).toMatchObject({
      binName: "first-tree-dev",
      bootstrapCommand: "first-tree-dev login connect-token",
      command: "first-tree-dev login connect-token",
      npmSpec: null,
    });

    accessControlMock.listAgentsManagedByUser.mockResolvedValueOnce([
      {
        uuid: "agent-1",
        name: "atlas",
        displayName: "Atlas",
        type: "agent",
        organizationId: "org-1",
        inboxId: "inbox-1",
        visibility: "organization",
        runtimeProvider: "claude-code",
        clientId: "client-1",
        avatarImageUpdatedAt: new Date("2026-05-28T00:00:00.000Z"),
        userAvatarUrl: null,
      },
    ]);
    const managed = await findRoute(routes, "GET", "/me/managed-agents").handler({}, createReply());
    expect(managed).toEqual([
      expect.objectContaining({ uuid: "agent-1", avatarImageUrl: "https://cdn.example.test/avatar.png" }),
    ]);

    clientServiceMock.listClients.mockResolvedValueOnce([
      {
        id: "client-1",
        userId: "user-1",
        status: "connected",
        sdkVersion: "1.0.0",
        hostname: "workstation",
        os: "linux",
        agentCount: 2,
        connectedAt: null,
        lastSeenAt: new Date("2026-05-28T00:00:00.000Z"),
        metadata: {},
      },
    ]);
    const clients = await findRoute(routes, "GET", "/me/clients").handler({}, createReply());
    expect(clients).toEqual([
      expect.objectContaining({ authState: "ok", connectedAt: null, lastSeenAt: "2026-05-28T00:00:00.000Z" }),
    ]);

    membershipMock.selfCreateOrganization.mockResolvedValueOnce({
      organizationId: "org-1",
      name: "compute",
      displayName: "Compute Team",
    });
    const createReplyResult = createReply();
    await findRoute(routes, "POST", "/me/organizations").handler(
      { body: { name: "compute", displayName: "Compute Team" } },
      createReplyResult,
    );
    expect(createReplyResult.status).toHaveBeenCalledWith(201);

    invitationMock.findActiveByToken.mockResolvedValueOnce({
      id: "invite-1",
      organizationId: "org-1",
      role: "admin",
    });
    membershipMock.ensureMembership.mockResolvedValueOnce({ id: "member-1", organizationId: "org-1", role: "admin" });
    const joinReply = createReply();
    await findRoute(routes, "POST", "/me/organizations/join").handler(
      { body: { token: "invite-token" }, headers: { "user-agent": "vitest" }, ip: "127.0.0.1" },
      joinReply,
    );
    expect(joinReply.send).toHaveBeenCalledWith({ organizationId: "org-1", memberId: "member-1", role: "admin" });
    expect(invitationMock.recordRedemption).toHaveBeenCalledWith(
      app.db,
      expect.objectContaining({ invitationId: "invite-1", userAgent: "vitest" }),
    );

    const leaveReply = createReply();
    await findRoute(routes, "POST", "/me/memberships/:memberId/leave").handler(
      { params: { memberId: "member-1" } },
      leaveReply,
    );
    expect(membershipMock.leaveOrganization).toHaveBeenCalledWith(app.db, "member-1");
    expect(leaveReply.status).toHaveBeenCalledWith(204);

    await expect(
      findRoute(routes, "POST", "/me/memberships/:memberId/leave").handler(
        { params: { memberId: "member-2" } },
        createReply(),
      ),
    ).rejects.toThrow('Membership "member-2" not found');
  });
});
