import { Client, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/connection.js";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import * as mappingService from "./adapter-mapping.js";
import { decryptCredentials } from "./crypto.js";
import type { FeishuBotCredentials, InboundEvent } from "./feishu/types.js";
import { sendMessage } from "./message.js";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];

/**
 * Temporarily clear proxy env vars while running a callback.
 * The Lark SDK's internal HTTP client (axios) reads proxy env vars
 * but does not respect NO_PROXY, causing connection failures behind proxies.
 * Other code that needs the proxy is unaffected — vars are restored immediately.
 */
async function withoutProxy<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      saved[key] = val;
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      process.env[key] = val;
    }
  }
}

const OUTBOUND_BATCH_SIZE = 10;

type ManagedBot = {
  configId: number;
  /** Track updatedAt to detect credential/setting changes on same config row. */
  configUpdatedAt: string;
  appId: string;
  /** The agent bound to this bot via adapter_configs.agentId (required). */
  agentId: string;
  /** Whether to clear proxy env vars for SDK API calls (Lark SDK ignores NO_PROXY). */
  bypassProxy: boolean;
  client: InstanceType<typeof Client>;
  wsClient: WSClient;
  /** Timestamp of the last successful inbound or outbound activity. */
  lastActiveAt: Date | null;
};

/** Wrap an SDK API call with proxy bypass if needed. */
function botApiCall<T>(bot: ManagedBot, fn: () => Promise<T>): Promise<T> {
  return bot.bypassProxy ? withoutProxy(fn) : fn();
}

export type BotStatus = {
  configId: number;
  platform: string;
  agentId: string;
  appId: string;
  connected: boolean;
  lastActiveAt: string | null;
};

export type AdapterManager = {
  /** Load active adapter configs and start/stop WS connections. */
  reload(): Promise<void>;
  /** Process pending outbound messages for feishu-bound human agents. */
  processOutbound(): Promise<{ sent: number; errors: number }>;
  /** Edit an already-sent message on external platforms. */
  editOutboundMessage(messageId: string, format: string, content: unknown): Promise<boolean>;
  /** Get connection status for all managed bots. */
  getBotStatuses(): BotStatus[];
  /** Stop all WS connections. */
  shutdown(): void;
};

/**
 * Manages Feishu adapter bot instances using the official Lark SDK.
 * - Inbound: WSClient receives events via WebSocket (no public URL needed)
 * - Outbound: SDK Client sends messages via Feishu API
 *
 * Adapter is a service, not an agent — no adapter agents are created.
 */
export function createAdapterManager(
  db: Database,
  encryptionKey: string | undefined,
  log: FastifyBaseLogger,
): AdapterManager {
  const bots = new Map<string, ManagedBot>();

  /** Find a managed bot by its bound agentId. */
  function findBotByAgentId(agentId: string): ManagedBot | undefined {
    for (const bot of bots.values()) {
      if (bot.agentId === agentId) return bot;
    }
    return undefined;
  }

  /** Handle an inbound message event from Feishu WebSocket. */
  async function handleInboundEvent(appId: string, data: Record<string, unknown>): Promise<void> {
    try {
      const event = parseEventData(appId, data);
      if (!event) return;

      // Deduplicate
      const isNew = await mappingService.claimEvent(db, event.eventId, "feishu");
      if (!isNew) return;

      // Skip bot messages (avoid echo)
      if (event.senderType === "bot") return;

      const bot = bots.get(appId);
      if (!bot) return;

      try {
        await processInboundMessage(db, event, bot, log);
        bot.lastActiveAt = new Date();
      } catch (err) {
        // Unclaim the event so it can be retried on next delivery
        await mappingService.unclaimEvent(db, event.eventId, "feishu");
        throw err;
      }
    } catch (err) {
      log.error({ appId, err }, "Failed to handle inbound Feishu event");
    }
  }

  return {
    async reload() {
      if (!encryptionKey) {
        log.warn("ADAPTER_ENCRYPTION_KEY not set — adapter manager disabled");
        return;
      }

      const configs = await db.select().from(adapterConfigs).where(eq(adapterConfigs.status, "active"));
      const seen = new Set<string>();

      for (const config of configs) {
        if (config.platform !== "feishu" || !config.credentials) continue;

        let creds: FeishuBotCredentials;
        try {
          creds = decryptCredentials(config.credentials as string, encryptionKey) as FeishuBotCredentials;
        } catch (err) {
          log.error({ configId: config.id, err }, "Failed to decrypt adapter credentials");
          continue;
        }

        const appId = creds.app_id;
        seen.add(appId);

        // Skip if already running with same config version (detect credential changes)
        const configVersion = config.updatedAt.toISOString();
        const existing = bots.get(appId);
        if (existing && existing.configId === config.id && existing.configUpdatedAt === configVersion) continue;

        // Stop old connection if config changed
        if (existing) {
          existing.wsClient.close({ force: true });
          log.info({ appId }, "Stopped old Feishu WS connection (config changed)");
        }

        // bypass_proxy defaults to true (Lark SDK ignores NO_PROXY — known bug)
        const bypassProxy = creds.bypass_proxy !== false;
        const wrap = bypassProxy ? withoutProxy : <T>(fn: () => Promise<T>) => fn();

        // Create SDK client for outbound API calls
        const client = await wrap(() => Promise.resolve(new Client({ appId, appSecret: creds.app_secret })));

        // Create WSClient for inbound events
        const eventDispatcher = new EventDispatcher({}).register({
          "im.message.receive_v1": async (data: Record<string, unknown>) => {
            await handleInboundEvent(appId, data);
          },
        });

        const wsClient = await wrap(async () => {
          const ws = new WSClient({
            appId,
            appSecret: creds.app_secret,
            loggerLevel: LoggerLevel.warn,
            autoReconnect: true,
          });
          await ws.start({ eventDispatcher });
          return ws;
        });

        bots.set(appId, {
          configId: config.id,
          configUpdatedAt: configVersion,
          appId,
          agentId: config.agentId,
          bypassProxy,
          client,
          wsClient,
          lastActiveAt: null,
        });

        log.info({ appId, configId: config.id, agentId: config.agentId }, "Started Feishu adapter bot (WebSocket)");
      }

      // Stop bots that are no longer active
      for (const [appId, bot] of bots) {
        if (!seen.has(appId)) {
          bot.wsClient.close({ force: true });
          bots.delete(appId);
          log.info({ appId }, "Stopped inactive Feishu adapter bot");
        }
      }
    },

    async processOutbound() {
      if (bots.size === 0) return { sent: 0, errors: 0 };

      try {
        return await processFeishuOutbound(db, findBotByAgentId, log);
      } catch (err) {
        log.error({ err }, "Feishu outbound processing error");
        return { sent: 0, errors: 1 };
      }
    },

    async editOutboundMessage(messageId: string, format: string, content: unknown): Promise<boolean> {
      const ref = await mappingService.findExternalMessageByInternalId(db, "feishu", messageId);
      if (!ref) return false;

      // Find which bot sent this message — look up the original message sender
      const [msg] = await db
        .select({ senderId: messages.senderId })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1);
      if (!msg) return false;

      const bot = findBotByAgentId(msg.senderId);
      if (!bot) return false;

      const { content: feishuContent } = formatForFeishu(format, content);

      try {
        await botApiCall(bot, () =>
          bot.client.im.v1.message.patch({
            path: { message_id: ref.externalMessageId },
            data: { content: feishuContent },
          }),
        );
        return true;
      } catch (err) {
        log.warn(
          { messageId, externalMessageId: ref.externalMessageId, err },
          "Failed to edit outbound Feishu message",
        );
        return false;
      }
    },

    getBotStatuses() {
      const statuses: BotStatus[] = [];
      for (const bot of bots.values()) {
        statuses.push({
          configId: bot.configId,
          platform: "feishu",
          agentId: bot.agentId,
          appId: bot.appId,
          connected: bots.has(bot.appId),
          lastActiveAt: bot.lastActiveAt?.toISOString() ?? null,
        });
      }
      return statuses;
    },

    shutdown() {
      for (const [appId, bot] of bots) {
        bot.wsClient.close({ force: true });
        log.info({ appId }, "Shut down Feishu WS connection");
      }
      bots.clear();
    },
  };
}

// ── Inbound helpers ─────────────────────────────────────────────────

/** Parse SDK event data into our normalized InboundEvent. */
function parseEventData(appId: string, data: Record<string, unknown>): InboundEvent | null {
  // The SDK's EventDispatcher delivers the event.event payload directly
  const sender = data.sender as { sender_id?: Record<string, string>; sender_type?: string } | undefined;
  const message = data.message as Record<string, unknown> | undefined;

  if (!sender?.sender_id?.open_id || !message) return null;

  const eventId = (data.event_id as string) ?? `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse((message.content as string) ?? "{}");
  } catch {
    parsedContent = { text: message.content };
  }

  const mentions = Array.isArray(message.mentions)
    ? (message.mentions as Array<{ key: string; id: { open_id: string }; name: string }>).map((m) => ({
        key: m.key,
        openId: m.id.open_id,
        name: m.name,
      }))
    : [];

  return {
    eventId,
    platform: "feishu",
    appId,
    senderId: sender.sender_id.open_id,
    senderType: sender.sender_type ?? "user",
    externalChannelId: (message.chat_id as string) ?? "",
    chatType: (message.chat_type as string) ?? "group",
    messageId: (message.message_id as string) ?? "",
    messageType: (message.message_type as string) ?? "text",
    content: parsedContent,
    threadId: (message.root_id as string) || null,
    mentions,
    timestamp: (message.create_time as string) ?? "",
  };
}

async function processInboundMessage(
  db: Database,
  event: InboundEvent,
  bot: ManagedBot,
  log: FastifyBaseLogger,
): Promise<void> {
  // 1. Resolve sender → internal agent
  const agentMapping = await mappingService.findAgentByExternalUser(db, "feishu", event.senderId);

  if (!agentMapping) {
    // Unknown user — reply with binding prompt, do not create agent
    await replyUnknownUser(bot, event, log);
    return;
  }

  const senderAgentId = agentMapping.agentId;

  // 2. Resolve chat → internal chat (auto-create if needed)
  //    Use bot.agentId (from adapter_configs) as the chat participant, not an adapter agent
  const chatId = await mappingService.findOrCreateChatForChannel(db, {
    platform: "feishu",
    externalChannelId: event.externalChannelId,
    threadId: event.threadId,
    chatType: event.chatType,
    botAgentId: bot.agentId,
    senderAgentId,
  });

  // 3. Send message into internal system
  const content =
    typeof event.content === "object" && event.content !== null && "text" in event.content
      ? (event.content as { text: string }).text
      : JSON.stringify(event.content);

  const msg = await sendMessage(db, chatId, senderAgentId, {
    format: event.messageType === "text" ? "text" : "card",
    content: event.messageType === "text" ? content : event.content,
    metadata: {
      source: "feishu",
      externalMessageId: event.messageId,
      externalChannelId: event.externalChannelId,
      messageType: event.messageType,
    },
  });

  // 4. Store message reference
  await mappingService.createMessageReference(db, {
    messageId: msg.id,
    platform: "feishu",
    externalMessageId: event.messageId,
    externalChannelId: event.externalChannelId,
  });

  log.info({ appId: bot.appId, chatId, messageId: msg.id }, "Processed inbound Feishu message");
}

/** Reply to unknown (unbound) user with binding instructions. */
async function replyUnknownUser(bot: ManagedBot, event: InboundEvent, log: FastifyBaseLogger): Promise<void> {
  const text = [
    "Your account is not linked to Agent Hub yet.",
    "Please contact your admin to set up the binding.",
    `Your user ID: ${event.senderId}`,
  ].join("\n");

  try {
    await botApiCall(bot, () =>
      bot.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: event.externalChannelId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      }),
    );
  } catch (err) {
    log.warn({ senderId: event.senderId, err }, "Failed to send unknown-user reply");
  }
}

// ── Outbound helpers ────────────────────────────────────────────────

/**
 * Process outbound messages for all feishu-bound human agents.
 * Consumes pending inbox entries for human agents that have feishu platform bindings,
 * then sends via the message sender's bound bot.
 */
async function processFeishuOutbound(
  db: Database,
  findBotByAgentId: (agentId: string) => ManagedBot | undefined,
  log: FastifyBaseLogger,
): Promise<{ sent: number; errors: number }> {
  let sent = 0;
  let errorCount = 0;

  // Claim pending inbox entries for feishu-bound human agents
  const claimed = await db.execute<{
    id: number;
    inbox_id: string;
    message_id: string;
    chat_id: string | null;
  }>(sql`
    UPDATE inbox_entries
    SET status = 'delivered', delivered_at = NOW()
    WHERE id IN (
      SELECT ie.id FROM inbox_entries ie
      JOIN agents a ON ie.inbox_id = a.inbox_id
      JOIN adapter_agent_mappings aam ON a.id = aam.agent_id
      WHERE aam.platform = 'feishu' AND ie.status = 'pending'
      ORDER BY ie.created_at
      LIMIT ${OUTBOUND_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, inbox_id, message_id, chat_id
  `);

  // Dedup: when a chat has multiple feishu-bound humans, the same message
  // produces multiple inbox entries. We only send once per (message, channel).
  const sentMessages = new Set<string>();

  for (const entry of claimed) {
    try {
      const [msg] = await db.select().from(messages).where(eq(messages.id, entry.message_id)).limit(1);

      if (!msg) {
        await ackEntry(db, entry.id);
        continue;
      }

      // Skip inbound messages that originated from Feishu (avoid echo)
      const meta = msg.metadata as Record<string, unknown> | null;
      if (meta?.source === "feishu") {
        await ackEntry(db, entry.id);
        continue;
      }

      const chatId = entry.chat_id ?? msg.chatId;
      const channelMapping = await mappingService.findExternalChannelByChat(db, "feishu", chatId);
      if (!channelMapping) {
        await ackEntry(db, entry.id);
        continue;
      }

      // Dedup: skip if this message was already sent to this channel
      const dedupKey = `${msg.id}:${channelMapping.externalChannelId}`;
      if (sentMessages.has(dedupKey)) {
        await ackEntry(db, entry.id);
        continue;
      }

      // Find the sender's bot (the agent who sent the message must have a feishu bot binding)
      const bot = findBotByAgentId(msg.senderId);
      if (!bot) {
        // Sender has no feishu bot — cannot deliver to external platform
        log.warn({ messageId: msg.id, senderId: msg.senderId }, "Outbound skip: sender has no feishu bot binding");
        await ackEntry(db, entry.id);
        continue;
      }

      // Format and send via official SDK
      const { msgType, content } = formatForFeishu(msg.format, msg.content);

      const result = await botApiCall(bot, () =>
        bot.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: channelMapping.externalChannelId,
            msg_type: msgType,
            content,
          },
        }),
      );

      sentMessages.add(dedupKey);

      // Store message reference
      const externalMsgId = result?.data?.message_id;
      if (externalMsgId) {
        await mappingService.createMessageReference(db, {
          messageId: msg.id,
          platform: "feishu",
          externalMessageId: externalMsgId,
          externalChannelId: channelMapping.externalChannelId,
        });
      }

      await ackEntry(db, entry.id);
      bot.lastActiveAt = new Date();
      sent++;
    } catch (err) {
      log.error({ entryId: entry.id, err }, "Failed to send outbound Feishu message");
      errorCount++;
    }
  }

  return { sent, errors: errorCount };
}

// ── Shared helpers ──────────────────────────────────────────────────

async function ackEntry(db: Database, entryId: number): Promise<void> {
  await db.update(inboxEntries).set({ status: "acked", ackedAt: new Date() }).where(eq(inboxEntries.id, entryId));
}

/** Convert internal message format to Feishu msg_type + content string. */
function formatForFeishu(format: string, content: unknown): { msgType: string; content: string } {
  if (format === "text") {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return { msgType: "text", content: JSON.stringify({ text }) };
  }

  if (format === "markdown") {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content: text }],
    };
    return { msgType: "interactive", content: JSON.stringify(card) };
  }

  if (format === "card" && typeof content === "object") {
    return { msgType: "interactive", content: JSON.stringify(content) };
  }

  const text = typeof content === "string" ? content : JSON.stringify(content);
  return { msgType: "text", content: JSON.stringify({ text }) };
}
