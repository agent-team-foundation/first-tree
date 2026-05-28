import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/connection.js";

type SdkMessageApi = {
  create: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  patch: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
};

type WsClientStub = {
  start: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;
  close: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
};

type DispatcherRecord = {
  handlers: Record<string, (data: Record<string, unknown>) => Promise<void>>;
};

const sdkState = vi.hoisted(() => ({
  clients: [] as Array<{ options: unknown; message: SdkMessageApi }>,
  dispatchers: [] as DispatcherRecord[],
  startError: null as Error | null,
  wsClients: [] as WsClientStub[],
}));

const mappingMocks = vi.hoisted(() => ({
  claimEvent: vi.fn<(db: unknown, eventId: string, platform: string) => Promise<boolean>>(),
  createAgentMapping: vi.fn<(db: unknown, mapping: Record<string, unknown>) => Promise<unknown>>(),
  createMessageReference: vi.fn<(db: unknown, ref: Record<string, unknown>) => Promise<unknown>>(),
  findAgentByExternalUser: vi.fn<(db: unknown, platform: string, externalUserId: string) => Promise<unknown>>(),
  findExternalChannelByChat: vi.fn<(db: unknown, platform: string, chatId: string) => Promise<unknown>>(),
  findExternalMessageByInternalId: vi.fn<(db: unknown, platform: string, messageId: string) => Promise<unknown>>(),
  findExternalUserByAgent: vi.fn<(db: unknown, platform: string, agentId: string) => Promise<unknown>>(),
  findOrCreateChatForChannel: vi.fn<(db: unknown, input: Record<string, unknown>) => Promise<string>>(),
  unclaimEvent: vi.fn<(db: unknown, eventId: string, platform: string) => Promise<unknown>>(),
}));

const sendMessageMock = vi.hoisted(() => ({
  sendMessage:
    vi.fn<(db: unknown, chatId: string, senderId: string, input: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  class Client {
    im: { v1: { message: SdkMessageApi } };

    constructor(options: unknown) {
      const message = {
        create: vi.fn(async () => ({ data: { message_id: `external-${sdkState.clients.length + 1}` } })),
        patch: vi.fn(async () => ({})),
      };
      this.im = { v1: { message } };
      sdkState.clients.push({ options, message });
    }
  }

  class EventDispatcher {
    register(handlers: Record<string, (data: Record<string, unknown>) => Promise<void>>) {
      sdkState.dispatchers.push({ handlers });
      return this;
    }
  }

  class WSClient {
    start = vi.fn(async () => {
      if (sdkState.startError) throw sdkState.startError;
    });
    close = vi.fn();

    constructor() {
      sdkState.wsClients.push(this);
    }
  }

  return { Client, EventDispatcher, LoggerLevel: { warn: "warn" }, WSClient };
});

vi.mock("../services/crypto.js", () => ({
  decryptCredentials: vi.fn((payload: string) => {
    if (payload === "bad") throw new Error("decrypt failed");
    return JSON.parse(payload);
  }),
}));

vi.mock("../services/adapter-mapping.js", () => mappingMocks);

vi.mock("../services/message.js", () => sendMessageMock);

vi.mock("../observability/index.js", () => ({
  adapterAttrs: (attrs: Record<string, unknown>) => attrs,
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
  withSpan: async (_name: string, _attrs: Record<string, unknown>, fn: () => Promise<unknown>) => fn(),
}));

type AdapterConfigRow = {
  id: number;
  platform: string;
  credentials: string | null;
  updatedAt: Date;
  agentId: string;
};

type SelectPlan = {
  kind: "where" | "limit";
  rows: unknown[];
};

type MessageRow = {
  id: string;
  senderId: string;
  chatId: string;
  format: string;
  content: unknown;
  metadata: Record<string, unknown> | null;
};

type DbDouble = {
  acked: number;
  executeRows: Array<{ id: number; inbox_id: string; message_id: string; chat_id: string | null }>;
  queueLimit: (rows: unknown[]) => void;
  queueWhere: (rows: unknown[]) => void;
  value: Database;
};

function createDbDouble(): DbDouble {
  const plans: SelectPlan[] = [];
  const state = {
    acked: 0,
    executeRows: [] as Array<{ id: number; inbox_id: string; message_id: string; chat_id: string | null }>,
  };
  const nextPlan = (): SelectPlan => {
    const plan = plans.shift();
    if (!plan) throw new Error("unexpected db.select call");
    return plan;
  };
  const db = {
    execute: vi.fn(async () => state.executeRows),
    select: vi.fn(() => ({
      from: () => ({
        where: () => {
          const plan = nextPlan();
          if (plan.kind === "where") return Promise.resolve(plan.rows);
          return { limit: async () => plan.rows };
        },
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: async () => {
          state.acked++;
        },
      }),
    })),
  };
  return {
    get acked() {
      return state.acked;
    },
    set acked(value: number) {
      state.acked = value;
    },
    get executeRows() {
      return state.executeRows;
    },
    set executeRows(value: Array<{ id: number; inbox_id: string; message_id: string; chat_id: string | null }>) {
      state.executeRows = value;
    },
    queueLimit: (rows) => plans.push({ kind: "limit", rows }),
    queueWhere: (rows) => plans.push({ kind: "where", rows }),
    value: db as unknown as Database,
  };
}

function createLogger(): FastifyBaseLogger {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function configRow(overrides: Partial<AdapterConfigRow> = {}): AdapterConfigRow {
  return {
    id: 1,
    platform: "feishu",
    credentials: JSON.stringify({ app_id: "app-1", app_secret: "secret-1" }),
    updatedAt: new Date("2026-05-28T00:00:00.000Z"),
    agentId: "bot-agent",
    ...overrides,
  };
}

function messageRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    senderId: "bot-agent",
    chatId: "chat-1",
    format: "text",
    content: "hello",
    metadata: null,
    ...overrides,
  };
}

function feishuEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "evt-1",
    sender: {
      sender_id: { open_id: "open-1", union_id: "union-1" },
      sender_type: "user",
    },
    message: {
      chat_id: "external-chat",
      chat_type: "group",
      message_id: "external-message",
      message_type: "text",
      content: JSON.stringify({ text: "hello from Feishu" }),
      create_time: "2026-05-28T00:00:00.000Z",
      mentions: [{ key: "@atlas", id: { open_id: "open-bot" }, name: "Atlas" }],
    },
    ...overrides,
  };
}

function latestInboundHandler(): (data: Record<string, unknown>) => Promise<void> {
  const dispatcher = sdkState.dispatchers.at(-1);
  const handler = dispatcher?.handlers["im.message.receive_v1"];
  if (!handler) throw new Error("missing Feishu inbound handler");
  return handler;
}

async function createStartedManager(db: DbDouble) {
  const { createAdapterManager } = await import("../services/adapter-manager.js");
  db.queueWhere([configRow()]);
  const manager = createAdapterManager(db.value, "key", createLogger());
  await manager.reload();
  expect(manager.getBotStatuses()).toMatchObject([{ appId: "app-1", connected: true }]);
  return manager;
}

describe("createAdapterManager unit paths", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    sdkState.clients.length = 0;
    sdkState.dispatchers.length = 0;
    sdkState.startError = null;
    sdkState.wsClients.length = 0;
    mappingMocks.claimEvent.mockResolvedValue(true);
    mappingMocks.createAgentMapping.mockResolvedValue({});
    mappingMocks.createMessageReference.mockResolvedValue({});
    mappingMocks.findAgentByExternalUser.mockResolvedValue(null);
    mappingMocks.findExternalChannelByChat.mockResolvedValue({ externalChannelId: "external-chat" });
    mappingMocks.findExternalMessageByInternalId.mockResolvedValue(null);
    mappingMocks.findExternalUserByAgent.mockResolvedValue(null);
    mappingMocks.findOrCreateChatForChannel.mockResolvedValue("chat-1");
    mappingMocks.unclaimEvent.mockResolvedValue({});
    sendMessageMock.sendMessage.mockResolvedValue({
      message: messageRow({ id: "internal-message" }),
      recipients: ["agent-human"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
  });

  it("reloads Feishu configs, skips unchanged rows, replaces changed bots, and shuts down inactive bots", async () => {
    const { createAdapterManager } = await import("../services/adapter-manager.js");
    const db = createDbDouble();
    const manager = createAdapterManager(db.value, "key", createLogger());

    process.env.HTTP_PROXY = "http://proxy.example.test";
    db.queueWhere([
      configRow(),
      configRow({ id: 2, platform: "slack", credentials: JSON.stringify({ app_id: "ignored" }) }),
      configRow({ id: 3, credentials: "bad" }),
      configRow({ id: 4, credentials: null }),
    ]);
    await manager.reload();

    expect(process.env.HTTP_PROXY).toBe("http://proxy.example.test");
    expect(sdkState.clients).toHaveLength(1);
    expect(sdkState.wsClients).toHaveLength(1);
    expect(manager.getBotStatuses()).toEqual([
      {
        configId: 1,
        platform: "feishu",
        agentId: "bot-agent",
        appId: "app-1",
        connected: true,
        lastError: null,
        lastActiveAt: null,
      },
    ]);

    db.queueWhere([configRow()]);
    await manager.reload();
    expect(sdkState.clients).toHaveLength(1);

    db.queueWhere([
      configRow({
        updatedAt: new Date("2026-05-28T00:01:00.000Z"),
        credentials: JSON.stringify({ app_id: "app-1", app_secret: "changed", bypass_proxy: false }),
      }),
    ]);
    await manager.reload();
    expect(sdkState.clients).toHaveLength(2);
    expect(sdkState.wsClients[0]?.close).toHaveBeenCalledWith({ force: true });

    db.queueWhere([]);
    await manager.reload();
    expect(manager.getBotStatuses()).toEqual([]);

    manager.shutdown();
  });

  it("records a disconnected bot when the SDK start handshake fails", async () => {
    const { createAdapterManager } = await import("../services/adapter-manager.js");
    const db = createDbDouble();
    const manager = createAdapterManager(db.value, "key", createLogger());

    sdkState.startError = new Error("ws unavailable");
    db.queueWhere([configRow()]);
    await manager.reload();

    expect(sdkState.wsClients[0]?.close).toHaveBeenCalledWith({ force: true });
    expect(manager.getBotStatuses()).toMatchObject([{ appId: "app-1", connected: false, lastError: "ws unavailable" }]);
  });

  it("handles inbound messages, deduplication, unknown users, and bound users", async () => {
    const db = createDbDouble();
    await createStartedManager(db);
    const handler = latestInboundHandler();

    await handler({ sender: {}, message: null });
    expect(mappingMocks.claimEvent).not.toHaveBeenCalled();

    mappingMocks.claimEvent.mockResolvedValueOnce(false);
    await handler(feishuEvent({ event_id: "evt-duplicate" }));
    expect(sendMessageMock.sendMessage).not.toHaveBeenCalled();

    await handler(
      feishuEvent({
        event_id: "evt-bot",
        sender: { sender_id: { open_id: "bot-open", union_id: "bot-union" }, sender_type: "bot" },
      }),
    );
    expect(sendMessageMock.sendMessage).not.toHaveBeenCalled();

    await handler(feishuEvent({ event_id: "evt-unknown" }));
    expect(sdkState.clients[0]?.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ receive_id: "external-chat", msg_type: "text" }),
      }),
    );

    mappingMocks.findAgentByExternalUser.mockResolvedValueOnce({ agentId: "human-agent" });
    await handler(feishuEvent({ event_id: "evt-bound" }));

    expect(mappingMocks.findOrCreateChatForChannel).toHaveBeenCalledWith(
      db.value,
      expect.objectContaining({
        botAgentId: "bot-agent",
        senderAgentId: "human-agent",
        externalChannelId: "external-chat",
      }),
    );
    expect(sendMessageMock.sendMessage).toHaveBeenCalledWith(
      db.value,
      "chat-1",
      "human-agent",
      expect.objectContaining({
        format: "text",
        content: "hello from Feishu",
        source: "feishu",
      }),
    );
    expect(mappingMocks.createMessageReference).toHaveBeenCalledWith(
      db.value,
      expect.objectContaining({ messageId: "internal-message", externalMessageId: "external-message" }),
    );
  });

  it("exercises Feishu /bind command outcomes", async () => {
    const db = createDbDouble();
    await createStartedManager(db);
    const handler = latestInboundHandler();
    const bindEvent = (id: string) =>
      feishuEvent({
        event_id: id,
        message: {
          chat_id: "external-chat",
          chat_type: "group",
          message_id: `external-${id}`,
          message_type: "text",
          content: JSON.stringify({ text: "/bind ada" }),
          create_time: "2026-05-28T00:00:00.000Z",
        },
      });

    mappingMocks.findAgentByExternalUser.mockResolvedValueOnce({ agentId: "already-bound" });
    await handler(bindEvent("bind-existing"));

    mappingMocks.findAgentByExternalUser.mockResolvedValueOnce(null);
    db.queueLimit([]);
    await handler(bindEvent("bind-missing"));

    mappingMocks.findAgentByExternalUser.mockResolvedValueOnce(null);
    db.queueLimit([{ id: "agent-1", type: "human", status: "suspended" }]);
    await handler(bindEvent("bind-inactive"));

    mappingMocks.findAgentByExternalUser.mockResolvedValueOnce(null);
    db.queueLimit([{ id: "agent-1", type: "agent", status: "active" }]);
    await handler(bindEvent("bind-nonhuman"));

    mappingMocks.findAgentByExternalUser.mockResolvedValueOnce(null);
    db.queueLimit([{ id: "agent-1", type: "human", status: "active" }]);
    mappingMocks.findExternalUserByAgent.mockResolvedValueOnce({ externalUserId: "open-other" });
    await handler(bindEvent("bind-target-used"));

    mappingMocks.findAgentByExternalUser.mockResolvedValueOnce(null);
    db.queueLimit([{ id: "agent-1", type: "human", status: "active" }]);
    mappingMocks.findExternalUserByAgent.mockResolvedValueOnce(null);
    mappingMocks.createAgentMapping.mockRejectedValueOnce(new Error("insert failed"));
    await handler(bindEvent("bind-insert-fails"));

    mappingMocks.findAgentByExternalUser.mockResolvedValueOnce(null);
    db.queueLimit([{ id: "agent-1", type: "human", status: "active" }]);
    mappingMocks.findExternalUserByAgent.mockResolvedValueOnce(null);
    await handler(bindEvent("bind-success"));

    const replyPayloads = sdkState.clients[0]?.message.create.mock.calls.map(([call]) => call);
    expect(replyPayloads?.length).toBeGreaterThanOrEqual(7);
    expect(mappingMocks.createAgentMapping).toHaveBeenLastCalledWith(
      db.value,
      expect.objectContaining({
        platform: "feishu",
        externalUserId: "union-1",
        agentId: "agent-1",
        boundVia: "command",
      }),
    );
  });

  it("processes outbound entries with skip, dedupe, send, and error paths", async () => {
    const db = createDbDouble();
    const manager = await createStartedManager(db);
    db.executeRows = [
      { id: 1, inbox_id: "inbox-1", message_id: "missing", chat_id: "chat-1" },
      { id: 2, inbox_id: "inbox-1", message_id: "from-feishu", chat_id: "chat-1" },
      { id: 3, inbox_id: "inbox-1", message_id: "no-channel", chat_id: "chat-missing" },
      { id: 4, inbox_id: "inbox-1", message_id: "no-bot", chat_id: "chat-1" },
      { id: 5, inbox_id: "inbox-1", message_id: "send-ok", chat_id: "chat-1" },
      { id: 6, inbox_id: "inbox-1", message_id: "send-ok", chat_id: "chat-1" },
      { id: 7, inbox_id: "inbox-1", message_id: "send-error", chat_id: "chat-1" },
    ];
    db.queueLimit([]);
    db.queueLimit([messageRow({ id: "from-feishu", metadata: { source: "feishu" } })]);
    db.queueLimit([messageRow({ id: "no-channel", chatId: "chat-missing" })]);
    db.queueLimit([messageRow({ id: "no-bot", senderId: "unbound-bot" })]);
    db.queueLimit([messageRow({ id: "send-ok", format: "markdown", content: "**ship**" })]);
    db.queueLimit([messageRow({ id: "send-ok", format: "markdown", content: "**ship**" })]);
    db.queueLimit([messageRow({ id: "send-error", format: "card", content: { title: "boom" } })]);
    mappingMocks.findExternalChannelByChat.mockImplementation(async (_db, _platform, chatId) =>
      chatId === "chat-missing" ? null : { externalChannelId: "external-chat" },
    );
    sdkState.clients[0]?.message.create.mockImplementation(async (call: unknown) => {
      const content =
        typeof call === "object" &&
        call !== null &&
        "data" in call &&
        typeof call.data === "object" &&
        call.data !== null &&
        "content" in call.data
          ? call.data.content
          : null;
      if (typeof content === "string" && content.includes("boom")) throw new Error("send failed");
      return { data: { message_id: "external-1" } };
    });

    const result = await manager.processOutbound();

    expect(result).toEqual({ sent: 1, errors: 1 });
    expect(db.acked).toBe(6);
    expect(mappingMocks.createMessageReference).toHaveBeenCalledWith(
      db.value,
      expect.objectContaining({ messageId: "send-ok", externalMessageId: "external-1" }),
    );
  });

  it("edits outbound messages only when a reference, internal sender, and bot are available", async () => {
    const db = createDbDouble();
    const manager = await createStartedManager(db);

    await expect(manager.editOutboundMessage("msg-none", "text", "ignored")).resolves.toBe(false);

    mappingMocks.findExternalMessageByInternalId.mockResolvedValue({ externalMessageId: "ext-1" });
    db.queueLimit([]);
    await expect(manager.editOutboundMessage("msg-no-row", "text", "ignored")).resolves.toBe(false);

    db.queueLimit([{ senderId: "unbound-bot" }]);
    await expect(manager.editOutboundMessage("msg-no-bot", "text", "ignored")).resolves.toBe(false);

    db.queueLimit([{ senderId: "bot-agent" }]);
    await expect(manager.editOutboundMessage("msg-ok", "markdown", "# Done")).resolves.toBe(true);
    expect(sdkState.clients[0]?.message.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: "ext-1" },
        data: expect.objectContaining({ content: expect.stringContaining("markdown") }),
      }),
    );

    sdkState.clients[0]?.message.patch.mockRejectedValueOnce(new Error("patch failed"));
    db.queueLimit([{ senderId: "bot-agent" }]);
    await expect(manager.editOutboundMessage("msg-patch-error", "card", { title: "Card" })).resolves.toBe(false);
  });

  it("short-circuits disabled and empty manager states", async () => {
    const { createAdapterManager } = await import("../services/adapter-manager.js");
    const db = createDbDouble();
    const disabled = createAdapterManager(db.value, undefined, createLogger());
    await disabled.reload();
    await expect(disabled.processOutbound()).resolves.toEqual({ sent: 0, errors: 0 });
    expect(disabled.getBotStatuses()).toEqual([]);
  });
});
