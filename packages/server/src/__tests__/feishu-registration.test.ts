import { FEISHU_REQUIRED_SCOPES } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat/conversation.js";
import { encryptCredentials } from "../services/crypto.js";
import { createFeishuIntegrationManager, type FeishuSdkDependencies } from "../services/integrations/feishu/manager.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

const DEFAULT_BOT_INFO_RESPONSE = {
  code: 0,
  msg: "ok",
  bot: {
    app_name: "Agent A · First Tree",
    avatar_url: "https://example.com/agent-a.png",
    open_id: "ou_created_bot",
  },
};

const sdkMocks = (() => {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const connect = vi.fn().mockResolvedValue(undefined);
  const addReaction = vi.fn().mockResolvedValue("reaction-ack");
  const request = vi.fn().mockResolvedValue(DEFAULT_BOT_INFO_RESPONSE);
  const channel = {
    botIdentity: { openId: "ou_created_bot" },
    on: vi.fn((name: string, handler: (payload: unknown) => unknown) => {
      handlers.set(name, handler);
      return channel;
    }),
    addReaction,
    connect,
    disconnect,
  };
  return {
    handlers,
    channel,
    addReaction,
    connect,
    disconnect,
    request,
    registerApp: vi.fn(async (options: Parameters<FeishuSdkDependencies["registerApp"]>[0]) => {
      options.onQRCodeReady?.({ url: "https://open.feishu.cn/register?code=test", expireIn: 120 });
      return { client_id: "cli_created", client_secret: "secret-created-by-feishu" };
    }),
    createLarkChannel: vi.fn((_options: Parameters<FeishuSdkDependencies["createLarkChannel"]>[0]) => channel),
    createClient: vi.fn((_options: Parameters<FeishuSdkDependencies["createClient"]>[0]) => ({
      request,
      im: {
        v1: {
          chatMembers: { get: vi.fn() },
          messageResource: { get: vi.fn() },
        },
      },
    })),
  };
})();

const feishuSdk = sdkMocks as unknown as FeishuSdkDependencies;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createIsolatedSdk(
  registerAppImplementation: FeishuSdkDependencies["registerApp"],
  botOpenId = "ou_created_bot",
) {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const connect = vi.fn().mockResolvedValue(undefined);
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const addReaction = vi.fn().mockResolvedValue("reaction-ack");
  const request = vi.fn().mockResolvedValue({
    code: 0,
    msg: "ok",
    bot: { app_name: "Agent A · First Tree", avatar_url: null, open_id: botOpenId },
  });
  const channel = {
    botIdentity: { openId: botOpenId },
    on: vi.fn((name: string, handler: (payload: unknown) => unknown) => {
      handlers.set(name, handler);
      return channel;
    }),
    addReaction,
    connect,
    disconnect,
  };
  const registerApp = vi.fn(registerAppImplementation);
  const sdk = {
    registerApp,
    createLarkChannel: vi.fn(() => channel),
    createClient: vi.fn(() => ({
      request,
      im: {
        v1: {
          chatMembers: { get: vi.fn() },
          messageResource: { get: vi.fn() },
        },
      },
    })),
  } as unknown as FeishuSdkDependencies;
  return { sdk, registerApp, channel, addReaction, connect, disconnect, request, handlers };
}

function receivedMessage(id: string) {
  return {
    messageId: `om_${id}`,
    chatId: "oc_acknowledge",
    chatType: "p2p",
    senderId: "ou_human",
    senderName: "Human",
    content: "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    raw: {
      header: { event_id: `event_${id}` },
      event: {
        sender: { tenant_key: "tenant-a", sender_id: { open_id: "ou_human" } },
        message: { message_type: "text", content: JSON.stringify({ text: "hello" }) },
      },
    },
  };
}

describe("official Feishu QR registration", () => {
  const getApp = useTestApp({ feishuSdk });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMocks.handlers.clear();
    sdkMocks.channel.botIdentity = { openId: "ou_created_bot" };
    sdkMocks.connect.mockResolvedValue(undefined);
    sdkMocks.disconnect.mockResolvedValue(undefined);
    sdkMocks.request.mockReset().mockResolvedValue(DEFAULT_BOT_INFO_RESPONSE);
    sdkMocks.addReaction.mockResolvedValue("reaction-ack");
  });

  async function prepareSupersededReauthorization(suffix: string) {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const bindingId = `binding-${crypto.randomUUID()}`;
    const oldSecretCipher = encryptCredentials({ appSecret: "old-secret" }, encryptionKey);
    await app.db.insert(imBotBindings).values({
      id: bindingId,
      organizationId: a.organizationId,
      agentId: a.agent.uuid,
      appId: "cli_existing",
      appSecretCipher: oldSecretCipher,
      botOpenId: "ou_created_bot",
      status: "active",
      connectionStatus: "connected",
      connectionOwnerInstanceId: "existing-owner",
      connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
      connectionEpoch: 1,
    });

    const firstCompletion = deferred<{ client_id: string; client_secret: string }>();
    const firstSdk = createIsolatedSdk(async (options) => {
      options.onQRCodeReady({ url: `https://open.feishu.cn/register?code=${suffix}-first`, expireIn: 120 });
      return firstCompletion.promise;
    });
    const firstManager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: `${suffix}-first-manager`,
      sdk: firstSdk.sdk,
    });
    await firstManager.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await app.db
      .update(imBotBindings)
      .set({ registrationExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(imBotBindings.id, bindingId));

    const secondCompletion = deferred<{ client_id: string; client_secret: string }>();
    const secondSdk = createIsolatedSdk(async (options) => {
      options.onQRCodeReady({ url: `https://open.feishu.cn/register?code=${suffix}-second`, expireIn: 120 });
      return secondCompletion.promise;
    });
    const secondManager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: `${suffix}-second-manager`,
      sdk: secondSdk.sdk,
      timings: { initialClaimDelayMs: 1, claimIntervalMs: 60_000 },
    });
    secondManager.start();
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId));
      return row?.status === "active" && row.registrationStateCipher === null;
    });
    await secondManager.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    const [secondAttempt] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId));
    if (!secondAttempt?.registrationStateCipher || !secondAttempt.registrationExpiresAt) {
      throw new Error("expected the second registration attempt");
    }
    return {
      app,
      agentId: a.agent.uuid,
      bindingId,
      oldSecretCipher,
      firstCompletion,
      secondCompletion,
      firstManager,
      secondManager,
      secondAttemptCipher: secondAttempt.registrationStateCipher,
      secondAttemptExpiresAt: secondAttempt.registrationExpiresAt,
    };
  }

  async function prepareExistingBindingWithMapping(suffix: string) {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const bindingId = `binding-${crypto.randomUUID()}`;
    const oldSecretCipher = encryptCredentials({ appSecret: "old-secret" }, encryptionKey);
    await app.db.insert(imBotBindings).values({
      id: bindingId,
      organizationId: a.organizationId,
      agentId: a.agent.uuid,
      appId: "cli_existing",
      appSecretCipher: oldSecretCipher,
      botOpenId: "ou_created_bot",
      status: "active",
      connectionStatus: "connected",
      connectionOwnerInstanceId: "existing-owner",
      connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
      connectionEpoch: 1,
    });
    const chat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const [mapping] = await app.db
      .insert(imChatBindings)
      .values({
        id: `mapping-${crypto.randomUUID()}`,
        botBindingId: bindingId,
        feishuChatId: `oc_${suffix}`,
        chatId: chat.id,
        feishuChatType: "group",
      })
      .returning();
    if (!mapping) throw new Error("expected an active chat mapping");
    return { app, a, encryptionKey, bindingId, oldSecretCipher, mapping };
  }

  it("keeps the explicit tenant scope contract exact and duplicate-free", () => {
    expect(FEISHU_REQUIRED_SCOPES).toMatchInlineSnapshot(`
      [
        "im:message",
        "im:message:send_as_bot",
        "im:message.group_at_msg:readonly",
        "im:message.group_msg",
        "im:message.p2p_msg:readonly",
        "im:chat.members:read",
        "im:chat:readonly",
        "im:message:readonly",
        "im:message.reactions:read",
        "docx:document:create",
        "docx:document:readonly",
        "docx:document:write_only",
        "docs:document.media:upload",
        "docs:document.media:download",
        "docs:permission.member:create",
        "docs:permission.member:retrieve",
        "docs:permission.member:update",
        "drive:drive.metadata:readonly",
        "drive:file:upload",
        "drive:file:download",
        "space:document:delete",
        "space:folder:create",
        "wiki:wiki",
        "sheets:spreadsheet:create",
        "sheets:spreadsheet:read",
        "sheets:spreadsheet:write_only",
        "sheets:spreadsheet.meta:read",
        "base:app:create",
        "base:app:read",
        "base:app:update",
        "base:table:create",
        "base:table:read",
        "base:table:update",
        "base:table:delete",
        "base:field:create",
        "base:field:read",
        "base:field:update",
        "base:field:delete",
        "base:record:create",
        "base:record:read",
        "base:record:retrieve",
        "base:record:update",
        "base:record:delete",
        "base:view:read",
        "base:view:write_only",
        "calendar:calendar:create",
        "calendar:calendar:read",
        "calendar:calendar:update",
        "calendar:calendar:delete",
        "calendar:calendar.event:create",
        "calendar:calendar.event:read",
        "calendar:calendar.event:update",
        "calendar:calendar.event:delete",
        "calendar:calendar.event:reply",
        "calendar:calendar.free_busy:read",
        "task:task:read",
        "task:task:write",
        "task:tasklist:read",
        "task:tasklist:write",
        "task:comment:read",
        "task:comment:write",
        "task:attachment:read",
        "task:attachment:write",
      ]
    `);
    expect(new Set(FEISHU_REQUIRED_SCOPES).size).toBe(FEISHU_REQUIRED_SCOPES.length);
  });

  it("rejects Bot registration for a private Agent", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Private Agent", visibility: "private" });

    await expect(
      app.feishuIntegration.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Private Agent · First Tree",
      }),
    ).rejects.toThrow("Feishu Bot binding requires an organization-visible Agent");
    expect(sdkMocks.registerApp).not.toHaveBeenCalled();
    expect(await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid))).toEqual([]);
  });

  it("uses registerApp, encrypts the returned secret, and activates the connected Bot", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.db
      .insert(serverInstances)
      .values({ instanceId: "test-instance", lastHeartbeat: new Date() })
      .onConflictDoNothing();
    const initial = await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });

    expect(initial.registrationUrl).toBe("https://open.feishu.cn/register?code=test");
    expect(sdkMocks.registerApp).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "first-tree",
        createOnly: false,
        appPreset: expect.objectContaining({ name: "Agent A · First Tree" }),
        addons: {
          preset: true,
          scopes: { tenant: [...FEISHU_REQUIRED_SCOPES] },
          events: { items: { tenant: ["im.message.receive_v1"] } },
        },
      }),
    );
    const registrationOptions = sdkMocks.registerApp.mock.calls[0]?.[0];
    expect(registrationOptions?.addons?.scopes).not.toHaveProperty("user");

    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      if (row?.status === "error") {
        throw new Error(`registration failed: ${row.lastErrorCode ?? "unknown"} ${row.lastErrorMessage ?? ""}`);
      }
      return row?.status === "active" && row.botName === "Agent A · First Tree";
    });
    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({
      appId: "cli_created",
      botOpenId: "ou_created_bot",
      botName: "Agent A · First Tree",
      botAvatarUrl: "https://example.com/agent-a.png",
      status: "active",
      connectionStatus: "connected",
      grantedScopes: [...FEISHU_REQUIRED_SCOPES],
      registrationStateCipher: null,
    });
    expect(stored?.appSecretCipher).not.toBe("secret-created-by-feishu");
    expect(stored?.appSecretCipher).toEqual(expect.any(String));
    expect(sdkMocks.createLarkChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "cli_created",
        appSecret: "secret-created-by-feishu",
        includeRawEvent: true,
        policy: { requireMention: false, dmMode: "open", respondToMentionAll: false },
      }),
    );
    expect(sdkMocks.connect).toHaveBeenCalledTimes(1);
    expect(sdkMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", url: "/open-apis/bot/v3/info", signal: expect.any(AbortSignal) }),
    );
    const clientOptions = sdkMocks.createClient.mock.calls[0]?.[0];
    const channelOptions = sdkMocks.createLarkChannel.mock.calls[0]?.[0];
    expect(channelOptions?.logger).toBe(clientOptions?.logger);
    const consoleSpies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    const sensitiveError = Object.assign(new Error('Bearer tenant-secret {"app_secret":"bot-secret"}'), {
      config: { headers: { Authorization: "Bearer tenant-secret" }, data: { app_secret: "bot-secret" } },
    });
    await channelOptions?.logger?.error(sensitiveError);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls).join(" ")).not.toMatch(/tenant-secret|bot-secret/);

    await app.db
      .update(imBotBindings)
      .set({ connectionEpoch: (stored?.connectionEpoch ?? 0) + 1 })
      .where(eq(imBotBindings.id, stored?.id ?? "missing"));
    const staleMessageHandler = sdkMocks.handlers.get("message");
    expect(staleMessageHandler).toBeTypeOf("function");
    await staleMessageHandler?.({ messageId: "om_stale" });
    expect(sdkMocks.addReaction).not.toHaveBeenCalled();
    expect(await app.db.select().from(messages)).toEqual([]);
    const [afterStaleEvent] = await app.db
      .select({ lastEventAt: imBotBindings.lastEventAt })
      .from(imBotBindings)
      .where(eq(imBotBindings.id, stored?.id ?? "missing"));
    expect(afterStaleEvent?.lastEventAt).toBeNull();
    await app.feishuIntegration.revoke(a.agent.uuid);
  });

  it("keeps an active Bot online while reauthorizing the same App", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [before] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    if (!before) throw new Error("expected an active binding");

    vi.clearAllMocks();
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(async (options) => {
      options.onQRCodeReady?.({ url: "https://open.feishu.cn/register?code=update", expireIn: 120 });
      return completion.promise;
    });

    const pending = await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    expect(pending).toMatchObject({
      id: before.id,
      appId: "cli_created",
      botOpenId: "ou_created_bot",
      status: "provisioning",
      connectionStatus: "connected",
      registrationUrl: "https://open.feishu.cn/register?code=update",
    });
    expect(sdkMocks.disconnect).not.toHaveBeenCalled();
    await expect(app.feishuIntegration.getCliGrant(a.agent.uuid)).resolves.toMatchObject({
      binding: { id: before.id },
      appId: "cli_created",
      appSecret: "secret-created-by-feishu",
    });
    await expect(
      app.feishuIntegration.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      }),
    ).rejects.toThrow("already has a Feishu registration in progress");

    completion.resolve({ client_id: "cli_created", client_secret: "refreshed-secret" });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
      return row?.status === "active" && row.connectionStatus === "connected";
    });
    const [updated] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
    expect(updated).toMatchObject({
      id: before.id,
      appId: "cli_created",
      botOpenId: "ou_created_bot",
      status: "active",
      connectionStatus: "connected",
      grantedScopes: [...FEISHU_REQUIRED_SCOPES],
      registrationStateCipher: null,
    });
    expect(sdkMocks.disconnect).toHaveBeenCalledTimes(1);
    expect(sdkMocks.connect).toHaveBeenCalledTimes(1);
    expect(sdkMocks.createLarkChannel).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "cli_created", appSecret: "refreshed-secret" }),
    );
  });

  it("restores the active Bot unchanged when reauthorization fails", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [before] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    if (!before) throw new Error("expected an active binding");

    vi.clearAllMocks();
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(async (options) => {
      options.onQRCodeReady?.({ url: "https://open.feishu.cn/register?code=denied", expireIn: 120 });
      return completion.promise;
    });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });

    completion.reject(new Error("Feishu authorization denied"));
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
      return row?.status === "active" && row.registrationStateCipher === null;
    });
    const [restored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
    expect(restored).toMatchObject({
      id: before.id,
      appId: before.appId,
      appSecretCipher: before.appSecretCipher,
      botOpenId: before.botOpenId,
      status: "active",
      connectionStatus: "connected",
      registrationStateCipher: null,
      registrationExpiresAt: null,
      lastErrorMessage: "Feishu authorization denied",
    });
    expect(sdkMocks.disconnect).not.toHaveBeenCalled();
    expect(sdkMocks.connect).not.toHaveBeenCalled();
  });

  it("detaches old chat mappings only after a replacement App is approved", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });
    const [before] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    if (!before) throw new Error("expected an active binding");
    const chat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const [chatBinding] = await app.db
      .insert(imChatBindings)
      .values({
        id: `chat-binding-${crypto.randomUUID()}`,
        botBindingId: before.id,
        feishuChatId: "oc_old_bot_chat",
        chatId: chat.id,
        feishuChatType: "group",
      })
      .returning();
    if (!chatBinding) throw new Error("expected a chat binding");

    vi.clearAllMocks();
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(async (options) => {
      options.onQRCodeReady?.({ url: "https://open.feishu.cn/register?code=replace", expireIn: 120 });
      return completion.promise;
    });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    const [stillMapped] = await app.db.select().from(imChatBindings).where(eq(imChatBindings.id, chatBinding.id));
    expect(stillMapped?.status).toBe("active");

    sdkMocks.channel.botIdentity = { openId: "ou_replacement_bot" };
    sdkMocks.request.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      bot: { app_name: "Replacement Bot", avatar_url: null, open_id: "ou_replacement_bot" },
    });
    completion.resolve({ client_id: "cli_replacement", client_secret: "replacement-secret" });
    await waitFor(async () => {
      const rows = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return rows.some((row) => row.status === "active" && row.appId === "cli_replacement");
    });
    const rows = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    const revoked = rows.find((row) => row.id === before.id);
    const replaced = rows.find((row) => row.appId === "cli_replacement");
    const [detached] = await app.db.select().from(imChatBindings).where(eq(imChatBindings.id, chatBinding.id));
    expect(revoked).toMatchObject({
      id: before.id,
      status: "revoked",
      appSecretCipher: null,
      connectionStatus: "disconnected",
    });
    expect(replaced).toMatchObject({
      appId: "cli_replacement",
      botOpenId: "ou_replacement_bot",
      botName: "Replacement Bot",
      tenantKey: null,
      status: "active",
    });
    expect(replaced?.id).not.toBe(before.id);
    expect(detached?.status).toBe("detached");
  });

  it("keeps the existing App authoritative when refreshed credentials report a different Bot identity", async () => {
    const state = await prepareExistingBindingWithMapping("same_app_invalid_identity");
    const completion = deferred<{ client_id: string; client_secret: string }>();
    const validationSdk = createIsolatedSdk(async (options) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=identity-mismatch", expireIn: 120 });
      return completion.promise;
    });
    validationSdk.request.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      bot: { app_name: "Unexpected Bot", avatar_url: null, open_id: "ou_unexpected_bot" },
    });
    const manager = createFeishuIntegrationManager({
      db: state.app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: state.app.notifier,
      encryptionKey: state.encryptionKey,
      instanceId: "same-app-validation-manager",
      sdk: validationSdk.sdk,
    });
    await manager.startRegistration({
      agentId: state.a.agent.uuid,
      organizationId: state.a.organizationId,
      displayName: "Agent A · First Tree",
    });
    completion.resolve({ client_id: "cli_existing", client_secret: "identity-mismatch-secret" });
    await waitFor(async () => {
      const [row] = await state.app.db.select().from(imBotBindings).where(eq(imBotBindings.id, state.bindingId));
      return row?.status === "active" && row.registrationStateCipher === null;
    });

    const [binding] = await state.app.db.select().from(imBotBindings).where(eq(imBotBindings.id, state.bindingId));
    const [mapping] = await state.app.db.select().from(imChatBindings).where(eq(imChatBindings.id, state.mapping.id));
    expect(binding).toMatchObject({
      status: "active",
      appId: "cli_existing",
      appSecretCipher: state.oldSecretCipher,
      botOpenId: "ou_created_bot",
      connectionStatus: "connected",
      connectionOwnerInstanceId: "existing-owner",
    });
    expect(mapping?.status).toBe("active");
    expect(validationSdk.sdk.createLarkChannel).not.toHaveBeenCalled();
    expect(validationSdk.disconnect).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("keeps the old binding and mappings when replacement credentials cannot be validated", async () => {
    const state = await prepareExistingBindingWithMapping("replacement_invalid_credentials");
    const completion = deferred<{ client_id: string; client_secret: string }>();
    const validationSdk = createIsolatedSdk(async (options) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=invalid-replacement", expireIn: 120 });
      return completion.promise;
    });
    validationSdk.request.mockRejectedValueOnce(new Error("invalid Feishu App credentials"));
    const manager = createFeishuIntegrationManager({
      db: state.app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: state.app.notifier,
      encryptionKey: state.encryptionKey,
      instanceId: "replacement-validation-manager",
      sdk: validationSdk.sdk,
    });
    await manager.startRegistration({
      agentId: state.a.agent.uuid,
      organizationId: state.a.organizationId,
      displayName: "Agent A · First Tree",
    });
    completion.resolve({ client_id: "cli_invalid_replacement", client_secret: "invalid-secret" });
    await waitFor(async () => {
      const [row] = await state.app.db.select().from(imBotBindings).where(eq(imBotBindings.id, state.bindingId));
      return row?.status === "active" && row.registrationStateCipher === null;
    });

    const bindings = await state.app.db
      .select()
      .from(imBotBindings)
      .where(eq(imBotBindings.agentId, state.a.agent.uuid));
    const [mapping] = await state.app.db.select().from(imChatBindings).where(eq(imChatBindings.id, state.mapping.id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      id: state.bindingId,
      status: "active",
      appId: "cli_existing",
      appSecretCipher: state.oldSecretCipher,
      botOpenId: "ou_created_bot",
      connectionStatus: "connected",
      connectionOwnerInstanceId: "existing-owner",
    });
    expect(mapping?.status).toBe("active");
    expect(validationSdk.sdk.createLarkChannel).not.toHaveBeenCalled();
    expect(validationSdk.disconnect).not.toHaveBeenCalled();
    await manager.stop();
  });

  it("keeps the Bot connected when post-connect profile refresh fails", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    sdkMocks.request
      .mockResolvedValueOnce(DEFAULT_BOT_INFO_RESPONSE)
      .mockRejectedValueOnce(new Error("Feishu Bot info unavailable"));

    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({
      status: "active",
      connectionStatus: "connected",
      botName: "Agent A · First Tree",
      botAvatarUrl: "https://example.com/agent-a.png",
    });
    await app.feishuIntegration.revoke(a.agent.uuid);
  });

  it("uses the owned Bot channel to acknowledge an admitted message", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });

    const messageHandler = sdkMocks.handlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    await messageHandler?.(receivedMessage("acknowledge"));

    await vi.waitFor(() => expect(sdkMocks.addReaction).toHaveBeenCalledWith("om_acknowledge", "Get"));
    expect(await app.db.select().from(messages)).toHaveLength(1);
    await app.feishuIntegration.revoke(a.agent.uuid);
  });

  it("keeps ignored all-group traffic from updating connection activity or creating side effects", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });

    const messageHandler = sdkMocks.handlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    await messageHandler?.({ ...receivedMessage("ignored_group"), chatType: "group", chatId: "oc_unrelated" });

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored?.lastEventAt).toBeNull();
    expect(await app.db.select().from(messages)).toEqual([]);
    expect(await app.db.select().from(imChatBindings)).toEqual([]);
    expect(sdkMocks.addReaction).not.toHaveBeenCalled();
    await app.feishuIntegration.revoke(a.agent.uuid);
  });

  it("accepts a group reply when the provider identifies the Bot by open_bot_id beside an App id", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });

    const messageHandler = sdkMocks.handlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    const chatId = "oc_direct_reply";
    await messageHandler?.({
      ...receivedMessage("activate_reply"),
      chatType: "group",
      chatId,
      mentionedBot: true,
      mentions: [{ key: "@_user_1", openId: "ou_created_bot", name: "Bot", isBot: true }],
    });

    sdkMocks.request.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      data: {
        items: [
          {
            chat_id: chatId,
            sender: {
              id: "cli_created",
              id_type: "app_id",
              sender_type: "app",
              open_bot_id: "ou_created_bot",
            },
          },
        ],
      },
    });
    await messageHandler?.({
      ...receivedMessage("direct_reply"),
      chatType: "group",
      chatId,
      replyToMessageId: "om_bot_parent",
    });

    expect(await app.db.select().from(messages)).toHaveLength(2);
    expect(sdkMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/im/v1/messages/om_bot_parent",
        signal: expect.any(AbortSignal),
      }),
    );
    await app.feishuIntegration.revoke(a.agent.uuid);
  });

  it("bounds acknowledgement reactions when provider calls never settle", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    sdkMocks.addReaction.mockImplementation(() => new Promise<string>(() => undefined));
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });

    const messageHandler = sdkMocks.handlers.get("message");
    expect(messageHandler).toBeTypeOf("function");
    for (let index = 0; index < 20; index += 1) {
      await messageHandler?.(receivedMessage(`bounded_${index}`));
    }

    await vi.waitFor(() => expect(sdkMocks.addReaction).toHaveBeenCalledTimes(16));
    expect(await app.db.select().from(messages)).toHaveLength(20);
    await app.feishuIntegration.revoke(a.agent.uuid);
  });

  it("maintains the provisioning lease while connection and Bot profile enrichment are pending", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    // This test drives its own manager with accelerated lease timings. Pause
    // the app-owned manager so its background cleanup cannot satisfy the
    // shared disconnect spy or compete for the test binding.
    await app.feishuIntegration.stop();
    vi.clearAllMocks();
    const connectStarted = deferred<void>();
    const connectCompletion = deferred<void>();
    sdkMocks.connect.mockImplementationOnce(() => {
      connectStarted.resolve();
      return connectCompletion.promise;
    });
    sdkMocks.request
      .mockResolvedValueOnce(DEFAULT_BOT_INFO_RESPONSE)
      .mockImplementationOnce(() => new Promise(() => undefined));
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "profile-timeout-test",
      sdk: feishuSdk,
      timings: {
        initialClaimDelayMs: 60_000,
        claimIntervalMs: 20,
        leaseMs: 500,
        botProfileTimeoutMs: 80,
      },
    });
    manager.start();
    try {
      await manager.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      });
      await connectStarted.promise;
      const [provisioning] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      expect(provisioning).toMatchObject({
        status: "provisioning",
        connectionStatus: "connecting",
        connectionOwnerInstanceId: "profile-timeout-test",
      });
      if (!provisioning?.connectionLeaseExpiresAt) throw new Error("expected the provisioning lease");
      const initialLeaseExpiry = provisioning.connectionLeaseExpiresAt.getTime();

      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, provisioning.id));
        return (
          sdkMocks.disconnect.mock.calls.length > 0 ||
          (row?.connectionLeaseExpiresAt?.getTime() ?? 0) > initialLeaseExpiry
        );
      });
      const [renewed] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, provisioning.id));
      expect(renewed?.connectionLeaseExpiresAt?.getTime()).toBeGreaterThan(initialLeaseExpiry);
      expect(sdkMocks.disconnect).not.toHaveBeenCalled();

      connectCompletion.resolve();
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
        return row?.status === "active" && row.connectionStatus === "connected";
      });

      const [maintained] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      expect(maintained).toMatchObject({
        status: "active",
        connectionStatus: "connected",
        connectionOwnerInstanceId: "profile-timeout-test",
        botName: "Agent A · First Tree",
      });
      expect(sdkMocks.createLarkChannel).toHaveBeenCalledTimes(1);
      expect(sdkMocks.disconnect).not.toHaveBeenCalled();
    } finally {
      connectCompletion.resolve();
      await new Promise((resolve) => setTimeout(resolve, 70));
      try {
        await manager.stop();
        if (await manager.getBinding(a.agent.uuid)) await manager.revoke(a.agent.uuid);
      } finally {
        app.feishuIntegration.start();
      }
    }
  });

  it("lets a second replica take over an expired lease with a higher fencing epoch", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const bindingId = `binding-${crypto.randomUUID()}`;
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await app.db.insert(imBotBindings).values({
      id: bindingId,
      organizationId: a.organizationId,
      agentId: a.agent.uuid,
      appId: "cli_takeover",
      botOpenId: "ou_created_bot",
      appSecretCipher: encryptCredentials({ appSecret: "secret-created-by-feishu" }, encryptionKey),
      status: "active",
      connectionStatus: "connected",
      connectionOwnerInstanceId: "retired-replica",
      connectionLeaseExpiresAt: new Date(Date.now() - 1_000),
      connectionEpoch: 7,
    });

    const replica = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "replacement-replica",
      sdk: feishuSdk,
      timings: { initialClaimDelayMs: 1, claimIntervalMs: 60_000, leaseMs: 10_000 },
    });
    replica.start();
    try {
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId));
        return row?.connectionOwnerInstanceId === "replacement-replica" && row.connectionStatus === "connected";
      });
      const [claimed] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId));
      expect(claimed).toMatchObject({
        connectionOwnerInstanceId: "replacement-replica",
        connectionEpoch: 8,
        connectionStatus: "connected",
      });
      expect(claimed?.connectionLeaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await replica.stop();
    }
  });

  it("keeps a pending reauthorization intact when another replica takes over the expired Bot lease", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    let registrationCall = 0;
    const firstReplicaSdk = createIsolatedSdk(async (options) => {
      options.onQRCodeReady({
        url: `https://open.feishu.cn/register?code=replica-${registrationCall}`,
        expireIn: 120,
      });
      registrationCall += 1;
      if (registrationCall === 1) return { client_id: "cli_existing", client_secret: "old-secret" };
      return completion.promise;
    });
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const firstReplica = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "reauth-first-replica",
      sdk: firstReplicaSdk.sdk,
      timings: { leaseMs: 40, initialClaimDelayMs: 60_000, claimIntervalMs: 60_000 },
    });
    const secondReplicaSdk = createIsolatedSdk(async () => ({
      client_id: "unused",
      client_secret: "unused",
    }));
    const secondReplica = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "reauth-second-replica",
      sdk: secondReplicaSdk.sdk,
      timings: { leaseMs: 10_000, initialClaimDelayMs: 1, claimIntervalMs: 60_000 },
    });

    try {
      await firstReplica.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      });
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
        return row?.status === "active";
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const pending = await firstReplica.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      });
      expect(pending).toMatchObject({ status: "provisioning", connectionStatus: "connected" });
      const pendingCipher = (
        await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid))
      )[0]?.registrationStateCipher;
      await new Promise((resolve) => setTimeout(resolve, 60));

      secondReplica.start();
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
        return row?.connectionOwnerInstanceId === "reauth-second-replica" && row.connectionStatus === "connected";
      });
      const [takenOver] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      expect(takenOver).toMatchObject({
        status: "provisioning",
        connectionStatus: "connected",
        connectionOwnerInstanceId: "reauth-second-replica",
        registrationStateCipher: pendingCipher,
      });
      expect(takenOver?.registrationExpiresAt).toBeInstanceOf(Date);

      completion.reject(new Error("authorization cancelled after takeover"));
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
        return row?.status === "active" && row.registrationStateCipher === null;
      });
    } finally {
      completion.reject(new Error("test cleanup"));
      await firstReplica.stop();
      await secondReplica.stop();
    }
  });

  it("recovers an expired reauthorization after its provider worker is lost", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const bindingId = `binding-${crypto.randomUUID()}`;
    await app.db.insert(imBotBindings).values({
      id: bindingId,
      organizationId: a.organizationId,
      agentId: a.agent.uuid,
      appId: "cli_existing",
      appSecretCipher: encryptCredentials({ appSecret: "old-secret" }, encryptionKey),
      botOpenId: "ou_created_bot",
      status: "provisioning",
      connectionStatus: "connected",
      connectionOwnerInstanceId: "lost-provider-worker",
      connectionLeaseExpiresAt: new Date(Date.now() - 1_000),
      connectionEpoch: 4,
      registrationStateCipher: encryptCredentials({ phase: "starting" }, encryptionKey),
      registrationExpiresAt: new Date(Date.now() - 1_000),
    });
    const recoverySdk = createIsolatedSdk(async () => ({ client_id: "unused", client_secret: "unused" }));
    const recovery = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "reauth-recovery-replica",
      sdk: recoverySdk.sdk,
      timings: { leaseMs: 10_000, initialClaimDelayMs: 1, claimIntervalMs: 60_000 },
    });
    recovery.start();
    try {
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId));
        return (
          row?.status === "active" &&
          row.connectionStatus === "connected" &&
          row.connectionOwnerInstanceId === "reauth-recovery-replica"
        );
      });
      const [restored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, bindingId));
      expect(restored).toMatchObject({
        status: "active",
        connectionStatus: "connected",
        registrationStateCipher: null,
        registrationExpiresAt: null,
        connectionOwnerInstanceId: "reauth-recovery-replica",
        connectionEpoch: 5,
      });
    } finally {
      await recovery.stop();
    }
  });

  it("leaves a credential commit fenced and claimable when the registration replica stops before reconnecting", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    let registrationCall = 0;
    const registrationSdk = createIsolatedSdk(async (options) => {
      options.onQRCodeReady({ url: `https://open.feishu.cn/register?code=commit-${registrationCall}`, expireIn: 120 });
      registrationCall += 1;
      return registrationCall === 1
        ? { client_id: "cli_existing", client_secret: "old-secret" }
        : { client_id: "cli_existing", client_secret: "refreshed-secret" };
    });
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let injectFailure = false;
    const registrationReplica = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "credential-commit-replica",
      sdk: registrationSdk.sdk,
      timings: { initialClaimDelayMs: 60_000, claimIntervalMs: 60_000 },
      testHooks: {
        afterCredentialCommit: async () => {
          if (injectFailure) throw new Error("simulated process loss after credential commit");
        },
      },
    });
    await registrationReplica.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [before] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    if (!before) throw new Error("expected an active binding");

    injectFailure = true;
    await registrationReplica.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
      return row?.status === "provisioning" && row.registrationStateCipher === null;
    });
    const [committed] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
    expect(committed).toMatchObject({
      status: "provisioning",
      connectionStatus: "disconnected",
      connectionOwnerInstanceId: null,
      connectionLeaseExpiresAt: null,
      registrationStateCipher: null,
    });
    expect(committed?.connectionEpoch).toBeGreaterThan(before.connectionEpoch);

    const recoverySdk = createIsolatedSdk(async () => ({ client_id: "unused", client_secret: "unused" }));
    const recoveryReplica = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "credential-recovery-replica",
      sdk: recoverySdk.sdk,
      timings: { leaseMs: 10_000, initialClaimDelayMs: 1, claimIntervalMs: 60_000 },
    });
    recoveryReplica.start();
    try {
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
        return row?.status === "active" && row.connectionOwnerInstanceId === "credential-recovery-replica";
      }, 5_000);
      expect(recoverySdk.sdk.createLarkChannel).toHaveBeenCalledWith(
        expect.objectContaining({ appId: "cli_existing", appSecret: "refreshed-secret" }),
      );
    } finally {
      await registrationReplica.stop();
      await recoveryReplica.stop();
    }
  });

  it("does not let a late registration success revive a revoked binding", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(
      async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=late", expireIn: 120 });
        return completion.promise;
      },
    );

    const initial = await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    expect(initial.registrationUrl).toContain("code=late");

    await app.feishuIntegration.revoke(a.agent.uuid);
    completion.resolve({ client_id: "cli_late", client_secret: "late-secret" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({
      status: "revoked",
      appId: null,
      appSecretCipher: null,
      registrationStateCipher: null,
    });
    expect(sdkMocks.createLarkChannel).not.toHaveBeenCalled();
  });

  it("settles a registration revoked before QR even when the provider ignores abort", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(async () => completion.promise);

    const pending = app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db
        .select({ id: imBotBindings.id })
        .from(imBotBindings)
        .where(eq(imBotBindings.agentId, a.agent.uuid));
      return Boolean(row);
    });

    const rejected = expect(pending).rejects.toThrow("Feishu registration was revoked");
    await app.feishuIntegration.revoke(a.agent.uuid);
    await rejected;
    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({ status: "revoked", registrationStateCipher: null });
  });

  it("settles a registration stopped before QR even when the provider ignores abort", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    const stoppedSdk = {
      ...feishuSdk,
      registerApp: vi.fn(async () => completion.promise),
    } as FeishuSdkDependencies;
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "registration-stop-test",
      sdk: stoppedSdk,
    });

    const pending = manager.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db
        .select({ id: imBotBindings.id })
        .from(imBotBindings)
        .where(eq(imBotBindings.agentId, a.agent.uuid));
      return Boolean(row);
    });

    const rejected = expect(pending).rejects.toThrow("Feishu integration manager stopped");
    await manager.stop();
    await rejected;
    completion.resolve({ client_id: "cli_after_stop", client_secret: "late-secret" });
  });

  it("does not let a late registration failure overwrite a revoked binding", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(
      async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=late-failure", expireIn: 120 });
        return completion.promise;
      },
    );

    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await app.feishuIntegration.revoke(a.agent.uuid);
    completion.reject(new Error("provider failed after revoke"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({ status: "revoked", lastErrorCode: null, lastErrorMessage: null });
  });

  it("hides a live registration URL from an org-visible non-manager", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    sdkMocks.registerApp.mockImplementationOnce(
      async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=manager-only", expireIn: 120 });
        return completion.promise;
      },
    );
    await app.feishuIntegration.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });

    const viewer = await createTestAdmin(app, { username: `viewer-${crypto.randomUUID().slice(0, 8)}` });
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, viewer.memberId));
    const visible = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${a.agent.uuid}/feishu-binding`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json<{ binding: { registrationUrl: string | null } }>().binding.registrationUrl).toBeNull();

    const manager = await a.request("GET", `/api/v1/agents/${a.agent.uuid}/feishu-binding`);
    expect(manager.statusCode).toBe(200);
    expect(manager.json<{ binding: { registrationUrl: string | null } }>().binding.registrationUrl).toContain(
      "manager-only",
    );

    await app.feishuIntegration.revoke(a.agent.uuid);
    completion.resolve({ client_id: "cli_late", client_secret: "late-secret" });
  });

  it("aborts a QR registration timeout and ignores late provider callbacks", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    let providerSignal: AbortSignal | undefined;
    const timeoutSdk = {
      ...feishuSdk,
      registerApp: vi.fn(async (options: { signal: AbortSignal }) => {
        providerSignal = options.signal;
        return completion.promise;
      }),
    } as FeishuSdkDependencies;
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "registration-timeout-test",
      sdk: timeoutSdk,
      timings: { registrationQrTimeoutMs: 10 },
    });

    await expect(
      manager.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      }),
    ).rejects.toThrow("Timed out waiting for Feishu registration QR code");
    expect(providerSignal?.aborted).toBe(true);

    completion.resolve({ client_id: "cli_after_timeout", client_secret: "late-secret" });
    // The request rejects synchronously at the QR timeout, but the DB
    // terminal transition is launched fire-and-forget
    // (`void transitionCurrentAttemptToError(...)`): poll the database
    // postcondition instead of sleeping a fixed interval and hoping the
    // transition landed.
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "error";
    });
    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({ status: "error", appId: null, appSecretCipher: null });
  });

  it("rejects a QR callback that arrives after timeout while the provider stays pending", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    let onQRCodeReady: ((value: { url: string; expireIn: number }) => void) | undefined;
    const timeoutSdk = {
      ...feishuSdk,
      registerApp: vi.fn(async (options: { onQRCodeReady: (value: { url: string; expireIn: number }) => void }) => {
        onQRCodeReady = options.onQRCodeReady;
        return completion.promise;
      }),
    } as FeishuSdkDependencies;
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "registration-late-qr-test",
      sdk: timeoutSdk,
      timings: { registrationQrTimeoutMs: 10 },
    });

    await expect(
      manager.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      }),
    ).rejects.toThrow("Timed out waiting for Feishu registration QR code");
    onQRCodeReady?.({ url: "https://open.feishu.cn/register?code=too-late", expireIn: 120 });
    // Same async boundary: the QR timeout rejects the request now, while
    // the row's terminal transition settles afterwards. Poll the database
    // postcondition (error state with the stale URL cleared) rather than
    // assuming a fixed sleep is enough.
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "error" && row.registrationExpiresAt === null;
    });

    const [stored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    expect(stored).toMatchObject({ status: "error", registrationExpiresAt: null });
  });

  it("restores an existing Bot after a starting-stage timeout and ignores late provider completion", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    let registrationCall = 0;
    let lateQr: ((value: { url: string; expireIn: number }) => void) | undefined;
    const timeoutSdk = createIsolatedSdk(async (options) => {
      registrationCall += 1;
      if (registrationCall === 1) {
        options.onQRCodeReady({ url: "https://open.feishu.cn/register?code=initial", expireIn: 120 });
        return { client_id: "cli_existing", client_secret: "old-secret" };
      }
      lateQr = options.onQRCodeReady;
      return completion.promise;
    });
    const manager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      instanceId: "reauth-start-timeout-test",
      sdk: timeoutSdk.sdk,
      timings: { registrationQrTimeoutMs: 100 },
    });
    await manager.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });
    // Activation is persisted before the registration worker removes its
    // in-memory entry; let that finalizer run before starting reauthorization.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [before] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    if (!before) throw new Error("expected an active binding");

    await expect(
      manager.startRegistration({
        agentId: a.agent.uuid,
        organizationId: a.organizationId,
        displayName: "Agent A · First Tree",
      }),
    ).rejects.toThrow("Timed out waiting for Feishu registration QR code");
    lateQr?.({ url: "https://open.feishu.cn/register?code=too-late-update", expireIn: 120 });
    completion.resolve({ client_id: "cli_existing", client_secret: "late-secret" });
    // The QR timeout rejects the request synchronously, but the restore of
    // the pre-existing binding is an async fire-and-forget transition
    // (`void transitionCurrentAttemptToError(...)`): poll the database
    // postcondition instead of asserting after a fixed sleep.
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
      return (
        row?.status === "active" &&
        row.connectionStatus === "connected" &&
        row.registrationStateCipher === null &&
        row.registrationExpiresAt === null
      );
    });

    const [restored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
    expect(restored).toMatchObject({
      status: "active",
      connectionStatus: "connected",
      appId: before.appId,
      appSecretCipher: before.appSecretCipher,
      registrationStateCipher: null,
      registrationExpiresAt: null,
    });
    expect(timeoutSdk.connect).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("ignores provider completion after a pending reauthorization expires", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A", visibility: "organization" });
    const completion = deferred<{ client_id: string; client_secret: string }>();
    let registrationCall = 0;
    const registrationSdk = createIsolatedSdk(async (options) => {
      registrationCall += 1;
      options.onQRCodeReady({
        url: `https://open.feishu.cn/register?code=expiry-${registrationCall}`,
        expireIn: 120,
      });
      return registrationCall === 1 ? { client_id: "cli_existing", client_secret: "old-secret" } : completion.promise;
    });
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const registrationManager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "reauth-expiry-registration",
      sdk: registrationSdk.sdk,
    });
    await registrationManager.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await waitFor(async () => {
      const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
      return row?.status === "active";
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const [before] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.agentId, a.agent.uuid));
    if (!before) throw new Error("expected an active binding");

    await registrationManager.startRegistration({
      agentId: a.agent.uuid,
      organizationId: a.organizationId,
      displayName: "Agent A · First Tree",
    });
    await app.db
      .update(imBotBindings)
      .set({ registrationExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(imBotBindings.id, before.id));

    const recoveryManager = createFeishuIntegrationManager({
      db: app.db,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
      notifier: app.notifier,
      encryptionKey,
      instanceId: "reauth-expiry-recovery",
      sdk: createIsolatedSdk(async () => ({ client_id: "unused", client_secret: "unused" })).sdk,
      timings: { initialClaimDelayMs: 1, claimIntervalMs: 60_000 },
    });
    recoveryManager.start();
    try {
      await waitFor(async () => {
        const [row] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
        return row?.status === "active" && row.registrationStateCipher === null;
      });
      completion.resolve({ client_id: "cli_existing", client_secret: "late-secret" });
      await new Promise((resolve) => setTimeout(resolve, 25));

      const [restored] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, before.id));
      expect(restored).toMatchObject({
        status: "active",
        appId: before.appId,
        appSecretCipher: before.appSecretCipher,
        registrationStateCipher: null,
        registrationExpiresAt: null,
      });
      expect(registrationSdk.connect).toHaveBeenCalledTimes(1);
    } finally {
      completion.reject(new Error("test cleanup"));
      await recoveryManager.stop();
      await registrationManager.stop();
    }
  });

  it("does not let a superseded attempt's late success consume the current attempt", async () => {
    const state = await prepareSupersededReauthorization("late-success-fence");
    try {
      state.firstCompletion.resolve({ client_id: "cli_existing", client_secret: "stale-secret" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const [current] = await state.app.db.select().from(imBotBindings).where(eq(imBotBindings.id, state.bindingId));
      expect(current).toMatchObject({
        status: "provisioning",
        appSecretCipher: state.oldSecretCipher,
        registrationStateCipher: state.secondAttemptCipher,
        registrationExpiresAt: state.secondAttemptExpiresAt,
      });
    } finally {
      state.secondCompletion.reject(new Error("test cleanup"));
      await waitFor(async () => {
        const [row] = await state.app.db.select().from(imBotBindings).where(eq(imBotBindings.id, state.bindingId));
        return row?.status === "active" && row.registrationStateCipher === null;
      });
      await state.firstManager.stop();
      await state.secondManager.stop();
    }
  });

  it("does not let a superseded attempt's late failure clear the current attempt", async () => {
    const state = await prepareSupersededReauthorization("late-failure-fence");
    try {
      state.firstCompletion.reject(new Error("stale authorization failure"));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const [current] = await state.app.db.select().from(imBotBindings).where(eq(imBotBindings.id, state.bindingId));
      expect(current).toMatchObject({
        status: "provisioning",
        appSecretCipher: state.oldSecretCipher,
        registrationStateCipher: state.secondAttemptCipher,
        registrationExpiresAt: state.secondAttemptExpiresAt,
      });
    } finally {
      state.secondCompletion.reject(new Error("test cleanup"));
      await waitFor(async () => {
        const [row] = await state.app.db.select().from(imBotBindings).where(eq(imBotBindings.id, state.bindingId));
        return row?.status === "active" && row.registrationStateCipher === null;
      });
      await state.firstManager.stop();
      await state.secondManager.stop();
    }
  });
});
