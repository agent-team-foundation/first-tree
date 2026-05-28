import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (request: RequestShape, reply: ReplyShape) => Promise<unknown>;
type RequestShape = {
  body?: unknown;
  params?: Record<string, string>;
};
type ReplyShape = {
  code?: number;
  payload?: unknown;
  send: (payload?: unknown) => ReplyShape;
  status: (code: number) => ReplyShape;
};
type RouteApp = FastifyInstance & {
  handlers: Map<string, Handler>;
};

const createAdapterConfigMock = vi.fn();
const createAgentMappingMock = vi.fn();
const deleteAdapterConfigMock = vi.fn();
const getAgentMock = vi.fn();
const listAdapterConfigsMock = vi.fn();
const reloadMock = vi.fn();
const notifyConfigChangeMock = vi.fn();
const requireAgentMock = vi.fn();
const updateAdapterConfigMock = vi.fn();

function makeReply(): ReplyShape {
  const reply: ReplyShape = {
    send: (payload?: unknown) => {
      reply.payload = payload;
      return reply;
    },
    status: (code: number) => {
      reply.code = code;
      return reply;
    },
  };
  return reply;
}

function makeApp(): RouteApp {
  const handlers = new Map<string, Handler>();
  const deleteChain = {
    where: vi.fn(async () => undefined),
  };
  return {
    adapterManager: { reload: reloadMock },
    config: { secrets: { encryptionKey: "enc-key" } },
    db: {
      delete: vi.fn(() => deleteChain),
    },
    delete: (path: string, handler: Handler) => {
      handlers.set(`DELETE ${path}`, handler);
      return undefined;
    },
    handlers,
    notifier: { notifyConfigChange: notifyConfigChangeMock },
    post: (path: string, handler: Handler) => {
      handlers.set(`POST ${path}`, handler);
      return undefined;
    },
    put: (path: string, handler: Handler) => {
      handlers.set(`PUT ${path}`, handler);
      return undefined;
    },
  } as unknown as RouteApp;
}

function route(app: RouteApp, key: string): Handler {
  const handler = app.handlers.get(key);
  if (!handler) throw new Error(`Missing handler: ${key}`);
  return handler;
}

function configRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: "agent-bot",
    createdAt: new Date("2026-05-28T00:00:00.000Z"),
    id: 42,
    platform: "feishu",
    status: "active",
    updatedAt: new Date("2026-05-28T00:00:00.000Z"),
    ...overrides,
  };
}

describe("agent Feishu self-service route units", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    createAdapterConfigMock.mockResolvedValue(configRow({ id: 2 }));
    createAgentMappingMock.mockResolvedValue({
      agentId: "human-1",
      boundVia: "delegate",
      createdAt: new Date("2026-05-28T00:00:00.000Z"),
      displayName: "Ada",
      externalUserId: "ou_123",
      id: 7,
      platform: "feishu",
    });
    deleteAdapterConfigMock.mockResolvedValue(undefined);
    getAgentMock.mockResolvedValue({ type: "agent", delegateMention: "agent-bot" });
    listAdapterConfigsMock.mockResolvedValue([]);
    notifyConfigChangeMock.mockResolvedValue(undefined);
    reloadMock.mockResolvedValue(undefined);
    requireAgentMock.mockReturnValue({ uuid: "agent-bot" });
    updateAdapterConfigMock.mockResolvedValue(configRow({ id: 1 }));

    vi.doMock("../middleware/require-identity.js", () => ({ requireAgent: requireAgentMock }));
    vi.doMock("../observability/index.js", () => ({ createLogger: () => ({ error: vi.fn() }) }));
    vi.doMock("../services/adapter.js", () => ({
      createAdapterConfig: createAdapterConfigMock,
      deleteAdapterConfig: deleteAdapterConfigMock,
      listAdapterConfigs: listAdapterConfigsMock,
      updateAdapterConfig: updateAdapterConfigMock,
    }));
    vi.doMock("../services/adapter-mapping.js", () => ({ createAgentMapping: createAgentMappingMock }));
    vi.doMock("../services/agent.js", () => ({ getAgent: getAgentMock }));
  });

  it("creates, updates, and deletes Feishu bot adapter configs for non-human agents", async () => {
    const { agentFeishuBotRoutes } = await import("../api/agent/feishu-bot.js");
    const app = makeApp();
    await agentFeishuBotRoutes(app);

    const createReply = makeReply();
    await route(app, "PUT /me/feishu-bot")({ body: { appId: "cli_a", appSecret: "secret" } }, createReply);

    expect(createReply.code).toBe(201);
    expect(createAdapterConfigMock).toHaveBeenCalledWith(
      app.db,
      expect.objectContaining({
        agentId: "agent-bot",
        credentials: { app_id: "cli_a", app_secret: "secret" },
        platform: "feishu",
        status: "active",
      }),
      "enc-key",
    );
    expect(createReply.payload).toEqual(expect.objectContaining({ createdAt: "2026-05-28T00:00:00.000Z" }));
    expect(reloadMock).toHaveBeenCalled();
    expect(notifyConfigChangeMock).toHaveBeenCalledWith("adapter_configs");

    vi.clearAllMocks();
    listAdapterConfigsMock.mockResolvedValue([configRow({ id: 1 })]);
    const updateReply = makeReply();
    await route(app, "PUT /me/feishu-bot")({ body: { appId: "cli_b", appSecret: "new-secret" } }, updateReply);

    expect(updateReply.code).toBe(200);
    expect(updateAdapterConfigMock).toHaveBeenCalledWith(
      app.db,
      1,
      { credentials: { app_id: "cli_b", app_secret: "new-secret" }, status: "active" },
      "enc-key",
    );

    vi.clearAllMocks();
    const deleteReply = makeReply();
    await route(app, "DELETE /me/feishu-bot")({}, deleteReply);

    expect(deleteReply.code).toBe(204);
    expect(deleteAdapterConfigMock).toHaveBeenCalledWith(app.db, 1);
    expect(reloadMock).toHaveBeenCalled();

    vi.clearAllMocks();
    listAdapterConfigsMock.mockResolvedValue([]);
    const missingReply = makeReply();
    await route(app, "DELETE /me/feishu-bot")({}, missingReply);

    expect(missingReply.code).toBe(204);
    expect(deleteAdapterConfigMock).not.toHaveBeenCalled();
  });

  it("rejects Feishu bot binding for human agents", async () => {
    const { agentFeishuBotRoutes } = await import("../api/agent/feishu-bot.js");
    const app = makeApp();
    await agentFeishuBotRoutes(app);
    getAgentMock.mockResolvedValue({ type: "human" });

    await expect(
      route(app, "PUT /me/feishu-bot")({ body: { appId: "cli_a", appSecret: "secret" } }, makeReply()),
    ).rejects.toMatchObject({ name: "BadRequestError", statusCode: 400 });
  });

  it("creates and deletes delegated Feishu user mappings with delegate authorization", async () => {
    const { agentFeishuUserRoutes } = await import("../api/agent/feishu-user.js");
    const app = makeApp();
    await agentFeishuUserRoutes(app);
    getAgentMock.mockResolvedValue({ type: "human", delegateMention: "agent-bot" });

    const createReply = makeReply();
    await route(app, "POST /:humanAgentId/feishu-user")(
      { body: { displayName: "Ada", feishuUserId: "ou_123" }, params: { humanAgentId: "human-1" } },
      createReply,
    );

    expect(createReply.code).toBe(201);
    expect(createAgentMappingMock).toHaveBeenCalledWith(app.db, {
      agentId: "human-1",
      boundVia: "delegate",
      displayName: "Ada",
      externalUserId: "ou_123",
      platform: "feishu",
    });
    expect(createReply.payload).toEqual(expect.objectContaining({ createdAt: "2026-05-28T00:00:00.000Z" }));

    const deleteReply = makeReply();
    await route(app, "DELETE /:humanAgentId/feishu-user")({ params: { humanAgentId: "human-1" } }, deleteReply);
    expect(deleteReply.code).toBe(204);
    expect(app.db.delete).toHaveBeenCalled();
  });

  it("rejects delegated Feishu user mapping when target or delegate authorization is wrong", async () => {
    const { agentFeishuUserRoutes } = await import("../api/agent/feishu-user.js");
    const app = makeApp();
    await agentFeishuUserRoutes(app);

    getAgentMock.mockResolvedValueOnce({ type: "agent", delegateMention: "agent-bot" });
    await expect(
      route(app, "POST /:humanAgentId/feishu-user")(
        { body: { feishuUserId: "ou_123" }, params: { humanAgentId: "not-human" } },
        makeReply(),
      ),
    ).rejects.toMatchObject({ name: "BadRequestError", statusCode: 400 });

    getAgentMock.mockResolvedValueOnce({ type: "human", delegateMention: "other-agent" });
    await expect(
      route(app, "POST /:humanAgentId/feishu-user")(
        { body: { feishuUserId: "ou_123" }, params: { humanAgentId: "human-1" } },
        makeReply(),
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError", statusCode: 403 });

    getAgentMock.mockResolvedValueOnce({ type: "human", delegateMention: "other-agent" });
    await expect(
      route(app, "DELETE /:humanAgentId/feishu-user")({ params: { humanAgentId: "human-1" } }, makeReply()),
    ).rejects.toMatchObject({ name: "ForbiddenError", statusCode: 403 });
  });
});
