import type postgres from "postgres";
import type { WebSocket } from "ws";

const INBOX_CHANNEL = "inbox_notifications";
const CONFIG_CHANNEL = "config_changes";
const SESSION_STATE_CHANNEL = "session_state_changes";
const SESSION_EVENT_CHANNEL = "session_event_changes";
const RUNTIME_STATE_CHANNEL = "runtime_state_changes";
/**
 * Chat-first workspace cross-process kick. Carries `<chatId>:<messageId>`.
 * Lets admin WS sockets translate every chat message (speaker AND watcher
 * audience) into a `chat:message` frame, without being coupled to the
 * inbox NOTIFY path that only reaches speakers.
 */
const CHAT_MESSAGE_CHANNEL = "chat_message_events";
/**
 * Generic admin-broadcast envelope channel. Producers (e.g. notification.ts)
 * emit a JSON-stringified `AdminBroadcastPayload`; every server instance
 * LISTENs and hands the envelope to its local admin-socket fanout. Keeps
 * cross-instance and single-instance code paths identical from the admin WS
 * route's perspective.
 */
const ADMIN_BROADCAST_CHANNEL = "admin_broadcast_envelopes";

export type ConfigChangeHandler = (channel: string) => void;
export type SessionStateChangeHandler = (payload: {
  agentId: string;
  chatId: string;
  state: string;
  organizationId: string;
}) => void;
/**
 * Session event notification — fired whenever a new `session_events` row is
 * appended (tool_call / thinking / assistant_text / turn_end / error). The
 * payload intentionally carries only the routing dimensions; admin WS
 * consumers refetch `me/chats` rather than reconstructing the event
 * locally, so the NOTIFY stays under the 8KB PG limit even when events
 * burst at tool-call cadence.
 */
export type SessionEventChangeHandler = (payload: {
  agentId: string;
  chatId: string;
  kind: string;
  organizationId: string;
}) => void;
export type RuntimeStateChangeHandler = (payload: { agentId: string; state: string; organizationId: string }) => void;
export type ChatMessageChangeHandler = (payload: { chatId: string; messageId: string }) => void;
export type AdminBroadcastHandler = (payload: Record<string, unknown>) => void;

/**
 * Per-socket push handler for the WS data plane. When a NOTIFY arrives on
 * `inbox_notifications` for a subscribed inbox, the notifier hands the
 * `messageId` to this handler instead of sending the legacy `new_message`
 * doorbell frame. The handler owns claim-row + build-payload + send-frame
 * + in-flight bookkeeping (see proposal hub-inbox-ws-data-plane §3.2).
 *
 * Handlers are fire-and-forget — the notifier swallows their resolution; any
 * errors are the handler's responsibility to log. Returning a Promise lets
 * the server await DB work without blocking the LISTEN loop on it.
 */
export type InboxPushHandler = (messageId: string) => Promise<void> | void;

export type Notifier = {
  /**
   * Subscribe a WebSocket for an inbox. If `pushHandler` is provided, NOTIFY
   * traffic for this inbox routes to the handler instead of the legacy
   * `new_message` doorbell. Multiple sockets per inbox are supported; each
   * one is keyed independently so a doorbell client and a push client can
   * co-exist (think mid-rollout where one organisation upgrades before
   * another).
   */
  subscribe(inboxId: string, ws: WebSocket, pushHandler?: InboxPushHandler): void;
  /** Unsubscribe a WebSocket connection */
  unsubscribe(inboxId: string, ws: WebSocket): void;
  /** Notify that new messages are available for an inbox */
  notify(inboxId: string, messageId: string): Promise<void>;
  /** Notify that a config has changed */
  notifyConfigChange(configType: string): Promise<void>;
  /** Notify that a session state has changed */
  notifySessionStateChange(agentId: string, chatId: string, state: string, organizationId: string): Promise<void>;
  /** Notify that a session event was appended (used to invalidate `liveActivity`). */
  notifySessionEvent(agentId: string, chatId: string, kind: string, organizationId: string): Promise<void>;
  /** Notify that an agent runtime state has changed (idle/working/error/…). Payload is org-scoped so admin consumers can filter. */
  notifyRuntimeStateChange(agentId: string, state: string, organizationId: string): Promise<void>;
  /** Chat-first workspace: kick admin WS sockets to invalidate ["me","chats"] and the timeline of `chatId`. */
  notifyChatMessage(chatId: string, messageId: string): Promise<void>;
  /**
   * Emit a generic admin-broadcast envelope cross-instance. Every server
   * instance's LISTEN handler receives the JSON-decoded payload and hands it
   * to its registered admin-socket fanout (typically `broadcastToAdmins`).
   */
  notifyAdminBroadcast(payload: Record<string, unknown>): Promise<void>;
  /**
   * Push a raw JSON frame to every socket currently subscribed to `inboxId`
   * on **this server instance only**. Unlike `notify`, does not fan out
   * across PG NOTIFY — used for payloads that are too large for NOTIFY
   * (image bytes) and where cross-instance loss is acceptable. Returns the
   * number of sockets the frame was queued to.
   */
  pushFrameToInbox(inboxId: string, frame: string): Promise<number>;
  /** Register a handler for config change notifications */
  onConfigChange(handler: ConfigChangeHandler): void;
  /** Register a handler for session state change notifications */
  onSessionStateChange(handler: SessionStateChangeHandler): void;
  /** Register a handler for session-event notifications (per-chat liveActivity). */
  onSessionEvent(handler: SessionEventChangeHandler): void;
  /** Register a handler for runtime state change notifications */
  onRuntimeStateChange(handler: RuntimeStateChangeHandler): void;
  /** Register a handler for chat:message change notifications. */
  onChatMessage(handler: ChatMessageChangeHandler): void;
  /** Register a handler for cross-instance admin-broadcast envelopes. */
  onAdminBroadcast(handler: AdminBroadcastHandler): void;
  /** Start listening for PG notifications */
  start(): Promise<void>;
  /** Stop listening */
  stop(): Promise<void>;
};

export function createNotifier(listenClient: postgres.Sql): Notifier {
  // Each subscription stores either a push handler (WS data-plane path) or
  // null (legacy `new_message` doorbell). A single inbox may have a mix of
  // both during gradual rollout — the LISTEN handler dispatches per-socket.
  const subscriptions = new Map<string, Map<WebSocket, InboxPushHandler | null>>();
  const configChangeHandlers: ConfigChangeHandler[] = [];
  const sessionStateChangeHandlers: SessionStateChangeHandler[] = [];
  const sessionEventHandlers: SessionEventChangeHandler[] = [];
  const runtimeStateChangeHandlers: RuntimeStateChangeHandler[] = [];
  const chatMessageHandlers: ChatMessageChangeHandler[] = [];
  const adminBroadcastHandlers: AdminBroadcastHandler[] = [];
  let unlistenInboxFn: (() => Promise<void>) | null = null;
  let unlistenConfigFn: (() => Promise<void>) | null = null;
  let unlistenSessionStateFn: (() => Promise<void>) | null = null;
  let unlistenSessionEventFn: (() => Promise<void>) | null = null;
  let unlistenRuntimeStateFn: (() => Promise<void>) | null = null;
  let unlistenChatMessageFn: (() => Promise<void>) | null = null;
  let unlistenAdminBroadcastFn: (() => Promise<void>) | null = null;

  function handleNotification(payload: string) {
    // payload format: "inboxId:messageId"
    const sepIdx = payload.indexOf(":");
    if (sepIdx === -1) return;
    const inboxId = payload.slice(0, sepIdx);
    const messageId = payload.slice(sepIdx + 1);

    const sockets = subscriptions.get(inboxId);
    if (!sockets) return;

    const doorbellFrame = JSON.stringify({ type: "new_message", inboxId, messageId });
    for (const [ws, pushHandler] of sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      if (pushHandler) {
        // WS data-plane path: defer DB + frame work to the per-socket handler.
        // It owns capability gating, in-flight backpressure, claim, build, and
        // send. Resolution is intentionally not awaited — the LISTEN loop must
        // not stall on slow consumers.
        Promise.resolve(pushHandler(messageId)).catch(() => {
          // Handler-side errors are logged by the handler; swallow here so a
          // single misbehaving socket does not break notification fan-out for
          // the rest of the subscribers.
        });
      } else {
        // Legacy doorbell path: kick the client to HTTP-poll.
        ws.send(doorbellFrame);
      }
    }
  }

  return {
    subscribe(inboxId: string, ws: WebSocket, pushHandler?: InboxPushHandler) {
      let map = subscriptions.get(inboxId);
      if (!map) {
        map = new Map();
        subscriptions.set(inboxId, map);
      }
      map.set(ws, pushHandler ?? null);
    },

    unsubscribe(inboxId: string, ws: WebSocket) {
      const map = subscriptions.get(inboxId);
      if (map) {
        map.delete(ws);
        if (map.size === 0) {
          subscriptions.delete(inboxId);
        }
      }
    },

    async notify(inboxId: string, messageId: string) {
      try {
        await listenClient`SELECT pg_notify(${INBOX_CHANNEL}, ${`${inboxId}:${messageId}`})`;
      } catch {
        // fire-and-forget: notification loss is acceptable, polling covers it
      }
    },

    async notifyConfigChange(configType: string) {
      try {
        await listenClient`SELECT pg_notify(${CONFIG_CHANNEL}, ${configType})`;
      } catch {
        // fire-and-forget
      }
    },

    async notifySessionStateChange(agentId: string, chatId: string, state: string, organizationId: string) {
      try {
        await listenClient`SELECT pg_notify(${SESSION_STATE_CHANNEL}, ${`${agentId}:${chatId}:${state}:${organizationId}`})`;
      } catch {
        // fire-and-forget
      }
    },

    async notifySessionEvent(agentId: string, chatId: string, kind: string, organizationId: string) {
      try {
        // Same `<a>:<b>:<c>:<d>` shape as the session-state channel so
        // payload parsing can reuse the index-of-3 split below. agentId
        // and chatId are UUIDs (no colons); kind is a fixed-vocabulary
        // enum (`tool_call` etc., no colons either).
        await listenClient`SELECT pg_notify(${SESSION_EVENT_CHANNEL}, ${`${agentId}:${chatId}:${kind}:${organizationId}`})`;
      } catch {
        // fire-and-forget — admin UI's 15s `me/chats` polling re-syncs.
      }
    },

    async notifyRuntimeStateChange(agentId: string, state: string, organizationId: string) {
      try {
        await listenClient`SELECT pg_notify(${RUNTIME_STATE_CHANNEL}, ${`${agentId}:${state}:${organizationId}`})`;
      } catch {
        // fire-and-forget
      }
    },

    async notifyChatMessage(chatId: string, messageId: string) {
      try {
        await listenClient`SELECT pg_notify(${CHAT_MESSAGE_CHANNEL}, ${`${chatId}:${messageId}`})`;
      } catch {
        // fire-and-forget — realtime is best-effort, web reconnect refetches
      }
    },

    async notifyAdminBroadcast(payload: Record<string, unknown>) {
      let encoded: string;
      try {
        encoded = JSON.stringify(payload);
      } catch {
        // Non-serialisable producer payload — nothing useful to forward.
        return;
      }
      // PG NOTIFY payload limit is ~8000 bytes. Notification envelopes are
      // ~600 bytes in practice; anything over 7500 means a producer bug
      // (e.g. someone stuffing message bodies / attachments into the
      // envelope). Log loudly via console — the rest of `notifier.ts` is
      // intentionally logger-free to keep the module portable, but a
      // truncated NOTIFY would silently break admin UI fan-out, which is
      // exactly the kind of failure we don't want fire-and-forget'd into
      // the void.
      if (encoded.length > 7500) {
        console.error(`[notifier] admin broadcast payload too large (${encoded.length} bytes); refusing to NOTIFY`);
        return;
      }
      try {
        await listenClient`SELECT pg_notify(${ADMIN_BROADCAST_CHANNEL}, ${encoded})`;
      } catch {
        // Transient PG errors are best-effort; admin UI tolerates a
        // dropped frame, and the next reconnect-time catch-up will
        // re-sync via REST.
      }
    },

    async pushFrameToInbox(inboxId: string, frame: string): Promise<number> {
      const map = subscriptions.get(inboxId);
      if (!map) return 0;
      let queued = 0;
      const pending: Promise<void>[] = [];
      for (const ws of map.keys()) {
        if (ws.readyState !== ws.OPEN) continue;
        pending.push(
          new Promise<void>((resolve) => {
            ws.send(frame, (err) => {
              if (!err) queued += 1;
              resolve();
            });
          }),
        );
      }
      await Promise.all(pending);
      return queued;
    },

    onConfigChange(handler: ConfigChangeHandler) {
      configChangeHandlers.push(handler);
    },

    onSessionStateChange(handler: SessionStateChangeHandler) {
      sessionStateChangeHandlers.push(handler);
    },

    onSessionEvent(handler: SessionEventChangeHandler) {
      sessionEventHandlers.push(handler);
    },

    onRuntimeStateChange(handler: RuntimeStateChangeHandler) {
      runtimeStateChangeHandlers.push(handler);
    },

    onChatMessage(handler: ChatMessageChangeHandler) {
      chatMessageHandlers.push(handler);
    },

    onAdminBroadcast(handler: AdminBroadcastHandler) {
      adminBroadcastHandlers.push(handler);
    },

    async start() {
      const inboxResult = await listenClient.listen(INBOX_CHANNEL, (payload) => {
        if (payload) handleNotification(payload);
      });
      unlistenInboxFn = inboxResult.unlisten;

      const configResult = await listenClient.listen(CONFIG_CHANNEL, (payload) => {
        if (payload) {
          for (const handler of configChangeHandlers) {
            handler(payload);
          }
        }
      });
      unlistenConfigFn = configResult.unlisten;

      const sessionStateResult = await listenClient.listen(SESSION_STATE_CHANNEL, (payload) => {
        if (payload) {
          // payload format: "agentId:chatId:state:organizationId"
          const firstSep = payload.indexOf(":");
          const secondSep = payload.indexOf(":", firstSep + 1);
          const thirdSep = payload.indexOf(":", secondSep + 1);
          if (firstSep > 0 && secondSep > firstSep && thirdSep > secondSep) {
            const agentId = payload.slice(0, firstSep);
            const chatId = payload.slice(firstSep + 1, secondSep);
            const state = payload.slice(secondSep + 1, thirdSep);
            const organizationId = payload.slice(thirdSep + 1);
            for (const handler of sessionStateChangeHandlers) {
              handler({ agentId, chatId, state, organizationId });
            }
          }
        }
      });
      unlistenSessionStateFn = sessionStateResult.unlisten;

      const sessionEventResult = await listenClient.listen(SESSION_EVENT_CHANNEL, (payload) => {
        if (payload) {
          // payload format: "agentId:chatId:kind:organizationId" — mirrors
          // the session-state channel split.
          const firstSep = payload.indexOf(":");
          const secondSep = payload.indexOf(":", firstSep + 1);
          const thirdSep = payload.indexOf(":", secondSep + 1);
          if (firstSep > 0 && secondSep > firstSep && thirdSep > secondSep) {
            const agentId = payload.slice(0, firstSep);
            const chatId = payload.slice(firstSep + 1, secondSep);
            const kind = payload.slice(secondSep + 1, thirdSep);
            const organizationId = payload.slice(thirdSep + 1);
            for (const handler of sessionEventHandlers) {
              try {
                handler({ agentId, chatId, kind, organizationId });
              } catch {
                // swallow — handler errors must not poison fan-out
              }
            }
          }
        }
      });
      unlistenSessionEventFn = sessionEventResult.unlisten;

      const runtimeStateResult = await listenClient.listen(RUNTIME_STATE_CHANNEL, (payload) => {
        if (payload) {
          // payload format: "agentId:state:organizationId"
          const firstSep = payload.indexOf(":");
          const secondSep = payload.indexOf(":", firstSep + 1);
          if (firstSep > 0 && secondSep > firstSep) {
            const agentId = payload.slice(0, firstSep);
            const state = payload.slice(firstSep + 1, secondSep);
            const organizationId = payload.slice(secondSep + 1);
            for (const handler of runtimeStateChangeHandlers) {
              handler({ agentId, state, organizationId });
            }
          }
        }
      });
      unlistenRuntimeStateFn = runtimeStateResult.unlisten;

      const chatMessageResult = await listenClient.listen(CHAT_MESSAGE_CHANNEL, (payload) => {
        if (!payload) return;
        // payload format: "chatId:messageId" — chatId is a UUID (no colons) so the
        // first separator wins.
        const sep = payload.indexOf(":");
        if (sep <= 0) return;
        const chatId = payload.slice(0, sep);
        const messageId = payload.slice(sep + 1);
        for (const handler of chatMessageHandlers) {
          try {
            handler({ chatId, messageId });
          } catch {
            // swallow — handler errors must not poison fan-out
          }
        }
      });
      unlistenChatMessageFn = chatMessageResult.unlisten;

      const adminBroadcastResult = await listenClient.listen(ADMIN_BROADCAST_CHANNEL, (payload) => {
        if (!payload) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // Malformed payload — drop. A producer bug should never poison the
          // LISTEN loop for other handlers.
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const envelope = parsed as Record<string, unknown>;
        for (const handler of adminBroadcastHandlers) {
          try {
            handler(envelope);
          } catch {
            // swallow — handler errors must not poison fan-out
          }
        }
      });
      unlistenAdminBroadcastFn = adminBroadcastResult.unlisten;
    },

    async stop() {
      if (unlistenInboxFn) {
        await unlistenInboxFn();
        unlistenInboxFn = null;
      }
      if (unlistenConfigFn) {
        await unlistenConfigFn();
        unlistenConfigFn = null;
      }
      if (unlistenSessionStateFn) {
        await unlistenSessionStateFn();
        unlistenSessionStateFn = null;
      }
      if (unlistenSessionEventFn) {
        await unlistenSessionEventFn();
        unlistenSessionEventFn = null;
      }
      if (unlistenRuntimeStateFn) {
        await unlistenRuntimeStateFn();
        unlistenRuntimeStateFn = null;
      }
      if (unlistenChatMessageFn) {
        await unlistenChatMessageFn();
        unlistenChatMessageFn = null;
      }
      if (unlistenAdminBroadcastFn) {
        await unlistenAdminBroadcastFn();
        unlistenAdminBroadcastFn = null;
      }
    },
  };
}

/** Fire-and-forget: notify all recipients that a new message is available. */
export function notifyRecipients(notifier: Notifier, recipients: string[], messageId: string): void {
  for (const inboxId of recipients) {
    notifier.notify(inboxId, messageId).catch(() => {});
  }
}
