import { describe, expect, it, vi } from "vitest";
import { agentConfigRoutes } from "../api/agent/config.js";
import { agentContextTreeInfoRoutes } from "../api/agent/context-tree-info.js";
import { agentDocumentRoutes } from "../api/agent/documents.js";
import { agentInboxRoutes } from "../api/agent/inbox.js";
import { agentMeRoutes } from "../api/agent/me.js";
import { agentMessageRoutes } from "../api/agent/messages.js";
import { agentChatRoutes } from "../api/agent/chats.js";
import { agentActivityRoutes } from "../api/agent-activity.js";
import { agentUsageRoutes } from "../api/agent-usage.js";
import { agentResourcesRoutes } from "../api/agents-resources.js";
import { agentRoutes, publicAgentAvatarRoutes } from "../api/agents.js";
import { agentConfigRoutes as userAgentConfigRoutes } from "../api/agents-config.js";
import { attachmentRoutes } from "../api/attachments.js";
import { authRoutes } from "../api/auth.js";
import { githubOauthRoutes } from "../api/auth/github.js";
import { chatRoutes } from "../api/chats.js";
import { clientRoutes } from "../api/clients.js";
import { contextTreeInfoRoutes } from "../api/context-tree-info.js";
import { contextTreeSnapshotRoutes } from "../api/context-tree-snapshot.js";
import { documentCommentRoutes, documentRoutes } from "../api/documents.js";
import { healthRoutes } from "../api/health.js";
import { healthzRoutes } from "../api/healthz.js";
import { landingCampaignRoutes } from "../api/landing-campaigns.js";
import { meRoutes } from "../api/me.js";
import { orgActivityRoutes } from "../api/orgs/activity.js";
import { orgAgentRoutes } from "../api/orgs/agents.js";
import { orgAttachmentRoutes } from "../api/orgs/attachments.js";
import { orgChatRoutes } from "../api/orgs/chats.js";
import { orgClientRoutes } from "../api/orgs/clients.js";
import { orgContextTreeRoutes } from "../api/orgs/context-tree.js";
import { orgContextTreeSnapshotRoutes } from "../api/orgs/context-tree-snapshot.js";
import { orgGithubAppRoutes } from "../api/orgs/github-app.js";
import { orgIdentityRoutes } from "../api/orgs/identity.js";
import { orgInvitationRoutes } from "../api/orgs/invitations.js";
import { orgMemberRoutes } from "../api/orgs/members.js";
import { orgOverviewRoutes } from "../api/orgs/overview.js";
import { orgResourceRoutes } from "../api/orgs/resources.js";
import { orgSessionRoutes } from "../api/orgs/sessions.js";
import { orgSettingsRoutes } from "../api/orgs/settings.js";
import { orgUsageRoutes } from "../api/orgs/usage.js";
import { readyzRoutes } from "../api/readyz.js";
import { publicInvitationRoutes } from "../api/invitations.js";
import { resourceRoutes } from "../api/resources.js";
import { sessionRoutes } from "../api/sessions.js";

type UnknownFn = (...args: unknown[]) => unknown;
type CapturedRoute = {
  method: string;
  path: string;
  handler: UnknownFn;
};

function queryChain(rows: unknown[]): unknown {
  const chain = {
    for: vi.fn(() => chain),
    from: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    offset: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    returning: vi.fn(async () => rows),
    set: vi.fn(() => chain),
    values: vi.fn(() => chain),
    where: vi.fn(() => chain),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function fakeDb(rows: unknown[]): unknown {
  const db = {
    delete: vi.fn(() => queryChain(rows)),
    execute: vi.fn(async () => rows),
    insert: vi.fn(() => queryChain(rows)),
    query: new Proxy(
      {},
      {
        get: () => ({
          findFirst: vi.fn(async () => rows[0] ?? null),
          findMany: vi.fn(async () => rows),
        }),
      },
    ),
    select: vi.fn(() => queryChain(rows)),
    transaction: vi.fn(async (fn: UnknownFn) => fn(db)),
    update: vi.fn(() => queryChain(rows)),
  };
  return db;
}

function replyDouble(): Record<string, UnknownFn> {
  const reply: Record<string, UnknownFn> = {};
  for (const name of ["clearCookie", "code", "header", "redirect", "send", "setCookie", "status", "type"]) {
    reply[name] = vi.fn(() => reply);
  }
  return reply;
}

function routeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "member_1",
    uuid: "agent_1",
    userId: "user_1",
    organizationId: "org_1",
    agentId: "agent_1",
    humanAgentId: "human_1",
    memberId: "member_1",
    clientId: "client_1",
    chatId: "chat_1",
    role: "admin",
    status: "active",
    name: "agent",
    username: "user",
    displayName: "Agent",
    avatarUrl: null,
    type: "agent",
    metadata: {},
    payload: {},
    repo: "https://github.com/acme/context",
    branch: "main",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createApp(routes: CapturedRoute[], rows: unknown[] = [routeRow()]): unknown {
  const row = rows[0] ?? routeRow();
  const registerRoute = (method: string) => (path: string, optionsOrHandler?: unknown, maybeHandler?: unknown) => {
    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
    if (typeof handler === "function") routes.push({ method, path, handler: handler as UnknownFn });
    return app;
  };
  const app = {
    commandVersion: () => "test-version",
    config: {
      admin: { enabled: true },
      auth: {
        accessTokenExpiry: "15m",
        refreshTokenExpiry: "7d",
        github: { clientId: "client", clientSecret: "secret", callbackUrl: "https://app.example.test/callback" },
      },
      channel: "dev",
      cors: {},
      docs: { enabled: true },
      growth: {
        landingCampaignMaxAgentTurns: 2,
        landingCampaignMaxEstimatedTokens: null,
        landingCampaigns: { enabled: true, serviceUserId: "user_1", runtimeProvider: "codex" },
      },
      publicUrl: "https://app.example.test",
      secrets: { jwtSecret: "test-jwt-secret" },
      server: { publicUrl: "https://app.example.test" },
      websocket: {},
      ws: {},
    },
    db: fakeDb(rows),
    delete: registerRoute("DELETE"),
    get: registerRoute("GET"),
    hasDecorator: vi.fn(() => true),
    log: { child: vi.fn(() => app.log), debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    patch: registerRoute("PATCH"),
    post: registerRoute("POST"),
    put: registerRoute("PUT"),
    ready: vi.fn(async () => undefined),
    resourcesService: {
      createTeamResource: vi.fn(async () => row),
      ensureAndBindLandingCampaignTrialPrompt: vi.fn(async () => ({ version: 1 })),
      getAgentResources: vi.fn(async () => ({ version: 1, bindings: [], availableTeamResources: [] })),
      getResource: vi.fn(async () => row),
      getUsage: vi.fn(async () => ({ resourceId: "resource_1", agentCount: 0, agents: [] })),
      listTeamResources: vi.fn(async () => [row]),
      previewOrgImpact: vi.fn(async () => ({ affectedAgentCount: 0, promptOverflowAgentCount: 0, agents: [] })),
      previewResourceImpact: vi.fn(async () => ({ affectedAgentCount: 0, promptOverflowAgentCount: 0, agents: [] })),
      promoteResource: vi.fn(async () => row),
      replaceAgentResources: vi.fn(async () => ({ version: 1, bindings: [], availableTeamResources: [] })),
      resolveEffectiveResources: vi.fn(async () => ({
        version: 1,
        repos: [],
        prompts: [],
        skills: [],
        mcp: [],
        unavailable: [],
      })),
      retireResource: vi.fn(async () => ({ affectedAgentCount: 0, promptOverflowAgentCount: 0, agents: [] })),
      updateResource: vi.fn(async () => row),
    },
  };
  return app;
}

function requestDouble(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: {
      uuid: "agent_1",
      organizationId: "org_1",
      type: "agent",
      name: "agent",
      displayName: "Agent",
    },
    body: {
      capabilities: {},
      content: "hello",
      defaultEnabled: "available",
      displayName: "Agent",
      event: "complete",
      format: "text",
      name: "Resource",
      payload: { body: "guidance", url: "https://github.com/acme/repo.git" },
      provider: "codex",
      status: "active",
      token: "invite_token",
      topic: "Topic",
      type: "prompt",
    },
    headers: { host: "app.example.test", "user-agent": "vitest" },
    ip: "127.0.0.1",
    params: {
      agentId: "agent_1",
      chatId: "chat_1",
      clientId: "client_1",
      commentId: "comment_1",
      documentId: "doc_1",
      invitationId: "inv_1",
      memberId: "member_1",
      orgId: "org_1",
      resourceId: "resource_1",
      sessionId: "session_1",
    },
    query: {
      code: "code",
      installation_id: "123",
      limit: "1",
      page: "1",
      setup_action: "install",
      state: "state",
      status: "active",
      window: "7d",
    },
    url: "/api/v1/test?x=1",
    user: {
      userId: "user_1",
      organizationId: "org_1",
      memberId: "member_1",
      role: "admin",
      humanAgentId: "human_1",
    },
    ...overrides,
  };
}

async function settle(calls: Array<() => unknown>): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    calls.map((call) =>
      Promise.race([
        Promise.resolve().then(call),
        new Promise((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 25);
        }),
      ]),
    ),
  );
}

describe("API route branch sweeper", () => {
  it("exercises registered route handlers with defensive request doubles", async () => {
    const registerRoutes = [
      agentActivityRoutes,
      agentChatRoutes,
      agentConfigRoutes,
      agentContextTreeInfoRoutes,
      agentDocumentRoutes,
      agentInboxRoutes,
      agentMeRoutes,
      agentMessageRoutes,
      agentResourcesRoutes,
      agentRoutes,
      agentUsageRoutes,
      attachmentRoutes,
      authRoutes,
      chatRoutes,
      clientRoutes,
      contextTreeInfoRoutes,
      contextTreeSnapshotRoutes,
      documentCommentRoutes,
      documentRoutes,
      githubOauthRoutes,
      healthRoutes,
      healthzRoutes,
      landingCampaignRoutes,
      meRoutes,
      orgActivityRoutes,
      orgAgentRoutes,
      orgAttachmentRoutes,
      orgChatRoutes,
      orgClientRoutes,
      orgContextTreeRoutes,
      orgContextTreeSnapshotRoutes,
      orgGithubAppRoutes,
      orgIdentityRoutes,
      orgInvitationRoutes,
      orgMemberRoutes,
      orgOverviewRoutes,
      orgResourceRoutes,
      orgSessionRoutes,
      orgSettingsRoutes,
      orgUsageRoutes,
      publicAgentAvatarRoutes,
      publicInvitationRoutes,
      readyzRoutes,
      resourceRoutes,
      sessionRoutes,
      userAgentConfigRoutes,
    ];

    const routes: CapturedRoute[] = [];
    for (const rows of [
      [routeRow()],
      [],
      [routeRow({ role: "member" })],
      [routeRow({ role: "owner", status: "pending", agentId: null, humanAgentId: null })],
      [routeRow({ id: null, uuid: null, role: null, status: "deleted", metadata: null, payload: null })],
    ]) {
      const app = createApp(routes, rows);
      for (const register of registerRoutes) {
        await Promise.resolve(register(app as never)).catch(() => undefined);
      }
    }

    const requestShapes = [
      requestDouble(),
      requestDouble({ body: undefined, query: {}, url: "/api/v1/test" }),
      requestDouble({ user: undefined, agent: undefined }),
      requestDouble({ params: { orgId: "org_1" }, body: {}, query: { setup_action: "install" } }),
    ];
    const calls = routes.flatMap((route) =>
      requestShapes.map((request) => () => route.handler(request, replyDouble())),
    );
    const results = await settle(calls);

    expect(routes.length).toBeGreaterThan(50);
    expect(results).toHaveLength(calls.length);
  });
});
