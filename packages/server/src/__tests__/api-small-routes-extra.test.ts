import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RouteHandler = (...args: unknown[]) => unknown;

type RegisteredRoute = {
  method: "GET" | "PATCH" | "POST";
  path: string;
  options?: unknown;
  handler: RouteHandler;
};

type TestReply = {
  code?: number;
  body?: unknown;
  status: (code: number) => TestReply;
  send: (body: unknown) => TestReply;
};

const routeMocks = {
  aggregateByAgent: vi.fn(),
  assertMutableAgentIsNotLandingCampaignTrial: vi.fn(),
  assertNoRuntimeSwitchInProgress: vi.fn(),
  getMeDocPreview: vi.fn(),
  getOrganization: vi.fn(),
  getOrgContextTree: vi.fn(),
  listAgentTurns: vi.fn(),
  requireAgent: vi.fn(),
  requireAgentAccess: vi.fn(),
  requireChatAccess: vi.fn(),
  requireOrgAdmin: vi.fn(),
  requireOrgMembership: vi.fn(),
  resetActivity: vi.fn(),
  resolveUsageWindow: vi.fn(),
  summarizeAgent: vi.fn(),
  updateOrganization: vi.fn(),
};

const mockedModules = [
  "../middleware/require-identity.js",
  "../scope/require-org.js",
  "../scope/require-resource.js",
  "../services/activity.js",
  "../services/agent-runtime-switch.js",
  "../services/landing-campaigns/guards.js",
  "../services/me-doc.js",
  "../services/org-settings.js",
  "../services/organization.js",
  "../services/usage.js",
];

function mockRouteDependencies(): void {
  vi.doMock("../middleware/require-identity.js", () => ({
    requireAgent: routeMocks.requireAgent,
  }));
  vi.doMock("../scope/require-org.js", () => ({
    requireOrgAdmin: routeMocks.requireOrgAdmin,
    requireOrgMembership: routeMocks.requireOrgMembership,
  }));
  vi.doMock("../scope/require-resource.js", () => ({
    requireAgentAccess: routeMocks.requireAgentAccess,
    requireChatAccess: routeMocks.requireChatAccess,
  }));
  vi.doMock("../services/activity.js", () => ({
    resetActivity: routeMocks.resetActivity,
  }));
  vi.doMock("../services/agent-runtime-switch.js", () => ({
    assertNoRuntimeSwitchInProgress: routeMocks.assertNoRuntimeSwitchInProgress,
  }));
  vi.doMock("../services/landing-campaigns/guards.js", () => ({
    assertMutableAgentIsNotLandingCampaignTrial: routeMocks.assertMutableAgentIsNotLandingCampaignTrial,
  }));
  vi.doMock("../services/me-doc.js", () => ({
    getMeDocPreview: routeMocks.getMeDocPreview,
  }));
  vi.doMock("../services/org-settings.js", () => ({
    getOrgContextTree: routeMocks.getOrgContextTree,
  }));
  vi.doMock("../services/organization.js", () => ({
    getOrganization: routeMocks.getOrganization,
    updateOrganization: routeMocks.updateOrganization,
  }));
  vi.doMock("../services/usage.js", () => ({
    DEFAULT_USAGE_TURNS_LIMIT: 25,
    aggregateByAgent: routeMocks.aggregateByAgent,
    listAgentTurns: routeMocks.listAgentTurns,
    resolveUsageWindow: routeMocks.resolveUsageWindow,
    summarizeAgent: routeMocks.summarizeAgent,
  }));
}

function makeReply(): TestReply {
  const reply: TestReply = {
    status(code: number): TestReply {
      this.code = code;
      return this;
    },
    send(body: unknown): TestReply {
      this.body = body;
      return this;
    },
  };
  return reply;
}

function addRoute(
  routes: RegisteredRoute[],
  method: RegisteredRoute["method"],
  path: string,
  optionsOrHandler: unknown,
  maybeHandler?: unknown,
): void {
  const hasOptions = typeof optionsOrHandler !== "function";
  routes.push({
    handler: (hasOptions ? maybeHandler : optionsOrHandler) as RouteHandler,
    method,
    options: hasOptions ? optionsOrHandler : undefined,
    path,
  });
}

function makeApp(extra: Record<string, unknown> = {}): { app: unknown; routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  const app = {
    db: { name: "db" },
    get(path: string, optionsOrHandler: unknown, maybeHandler?: unknown): void {
      addRoute(routes, "GET", path, optionsOrHandler, maybeHandler);
    },
    patch(path: string, optionsOrHandler: unknown, maybeHandler?: unknown): void {
      addRoute(routes, "PATCH", path, optionsOrHandler, maybeHandler);
    },
    post(path: string, optionsOrHandler: unknown, maybeHandler?: unknown): void {
      addRoute(routes, "POST", path, optionsOrHandler, maybeHandler);
    },
    ...extra,
  };
  return { app, routes };
}

function route(routes: RegisteredRoute[], method: RegisteredRoute["method"], path: string): RegisteredRoute {
  const found = routes.find((entry) => entry.method === method && entry.path === path);
  expect(found).toBeDefined();
  return found as RegisteredRoute;
}

function makeQueuedSelectDb(results: unknown[][]): unknown {
  return {
    select: vi.fn(() => {
      const rows = results.shift() ?? [];
      const chain = {
        from: vi.fn(() => chain),
        limit: vi.fn(async () => rows),
        where: vi.fn(() => chain),
      };
      return chain;
    }),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockRouteDependencies();
  routeMocks.requireAgent.mockReturnValue({ organizationId: "org_1", uuid: "agent_1" });
  routeMocks.requireAgentAccess.mockResolvedValue({
    agent: { uuid: "agent_1" },
    scope: { humanAgentId: "human_1", memberId: "member_1" },
  });
  routeMocks.requireChatAccess.mockResolvedValue(undefined);
  routeMocks.requireOrgAdmin.mockResolvedValue({ memberId: "member_1", organizationId: "org_1", role: "admin" });
  routeMocks.requireOrgMembership.mockResolvedValue({
    memberId: "member_1",
    organizationId: "org_1",
    role: "admin",
  });
  routeMocks.resolveUsageWindow.mockReturnValue({
    from: new Date("2026-07-01T00:00:00.000Z"),
    to: new Date("2026-07-08T00:00:00.000Z"),
  });
});

afterEach(() => {
  for (const moduleId of mockedModules) {
    vi.doUnmock(moduleId);
  }
  vi.resetModules();
});

describe("small API route handlers", () => {
  it("maps GitHub entity follow service outcomes to the wire contract", async () => {
    const { sendFollowResult } = await import("../api/github-entity-reply.js");
    const conflictReply = makeReply();

    sendFollowResult(
      conflictReply as never,
      {
        conflict: { chatId: "chat_1", topic: "PR 1" },
        outcome: "conflict",
      } as never,
      "owner/repo#1",
    );
    expect(conflictReply.code).toBe(409);
    expect(conflictReply.body).toMatchObject({
      conflict: { chatId: "chat_1", topic: "PR 1" },
      error: "ENTITY_FOLLOWED_ELSEWHERE",
    });

    const createdReply = makeReply();
    sendFollowResult(createdReply as never, { entity: { key: "owner/repo#1" }, outcome: "created" } as never, "x");
    expect(createdReply.code).toBe(201);
    expect(createdReply.body).toEqual({ entity: { key: "owner/repo#1" }, status: "created" });

    const existingReply = makeReply();
    sendFollowResult(
      existingReply as never,
      { entity: { key: "owner/repo#1" }, outcome: "already_following" } as never,
      "x",
    );
    expect(existingReply.code).toBe(200);
  });

  it("serves org and agent usage routes with scoped defaults", async () => {
    const { orgUsageRoutes } = await import("../api/orgs/usage.js");
    const { agentUsageRoutes } = await import("../api/agent-usage.js");
    const { app, routes } = makeApp();
    routeMocks.aggregateByAgent.mockResolvedValue([{ agentId: "agent_1", totalTokens: 12 }]);
    routeMocks.summarizeAgent.mockResolvedValue({ totalTokens: 12 });
    routeMocks.listAgentTurns.mockResolvedValue({ rows: [], nextCursor: null });

    await orgUsageRoutes(app as never);
    await agentUsageRoutes(app as never);

    await expect(route(routes, "GET", "/by-agent").handler({ query: {} })).resolves.toEqual({
      from: "2026-07-01T00:00:00.000Z",
      rows: [{ agentId: "agent_1", totalTokens: 12 }],
      to: "2026-07-08T00:00:00.000Z",
    });
    await expect(
      route(routes, "GET", "/:uuid/usage/summary").handler({ params: { uuid: "agent_1" }, query: {} }),
    ).resolves.toEqual({ totalTokens: 12 });
    await expect(
      route(routes, "GET", "/:uuid/usage/turns").handler({
        params: { uuid: "agent_1" },
        query: { cursor: "cursor_1", limit: "not-a-number" },
      }),
    ).resolves.toEqual({ nextCursor: null, rows: [] });

    expect(routeMocks.aggregateByAgent).toHaveBeenCalledWith(
      { name: "db" },
      expect.objectContaining({ organizationId: "org_1" }),
    );
    expect(routeMocks.summarizeAgent).toHaveBeenCalledWith(
      { name: "db" },
      expect.objectContaining({ agentId: "agent_1" }),
    );
    expect(routeMocks.listAgentTurns).toHaveBeenCalledWith(
      { name: "db" },
      expect.objectContaining({ cursor: "cursor_1", limit: 25, viewer: { humanAgentId: "human_1" } }),
    );
  });

  it("returns health and healthz success and degraded responses", async () => {
    const { healthRoutes } = await import("../api/health.js");
    const { healthzRoutes } = await import("../api/healthz.js");
    const execute = vi.fn().mockResolvedValue(undefined);
    const { app, routes } = makeApp({ db: { execute } });

    await healthRoutes(app as never);
    await healthzRoutes(app as never);
    await expect(route(routes, "GET", "/health").handler()).resolves.toEqual({ db: "connected", status: "ok" });

    const okReply = makeReply();
    await route(routes, "GET", "/healthz").handler({}, okReply);
    expect(okReply).toMatchObject({ body: { status: "ok" }, code: 200 });

    execute.mockRejectedValueOnce(new Error("db down")).mockRejectedValueOnce(new Error("db down"));
    await expect(route(routes, "GET", "/health").handler()).resolves.toEqual({
      db: "disconnected",
      status: "degraded",
    });
    const degradedReply = makeReply();
    await route(routes, "GET", "/healthz").handler({}, degradedReply);
    expect(degradedReply).toMatchObject({ body: { message: "database unreachable", status: "error" }, code: 503 });
  });

  it("serves agent runtime config and context tree info", async () => {
    const { agentConfigRoutes } = await import("../api/agent/config.js");
    const { agentContextTreeInfoRoutes } = await import("../api/agent/context-tree-info.js");
    const { app, routes } = makeApp({
      configService: { getDecrypted: vi.fn().mockResolvedValue({ env: { A: "1" } }) },
      resourcesService: { resolveRuntimeConfig: vi.fn().mockReturnValue({ env: { A: "1" }, resources: [] }) },
    });
    routeMocks.getOrgContextTree.mockResolvedValue({ branch: undefined, repo: "owner/tree" });

    await agentConfigRoutes(app as never);
    await agentContextTreeInfoRoutes(app as never);

    await expect(route(routes, "GET", "/config").handler({})).resolves.toEqual({ env: { A: "1" }, resources: [] });
    await expect(route(routes, "GET", "/context-tree/info").handler({})).resolves.toEqual({
      branch: null,
      repo: "owner/tree",
    });
  });

  it("serializes organization identity reads and updates", async () => {
    const { orgIdentityRoutes } = await import("../api/orgs/identity.js");
    const dates = {
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-08T00:00:00.000Z"),
    };
    routeMocks.getOrganization.mockResolvedValue({ id: "org_1", name: "acme", displayName: "Acme", ...dates });
    routeMocks.updateOrganization.mockResolvedValue({ id: "org_1", name: "acme", displayName: "Acme Inc", ...dates });
    const { app, routes } = makeApp();

    await orgIdentityRoutes(app as never);

    await expect(route(routes, "GET", "/").handler({})).resolves.toMatchObject({
      createdAt: "2026-07-01T00:00:00.000Z",
      displayName: "Acme",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await expect(route(routes, "PATCH", "/").handler({ body: { displayName: "Acme Inc" } })).resolves.toMatchObject({
      displayName: "Acme Inc",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
  });

  it("guards organization resource mutations and previews", async () => {
    const { orgResourceRoutes } = await import("../api/orgs/resources.js");
    const resourcesService = {
      createTeamResource: vi.fn().mockResolvedValue({ id: "res_1" }),
      listTeamResources: vi.fn().mockResolvedValue([{ id: "res_1" }]),
      previewOrgImpact: vi.fn().mockResolvedValue({ affectedAgents: 2 }),
    };
    const { app, routes } = makeApp({ resourcesService });

    await orgResourceRoutes(app as never);

    await expect(route(routes, "GET", "/").handler({})).resolves.toEqual([{ id: "res_1" }]);
    const createReply = makeReply();
    await route(routes, "POST", "/").handler(
      { body: { name: "Prompt", payload: { body: "Use short replies." }, type: "prompt" } },
      createReply,
    );
    expect(createReply).toMatchObject({ body: { id: "res_1" }, code: 201 });
    await expect(route(routes, "POST", "/impact-preview").handler({ body: { resourceId: "res_1" } })).resolves.toEqual({
      affectedAgents: 2,
    });

    routeMocks.requireOrgMembership.mockResolvedValueOnce({
      memberId: "member_2",
      organizationId: "org_1",
      role: "member",
    });
    await expect(route(routes, "POST", "/").handler({ body: {} }, makeReply())).rejects.toThrow("Admin role required");
  });

  it("updates agent resource bindings after management guards", async () => {
    const { agentResourcesRoutes } = await import("../api/agents-resources.js");
    const resourcesService = {
      getAgentResources: vi.fn().mockResolvedValue({ bindings: [] }),
      replaceAgentResources: vi.fn().mockResolvedValue({ version: 2 }),
    };
    const { app, routes } = makeApp({ resourcesService });

    await agentResourcesRoutes(app as never);

    await expect(route(routes, "GET", "/:uuid/resources").handler({ params: { uuid: "agent_1" } })).resolves.toEqual({
      bindings: [],
    });
    await expect(
      route(routes, "PATCH", "/:uuid/resources").handler({
        body: {
          bindings: [{ inlinePromptBody: "Stay focused.", mode: "include", type: "prompt" }],
          expectedVersion: 1,
        },
        params: { uuid: "agent_1" },
      }),
    ).resolves.toEqual({ version: 2 });
    expect(routeMocks.assertMutableAgentIsNotLandingCampaignTrial).toHaveBeenCalledWith({ uuid: "agent_1" });
    expect(routeMocks.assertNoRuntimeSwitchInProgress).toHaveBeenCalledWith({ uuid: "agent_1" });
  });

  it("resets agent activity through the manage scope", async () => {
    const { agentActivityRoutes } = await import("../api/agent-activity.js");
    const { app, routes } = makeApp();

    await agentActivityRoutes(app as never);

    await expect(
      route(routes, "POST", "/:uuid/reset-activity").handler({ params: { uuid: "agent_1" } }),
    ).resolves.toEqual({
      reset: true,
    });
    expect(routeMocks.resetActivity).toHaveBeenCalledWith({ name: "db" }, "agent_1");
  });

  it("serves me document previews only for speaker agents", async () => {
    const { meDocsRoutes } = await import("../api/me-docs.js");
    routeMocks.getMeDocPreview.mockResolvedValue({
      content: "# Plan",
      path: "plan.md",
      ref: { agentId: "agent_1", chatId: "chat_1", path: "plan.md", type: "workspace" },
    });
    const { app, routes } = makeApp({
      db: makeQueuedSelectDb([[{ agentId: "agent_1" }], [{ name: "Writer" }], [], [{ name: "Writer" }]]),
    });

    await meDocsRoutes(app as never, { workspacesRoot: "/workspace" });

    await expect(
      route(routes, "GET", "/chats/:chatId/docs/preview").handler({
        params: { chatId: "chat_1" },
        query: { agentId: "agent_1", path: "plan.md" },
      }),
    ).resolves.toEqual({
      content: "# Plan",
      path: "plan.md",
      ref: { agentId: "agent_1", chatId: "chat_1", path: "plan.md", type: "workspace" },
    });
    await expect(
      route(routes, "GET", "/chats/:chatId/docs/preview").handler({
        params: { chatId: "chat_1" },
        query: { agentId: "agent_1", path: "plan.md" },
      }),
    ).rejects.toThrow("Document not found");
  });
});
