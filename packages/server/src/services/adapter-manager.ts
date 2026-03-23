import { Client, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/connection.js";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { agents } from "../db/schema/agents.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import * as mappingService from "./adapter-mapping.js";
import { createAgent } from "./agent.js";
import { decryptCredentials } from "./crypto.js";
import type { FeishuBotCredentials, InboundEvent } from "./feishu/types.js";
import { sendMessage } from "./message.js";

const FEISHU_ADAPTER_ID_PREFIX = "feishu-adapter";
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
  appId: string;
  agentId: string | null;
  adapterAgentId: string;
  client: InstanceType<typeof Client>;
  wsClient: WSClient;
};

export type AdapterManager = {
  /** Load active adapter configs and start/stop WS connections. */
  reload(): Promise<void>;
  /** Process pending outbound messages for all adapter agents. */
  processOutbound(): Promise<{ sent: number; errors: number }>;
  /** Stop all WS connections. */
  shutdown(): void;
};

/**
 * Manages Feishu adapter bot instances using the official Lark SDK.
 * - Inbound: WSClient receives events via WebSocket (no public URL needed)
 * - Outbound: SDK Client sends messages via Feishu API
 */
export function createAdapterManager(
  db: Database,
  encryptionKey: string | undefined,
  log: FastifyBaseLogger,
): AdapterManager {
  const bots = new Map<string, ManagedBot>();

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

      await processInboundMessage(db, event, appId, log);
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

        // Skip if already running with same config
        const existing = bots.get(appId);
        if (existing && existing.configId === config.id) continue;

        // Stop old connection if config changed
        if (existing) {
          existing.wsClient.close({ force: true });
          log.info({ appId }, "Stopped old Feishu WS connection (config changed)");
        }

        // Ensure adapter system agent
        const adapterAgentId = `${FEISHU_ADAPTER_ID_PREFIX}-${appId}`;
        await ensureAdapterAgent(db, adapterAgentId, appId);

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
          appId,
          agentId: config.agentId,
          adapterAgentId,
          client,
          wsClient,
        });

        log.info({ appId, configId: config.id }, "Started Feishu adapter bot (WebSocket)");
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
      let sent = 0;
      let errors = 0;

      for (const [, bot] of bots) {
        try {
          const result = await processAdapterOutbound(db, bot, log);
          sent += result.sent;
          errors += result.errors;
        } catch (err) {
          log.error({ appId: bot.appId, err }, "Adapter outbound processing error");
          errors++;
        }
      }

      return { sent, errors };
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
  appId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  // 1. Resolve sender → internal agent
  const agentMapping = await mappingService.findAgentByExternalUser(db, "feishu", event.senderId);

  let senderAgentId: string;
  if (agentMapping) {
    senderAgentId = agentMapping.agentId;
  } else {
    // Auto-create agent for Feishu user
    const autoAgentId = `feishu-user-${event.senderId}`;
    const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, autoAgentId)).limit(1);

    if (existing) {
      senderAgentId = existing.id;
    } else {
      try {
        const agent = await createAgent(db, {
          id: autoAgentId,
          type: "human",
          displayName: `Feishu User ${event.senderId.slice(0, 8)}`,
          metadata: { source: "feishu", externalUserId: event.senderId, autoCreated: true },
        });
        senderAgentId = agent.id;
      } catch {
        senderAgentId = autoAgentId;
      }
    }
    await mappingService.createAgentMapping(db, {
      platform: "feishu",
      externalUserId: event.senderId,
      agentId: senderAgentId,
      boundVia: "auto",
      metadata: { appId },
    });
  }

  // 2. Ensure adapter system agent
  const adapterAgentId = `${FEISHU_ADAPTER_ID_PREFIX}-${appId}`;
  await ensureAdapterAgent(db, adapterAgentId, appId);

  // 3. Resolve chat → internal chat (auto-create if needed)
  const chatId = await mappingService.findOrCreateChatForChannel(db, {
    platform: "feishu",
    externalChannelId: event.externalChannelId,
    threadId: event.threadId,
    chatType: event.chatType,
    adapterAgentId,
    senderAgentId,
  });

  // 4. Send message into internal system
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

  // 5. Store message reference
  await mappingService.createMessageReference(db, {
    messageId: msg.id,
    platform: "feishu",
    externalMessageId: event.messageId,
    externalChannelId: event.externalChannelId,
  });

  log.info({ appId, chatId, messageId: msg.id }, "Processed inbound Feishu message");
}

// ── Outbound helpers ────────────────────────────────────────────────

async function processAdapterOutbound(
  db: Database,
  bot: ManagedBot,
  log: FastifyBaseLogger,
): Promise<{ sent: number; errors: number }> {
  let sent = 0;
  let errorCount = 0;

  const [adapterAgent] = await db
    .select({ inboxId: agents.inboxId })
    .from(agents)
    .where(eq(agents.id, bot.adapterAgentId))
    .limit(1);

  if (!adapterAgent) return { sent: 0, errors: 0 };

  const claimed = await db.execute<{
    id: number;
    inbox_id: string;
    message_id: string;
    chat_id: string | null;
  }>(sql`
    UPDATE inbox_entries
    SET status = 'delivered', delivered_at = NOW()
    WHERE id IN (
      SELECT id FROM inbox_entries
      WHERE inbox_id = ${adapterAgent.inboxId} AND status = 'pending'
      ORDER BY created_at
      LIMIT ${OUTBOUND_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, inbox_id, message_id, chat_id
  `);

  for (const entry of claimed) {
    try {
      const [msg] = await db.select().from(messages).where(eq(messages.id, entry.message_id)).limit(1);

      if (!msg) {
        await ackEntry(db, entry.id);
        continue;
      }

      // Skip messages from adapter itself
      if (msg.senderId === bot.adapterAgentId) {
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

      // Format and send via official SDK
      const { msgType, content } = formatForFeishu(msg.format, msg.content);

      const result = await bot.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: channelMapping.externalChannelId,
          msg_type: msgType,
          content,
        },
      });

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
      sent++;
    } catch (err) {
      log.error({ entryId: entry.id, err }, "Failed to send outbound Feishu message");
      errorCount++;
    }
  }

  return { sent, errors: errorCount };
}

// ── Shared helpers ──────────────────────────────────────────────────

async function ensureAdapterAgent(db: Database, adapterAgentId: string, appId: string): Promise<void> {
  const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, adapterAgentId)).limit(1);
  if (existing) return;

  try {
    await createAgent(db, {
      id: adapterAgentId,
      type: "autonomous_agent",
      displayName: `Feishu Adapter (${appId})`,
      metadata: { source: "feishu", managed: true, appId },
    });
  } catch {
    // Concurrent creation — OK
  }
}

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
