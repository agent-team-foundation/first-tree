import { extractCaption, isImageBatchRefContent, isImageRefContent } from "@first-tree/shared";
import { FIRST_TREE_ATTR } from "@first-tree/shared/observability";
import { Client, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { trace } from "@opentelemetry/api";
import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { withTimeout } from "../bootstrap-utils.js";
import type { Database } from "../db/connection.js";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { agents } from "../db/schema/agents.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { adapterAttrs, withSpan } from "../observability/index.js";
import * as mappingService from "./adapter-mapping.js";
import { decryptCredentials } from "./crypto.js";
import type { FeishuBotCredentials, InboundEvent } from "./feishu/types.js";
import { sendMessage } from "./message.js";
import { type Notifier, notifyRecipients } from "./notifier.js";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];

const FEISHU_WS_START_TIMEOUT_MS = 8_000;

/**
 * Reentrant proxy-env bypass for the Lark SDK (axios reads proxy env but
 * ignores NO_PROXY). Concurrent reloads share a single bypass window — the
 * first caller snapshots and unsets env, last caller restores. Without the
 * counter, parallel callers would race and either leak a deleted state or
 * corrupt the saved snapshot. See server-bootstrap-resilience-design.md §5.
 */
let proxyBypassDepth = 0;
let proxyBypassSaved: Record<string, string> | null = null;

async function withoutProxy<T>(fn: () => Promise<T>): Promise<T> {
  if (proxyBypassDepth === 0) {
    const saved: Record<string, string> = {};
    for (const key of PROXY_ENV_KEYS) {
      const val = process.env[key];
      if (val !== undefined) {
        saved[key] = val;
        delete process.env[key];
      }
    }
    proxyBypassSaved = saved;
  }
  proxyBypassDepth++;
  try {
    return await fn();
  } finally {
    proxyBypassDepth--;
    if (proxyBypassDepth === 0 && proxyBypassSaved) {
      for (const [key, val] of Object.entries(proxyBypassSaved)) {
        process.env[key] = val;
      }
      proxyBypassSaved = null;
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
  /**
   * Whether the WS handshake completed during the last reload attempt.
   * `false` rows are kept in the map so /readyz can report them as
   * disconnected; their `client`/`wsClient` are undefined. The SDK's
   * `autoReconnect` does NOT resurrect a failed start — we only retry on
   * the next `reload()` (PG NOTIFY or admin-triggered).
   */
  connected: boolean;
  /** Last error message if the start handshake failed. */
  lastError: string | null;
  /** Undefined for bots whose start handshake failed. */
  client: InstanceType<typeof Client> | undefined;
  /** Undefined for bots whose start handshake failed. */
  wsClient: WSClient | undefined;
  /** Timestamp of the last successful inbound or outbound activity. */
  lastActiveAt: Date | null;
};

/** A `ManagedBot` narrowed to the connected state, so SDK calls are type-safe. */
type ConnectedBot = ManagedBot & {
  connected: true;
  client: InstanceType<typeof Client>;
  wsClient: WSClient;
};

function isConnected(bot: ManagedBot): bot is ConnectedBot {
  return bot.connected && bot.client !== undefined && bot.wsClient !== undefined;
}

/** Wrap an SDK API call with proxy bypass if needed. */
function botApiCall<T>(bot: ConnectedBot, fn: () => Promise<T>): Promise<T> {
  return bot.bypassProxy ? withoutProxy(fn) : fn();
}

export type BotStatus = {
  configId: number;
  platform: string;
  agentId: string;
  appId: string;
  connected: boolean;
  lastError: string | null;
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
  notifier?: Notifier,
): AdapterManager {
  const bots = new Map<string, ManagedBot>();

  /**
   * Find a managed bot by its bound agentId. Only returns connected bots —
   * callers (outbound send, edit) need a live `client`/`wsClient`.
   */
  function findBotByAgentId(agentId: string): ConnectedBot | undefined {
    for (const bot of bots.values()) {
      if (bot.agentId === agentId && isConnected(bot)) return bot;
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
      if (!bot || !isConnected(bot)) return;

      try {
        await withSpan(
          "adapter.inbound feishu",
          adapterAttrs({
            platform: "feishu",
            externalChatId: event.externalChannelId,
            agentId: bot.agentId,
          }),
          () => processInboundMessage(db, event, bot, log, notifier),
        );
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

      const startTasks = configs.map(async (config) => {
        if (config.platform !== "feishu" || !config.credentials) return;

        let creds: FeishuBotCredentials;
        try {
          creds = decryptCredentials(config.credentials as string, encryptionKey) as FeishuBotCredentials;
        } catch (err) {
          log.error({ configId: config.id, err }, "Failed to decrypt adapter credentials");
          return;
        }

        const appId = creds.app_id;
        seen.add(appId);

        // Skip if already running with same config version (detect credential changes)
        const configVersion = config.updatedAt.toISOString();
        const existing = bots.get(appId);
        if (existing && existing.configId === config.id && existing.configUpdatedAt === configVersion) return;

        // Stop old connection if config changed
        if (existing) {
          existing.wsClient?.close({ force: true });
          log.info({ appId }, "Stopped old Feishu WS connection (config changed)");
        }

        // bypass_proxy defaults to true (Lark SDK ignores NO_PROXY — known bug)
        const bypassProxy = creds.bypass_proxy !== false;
        const wrap = bypassProxy ? withoutProxy : <T>(fn: () => Promise<T>) => fn();

        // `ws` is hoisted so the catch block can force-close it on timeout —
        // otherwise the SDK's `autoReconnect: true` keeps a background timer
        // alive against a dangling reference. The construction itself doesn't
        // touch the network; only `ws.start()` does.
        let ws: WSClient | undefined;
        try {
          // Create SDK client for outbound API calls
          const client = await wrap(() => Promise.resolve(new Client({ appId, appSecret: creds.app_secret })));

          // Create WSClient for inbound events
          const eventDispatcher = new EventDispatcher({}).register({
            "im.message.receive_v1": async (data: Record<string, unknown>) => {
              await handleInboundEvent(appId, data);
            },
          });

          await wrap(async () => {
            ws = new WSClient({
              appId,
              appSecret: creds.app_secret,
              loggerLevel: LoggerLevel.warn,
              autoReconnect: true,
            });
            // Per-bot timeout: a single slow remote handshake must not stall
            // server startup. A timed-out bot is recorded as disconnected
            // (see catch); the next reload() retries.
            await withTimeout(ws.start({ eventDispatcher }), FEISHU_WS_START_TIMEOUT_MS, `feishu.ws.start:${appId}`);
          });

          bots.set(appId, {
            configId: config.id,
            configUpdatedAt: configVersion,
            appId,
            agentId: config.agentId,
            bypassProxy,
            connected: true,
            lastError: null,
            client,
            // Non-null here: ws is assigned by the wrap() callback before
            // start() resolves; if start() rejected we would be in catch.
            wsClient: ws,
            lastActiveAt: null,
          });

          log.info({ appId, configId: config.id, agentId: config.agentId }, "Started Feishu adapter bot (WebSocket)");
        } catch (err) {
          // S1: tear down the half-started WSClient so the SDK's autoReconnect
          // timer doesn't keep firing in the background against a dropped ref.
          if (ws) {
            try {
              ws.close({ force: true });
            } catch (closeErr) {
              log.warn({ appId, err: closeErr }, "ws.close after failed start raised");
            }
          }

          // B1: keep a disconnected stub in the map so /readyz can report
          // "bot exists, not connected" instead of silently hiding it.
          bots.set(appId, {
            configId: config.id,
            configUpdatedAt: configVersion,
            appId,
            agentId: config.agentId,
            bypassProxy,
            connected: false,
            lastError: err instanceof Error ? err.message : String(err),
            client: undefined,
            wsClient: undefined,
            lastActiveAt: null,
          });

          log.error(
            { appId, configId: config.id, err },
            "Failed to start Feishu adapter bot — recorded as disconnected (other bots unaffected)",
          );
        }
      });

      await Promise.allSettled(startTasks);

      // Stop bots that are no longer active
      for (const [appId, bot] of bots) {
        if (!seen.has(appId)) {
          bot.wsClient?.close({ force: true });
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
          connected: bot.connected,
          lastError: bot.lastError,
          lastActiveAt: bot.lastActiveAt?.toISOString() ?? null,
        });
      }
      return statuses;
    },

    shutdown() {
      for (const [appId, bot] of bots) {
        if (bot.wsClient) {
          bot.wsClient.close({ force: true });
          log.info({ appId }, "Shut down Feishu WS connection");
        }
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

  // Prefer union_id (stable across apps), fallback to open_id (per-app)
  if (!sender.sender_id.union_id) {
    process.stderr.write(
      `[warn] Feishu event missing union_id for sender ${sender.sender_id.open_id}, falling back to open_id\n`,
    );
  }
  const resolvedSenderId = sender.sender_id.union_id ?? sender.sender_id.open_id;

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
    senderId: resolvedSenderId,
    senderOpenId: sender.sender_id.open_id,
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
  bot: ConnectedBot,
  log: FastifyBaseLogger,
  inboxNotifier?: Notifier,
): Promise<void> {
  // 0. Check for /bind command (works for both bound and unbound users)
  const messageText = extractTextContent(event);
  const bindMatch = /^\/bind\s+(\S+)/.exec(messageText);
  if (bindMatch?.[1]) {
    await handleBindCommand(db, bot, event, bindMatch[1], log);
    return;
  }

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

  // Resolve routing intent explicitly — the server no longer parses
  // `@<name>` tokens out of content (see services/message.ts Routing
  // contract). For Feishu inbound:
  //   - The bot agent is always the bridge recipient. First-tree feishu
  //     chats are constructed with exactly bot + sender as speakers
  //     (`findOrCreateChatForChannel`), so the bot is the natural wake
  //     target on every inbound message — equivalent to the old 1:1
  //     implicit-wake behaviour the server used to apply unconditionally.
  //   - Any structured `event.mentions` (Feishu's @-mention list with
  //     `openId`) is resolved against the bound-agent mapping; resolved
  //     ids that point at first-tree agents are included. Unresolved
  //     open_ids are dropped + warn-logged (Feishu users who haven't
  //     completed `/bind` yet, or @-mentions of feishu groups/bots that
  //     don't map to a first-tree agent).
  //   - The sender's own agentId is excluded from `mentions` — wake-up
  //     fan-out already filters out the sender, but keeping it out of
  //     the persisted set prevents downstream consumers from rendering
  //     "you mentioned yourself".
  const mentionSet = new Set<string>();
  mentionSet.add(bot.agentId);
  for (const m of event.mentions ?? []) {
    const mapping = await mappingService.findAgentByExternalUser(db, "feishu", m.openId);
    if (mapping?.agentId) {
      mentionSet.add(mapping.agentId);
    } else {
      log.warn(
        { openId: m.openId, name: m.name, appId: bot.appId, chatId },
        "feishu mention dropped: open_id is not bound to a first-tree agent",
      );
    }
  }
  mentionSet.delete(senderAgentId);
  const mentions = [...mentionSet];

  const { message: msg, recipients } = await sendMessage(db, chatId, senderAgentId, {
    format: event.messageType === "text" ? "text" : "card",
    content: event.messageType === "text" ? content : event.content,
    source: "feishu",
    metadata: {
      source: "feishu",
      externalMessageId: event.messageId,
      externalChannelId: event.externalChannelId,
      messageType: event.messageType,
      ...(mentions.length > 0 ? { mentions } : {}),
    },
  });

  // 4. Store message reference
  await mappingService.createMessageReference(db, {
    messageId: msg.id,
    platform: "feishu",
    externalMessageId: event.messageId,
    externalChannelId: event.externalChannelId,
  });

  if (inboxNotifier) {
    notifyRecipients(inboxNotifier, recipients, msg.id);
  }

  log.info({ appId: bot.appId, chatId, messageId: msg.id }, "Processed inbound Feishu message");
}

/** Reply to unknown (unbound) user with binding instructions. */
async function replyUnknownUser(bot: ConnectedBot, event: InboundEvent, log: FastifyBaseLogger): Promise<void> {
  const text = [
    "Your account is not linked to First Tree yet.",
    "To bind, send:  /bind <your-agent-id>",
    "",
    "Example:  /bind alice",
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

/** Extract plain text from a Feishu message event. */
function extractTextContent(event: InboundEvent): string {
  if (typeof event.content === "object" && event.content !== null && "text" in event.content) {
    return ((event.content as { text: string }).text ?? "").trim();
  }
  return "";
}

/**
 * Handle `/bind <agentId>` command from Feishu.
 * Binds the sender's Feishu user ID to the specified human agent.
 */
async function handleBindCommand(
  db: Database,
  bot: ConnectedBot,
  event: InboundEvent,
  agentName: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const reply = async (text: string) => {
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
      log.warn({ err }, "Failed to send /bind reply");
    }
  };

  // 1. Check if sender is already bound
  const existingMapping = await mappingService.findAgentByExternalUser(db, "feishu", event.senderId);
  if (existingMapping) {
    await reply(`You are already bound to agent "${existingMapping.agentId}". Unbind first if you want to rebind.`);
    return;
  }

  // 2. Check if target agent exists (lookup by name)
  const [agent] = await db
    .select({ id: agents.uuid, type: agents.type, status: agents.status })
    .from(agents)
    .where(and(eq(agents.name, agentName), ne(agents.status, "deleted")))
    .limit(1);

  if (!agent) {
    await reply(`Agent "${agentName}" not found. Check the name and try again.`);
    return;
  }

  if (agent.status !== "active") {
    await reply(`Agent "${agentName}" is ${agent.status}. Only active agents can be bound.`);
    return;
  }

  if (agent.type !== "human") {
    await reply(
      `Agent "${agentName}" is not a human agent (type: ${agent.type}). Only human agents can bind Feishu users.`,
    );
    return;
  }

  // 3. Check if this agent already has a Feishu binding (use resolved UUID)
  const existingAgentBinding = await mappingService.findExternalUserByAgent(db, "feishu", agent.id);
  if (existingAgentBinding) {
    await reply(
      `Agent "${agentName}" is already bound to Feishu user ${existingAgentBinding.externalUserId}. Unbind first if you want to rebind.`,
    );
    return;
  }

  // 4. Create binding (use resolved UUID, not the input name)
  try {
    await mappingService.createAgentMapping(db, {
      platform: "feishu",
      externalUserId: event.senderId,
      agentId: agent.id,
      boundVia: "command",
      displayName: undefined,
    });
  } catch (err) {
    log.error({ err, agentName, agentUuid: agent.id, senderId: event.senderId }, "/bind: failed to create mapping");
    await reply("Binding failed due to an internal error. Please try again or contact your admin.");
    return;
  }

  await reply(`Binding successful! Your Feishu account is now linked to "${agentName}".`);
  log.info(
    { agentName, agentUuid: agent.id, senderId: event.senderId, appId: bot.appId },
    "/bind: Feishu user bound via command",
  );
}

// ── Outbound helpers ────────────────────────────────────────────────

/**
 * Process outbound messages for all feishu-bound human agents.
 * Consumes pending inbox entries for human agents that have feishu platform bindings,
 * then sends via the message sender's bound bot.
 */
async function processFeishuOutbound(
  db: Database,
  findBotByAgentId: (agentId: string) => ConnectedBot | undefined,
  log: FastifyBaseLogger,
): Promise<{ sent: number; errors: number }> {
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
      JOIN adapter_agent_mappings aam ON a.uuid = aam.agent_id
      WHERE aam.platform = 'feishu' AND ie.status = 'pending'
      ORDER BY ie.created_at
      LIMIT ${OUTBOUND_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, inbox_id, message_id, chat_id
  `);

  // Empty tick — emit no span. Without this short-circuit the worker
  // produces a steady ~17k spans/day per bot at the 5s scheduling cadence,
  // overwhelmingly empty. See observability overhaul rationale.
  if (claimed.length === 0) return { sent: 0, errors: 0 };

  return withSpan(
    "adapter.outbound feishu",
    {
      ...adapterAttrs({ platform: "feishu" }),
      [FIRST_TREE_ATTR.BG_TASK_NAME]: "adapter.outbound.feishu",
      [FIRST_TREE_ATTR.BG_TASK_CLAIMED_COUNT]: claimed.length,
    },
    () => processFeishuOutboundClaimed(db, findBotByAgentId, log, claimed),
  );
}

async function processFeishuOutboundClaimed(
  db: Database,
  findBotByAgentId: (agentId: string) => ConnectedBot | undefined,
  log: FastifyBaseLogger,
  claimed: ReadonlyArray<{ id: number; inbox_id: string; message_id: string; chat_id: string | null }>,
): Promise<{ sent: number; errors: number }> {
  let sent = 0;
  let errorCount = 0;

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

  // Stamp final counts onto the active span so dashboards can see how many
  // of the claimed entries actually shipped vs. errored without a join.
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute(FIRST_TREE_ATTR.BG_TASK_SENT_COUNT, sent);
    span.setAttribute(FIRST_TREE_ATTR.BG_TASK_ERROR_COUNT, errorCount);
  }

  return { sent, errors: errorCount };
}

// ── Shared helpers ──────────────────────────────────────────────────

async function ackEntry(db: Database, entryId: number): Promise<void> {
  await db.update(inboxEntries).set({ status: "acked", ackedAt: new Date() }).where(eq(inboxEntries.id, entryId));
}

/**
 * Render a `format: "file"` payload (single image ref or batched
 * caption + N image refs) into a short text the external user can read.
 * Returns null when the content isn't a recognised image shape — caller
 * falls back to JSON.stringify like other formats. External Feishu users
 * have no Hub session, so we surface the caption + filenames rather than
 * any internal download link.
 */
function renderFileMessageForFeishu(content: unknown): string | null {
  // Batch shape: caption + N image refs.
  if (isImageBatchRefContent(content)) {
    const { attachments } = content;
    const caption = extractCaption(content).trim();
    const list = attachments.map((a) => `• ${a.filename}`).join("\n");
    return caption.length > 0
      ? `${caption}\n\n📎 ${attachments.length} image(s):\n${list}`
      : `📎 ${attachments.length} image(s):\n${list}`;
  }
  // Single image ref shape.
  if (isImageRefContent(content)) {
    return `📎 ${content.filename}`;
  }
  return null;
}

/** Convert internal message format to Feishu msg_type + content string.
 *
 * Exported for unit tests covering the file/image branches. The outbound
 * pipeline calls this internally — external callers don't need it. */
export function formatForFeishu(format: string, content: unknown): { msgType: string; content: string } {
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

  if (format === "file") {
    const rendered = renderFileMessageForFeishu(content);
    if (rendered !== null) {
      return { msgType: "text", content: JSON.stringify({ text: rendered }) };
    }
  }

  const text = typeof content === "string" ? content : JSON.stringify(content);
  return { msgType: "text", content: JSON.stringify({ text }) };
}
