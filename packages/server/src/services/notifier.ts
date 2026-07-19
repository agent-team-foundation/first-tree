import type postgres from "postgres";
import type { WebSocket } from "ws";

const INBOX_CHANNEL = "inbox_notifications";
const CONFIG_CHANNEL = "config_changes";
const SESSION_STATE_CHANNEL = "session_state_changes";
const SESSION_EVENT_CHANNEL = "session_event_changes";
const RUNTIME_STATE_CHANNEL = "runtime_state_changes";
/**
 * Per-(agent,chat) D-axis runtime change. Carries
 * `<agentId>:<chatId>:<state>:<organizationId>`. Distinct from
 * `RUNTIME_STATE_CHANNEL`, which carries the lossy agent-global aggregate
 * the per-chat composite cannot consume safely (#366).
 */
const SESSION_RUNTIME_CHANNEL = "session_runtime_changes";
/**
 * Chat-first workspace cross-process kick. Carries `<chatId>:<messageId>`.
 * Lets admin WS sockets translate every chat message (speaker AND watcher
 * audience) into a `chat:message` frame, without being coupled to the
 * inbox NOTIFY path that only reaches speakers.
 */
const CHAT_MESSAGE_CHANNEL = "chat_message_events";
/**
 * Cross-replica chat-audience invalidation. Carries the bare `<chatId>`.
 * The push-audience cache (`chat-audience-cache.ts`) is process-local, so a
 * membership change on one replica only drops THAT replica's cache. This
 * channel fans the invalidation to every replica so the one hosting a viewer's
 * admin WS doesn't keep serving a stale audience (and dropping `chat:message`
 * pushes to a just-added member) for up to the cache TTL.
 */
const CHAT_AUDIENCE_CHANNEL = "chat_audience_events";
/**
 * Chat metadata change (e.g. an agent running `chat update --description`).
 * Carries the bare `<chatId>`. Lets admin WS sockets translate a description /
 * topic edit into a `chat:updated` frame so an open chat's pinned task summary
 * (which reads `description` + freshness off chat-detail) and the conversation
 * list refresh in realtime, with no accompanying message.
 */
const CHAT_UPDATED_CHANNEL = "chat_updated_events";
const AGENT_ROUTE_CHANNEL = "agent_route_events";
/**
 * Cross-replica reverse command to a connected daemon (e.g. provider-models:list).
 * Payload is small JSON: `{ type, clientId, provider, ref }`. The replica that
 * owns the client's WebSocket delivers it via `sendToClient`; others no-op.
 */
const DAEMON_CLIENT_COMMAND_CHANNEL = "daemon_client_commands";
/**
 * Cross-replica wake that a daemon command result is ready. Payload is
 * `{ clientId, ref }` only — the catalog lives in `clients.metadata` so large
 * Cursor lists stay under the PG NOTIFY 8KB limit.
 */
const DAEMON_CLIENT_COMMAND_RESULT_CHANNEL = "daemon_client_command_results";
/**
 * A viewer's PRIVATE me-chats projection changed (currently: they pinned or
 * unpinned a chat). Carries `<humanAgentId>:<organizationId>` so the WS layer
 * can fan a bare `me-chats:changed` invalidation to ONLY that user's own
 * sockets in that org. Pin state is private per-user and must never reach
 * another member's devices — so unlike `chat_updated_events` (audience-scoped
 * to every chat member), this channel is user-scoped.
 */
const ME_CHATS_CHANNEL = "me_chats_changed";

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
/**
 * Per-(agent,chat) runtime change — fired when a client reports the D-axis
 * runtime state for a specific chat (`session:runtime` frame or its ~30s
 * re-affirm). Lets admin WS consumers compute the composite delta in
 * realtime instead of waiting for the 30s poll. Same routing-only payload
 * shape as the session-state channel.
 */
export type SessionRuntimeChangeHandler = (payload: {
  agentId: string;
  chatId: string;
  state: string;
  organizationId: string;
}) => void;
export type ChatMessageChangeHandler = (payload: { chatId: string; messageId: string }) => void;
export type ChatAudienceChangeHandler = (payload: { chatId: string }) => void;
export type ChatUpdatedChangeHandler = (payload: { chatId: string }) => void;
export type AgentRouteChangePayload = {
  agentId: string;
  name: string | null;
  displayName: string;
  agentType: string;
  oldClientId: string | null;
  targetClientId: string;
  runtimeProvider: string;
  reason: string;
};
export type AgentRouteChangeHandler = (payload: AgentRouteChangePayload) => void;

/** Small reverse-command frame fan-out for host-local daemon RPCs. */
export type DaemonClientCommandPayload = {
  type: string;
  clientId: string;
  provider: string;
  ref: string;
  /** DB-authoritative `clients.instance_id` — only that replica may deliver. */
  targetInstanceId: string;
};
export type DaemonClientCommandHandler = (payload: DaemonClientCommandPayload) => void;

/** Wake waiters that a correlated daemon RPC result is stored in client metadata. */
export type DaemonClientCommandResultPayload = {
  clientId: string;
  ref: string;
};
export type DaemonClientCommandResultHandler = (payload: DaemonClientCommandResultPayload) => void;
export type MeChatsChangedHandler = (payload: { humanAgentId: string; organizationId: string }) => void;

/**
 * Per-socket push handler for the WS data plane. When a NOTIFY arrives on
 * `inbox_notifications` for a subscribed inbox, the notifier hands the
 * `messageId` to this handler. The handler owns claim-row + build-payload +
 * send-frame + in-flight bookkeeping.
 *
 * Handlers are fire-and-forget — the notifier swallows their resolution; any
 * errors are the handler's responsibility to log. Returning a Promise lets
 * the server await DB work without blocking the LISTEN loop on it.
 */
export type InboxPushHandler = (messageId: string) => Promise<void> | void;

export type Notifier = {
  /**
   * Subscribe a WebSocket for an inbox. NOTIFY traffic for the inbox is
   * dispatched to `pushHandler`.
   */
  subscribe(inboxId: string, ws: WebSocket, pushHandler: InboxPushHandler): void;
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
  /** Notify that the per-(agent,chat) D-axis runtime state changed. */
  notifySessionRuntime(agentId: string, chatId: string, state: string, organizationId: string): Promise<void>;
  /** Chat-first workspace: kick admin WS sockets to invalidate ["me","chats"] and the timeline of `chatId`. */
  notifyChatMessage(chatId: string, messageId: string): Promise<void>;
  /** Fan a chat-audience-cache invalidation for `chatId` to every replica. */
  notifyChatAudience(chatId: string): Promise<void>;
  /** Chat metadata changed (description / topic): kick admin WS sockets to invalidate `["chat-detail", chatId]` + `["me","chats"]`. */
  notifyChatUpdated(chatId: string): Promise<void>;
  /**
   * A viewer's private me-chats list changed (pin / unpin). Kicks ONLY that
   * user's own admin WS sockets (in `organizationId`) to invalidate
   * `["me","chats"]`, so the change syncs across their devices without ever
   * touching another member's sockets.
   */
  notifyMeChatsChanged(humanAgentId: string, organizationId: string): Promise<void>;
  /** Agent runtime route changed: fan local WS detach/pin handling to every server replica. */
  notifyAgentRouteChange(payload: AgentRouteChangePayload): Promise<void>;
  /**
   * Fan a small reverse-command frame to every replica so the process that
   * owns the daemon WebSocket can `sendToClient`. Payload must stay tiny
   * (no catalog bodies).
   */
  notifyDaemonClientCommand(payload: DaemonClientCommandPayload): Promise<void>;
  /**
   * Wake waiters that a correlated daemon RPC result is durable in
   * `clients.metadata` (catalog bodies are too large for NOTIFY).
   */
  notifyDaemonClientCommandResult(payload: DaemonClientCommandResultPayload): Promise<void>;
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
  /** Register a per-(agent,chat) runtime change handler. */
  onSessionRuntime(handler: SessionRuntimeChangeHandler): void;
  /** Register a handler for chat:message change notifications. */
  onChatMessage(handler: ChatMessageChangeHandler): void;
  /** Register a handler for cross-replica chat-audience invalidations. */
  onChatAudience(handler: ChatAudienceChangeHandler): void;
  /** Register a handler for chat:updated (metadata change) notifications. */
  onChatUpdated(handler: ChatUpdatedChangeHandler): void;
  /** Register a handler for per-user me-chats invalidations (pin / unpin). */
  onMeChatsChanged(handler: MeChatsChangedHandler): void;
  /** Register a handler for agent runtime route changes. */
  onAgentRouteChange(handler: AgentRouteChangeHandler): void;
  /** Register a handler for cross-replica daemon reverse commands. */
  onDaemonClientCommand(handler: DaemonClientCommandHandler): void;
  /** Register a handler for cross-replica daemon RPC result wakes. */
  onDaemonClientCommandResult(handler: DaemonClientCommandResultHandler): void;
  /** Start listening for PG notifications */
  start(): Promise<void>;
  /** Stop listening */
  stop(): Promise<void>;
};

export function createNotifier(listenClient: postgres.Sql): Notifier {
  const subscriptions = new Map<string, Map<WebSocket, InboxPushHandler>>();
  const configChangeHandlers: ConfigChangeHandler[] = [];
  const sessionStateChangeHandlers: SessionStateChangeHandler[] = [];
  const sessionEventHandlers: SessionEventChangeHandler[] = [];
  const runtimeStateChangeHandlers: RuntimeStateChangeHandler[] = [];
  const sessionRuntimeHandlers: SessionRuntimeChangeHandler[] = [];
  const chatMessageHandlers: ChatMessageChangeHandler[] = [];
  const chatAudienceHandlers: ChatAudienceChangeHandler[] = [];
  const chatUpdatedHandlers: ChatUpdatedChangeHandler[] = [];
  const meChatsChangedHandlers: MeChatsChangedHandler[] = [];
  const agentRouteHandlers: AgentRouteChangeHandler[] = [];
  const daemonClientCommandHandlers: DaemonClientCommandHandler[] = [];
  const daemonClientCommandResultHandlers: DaemonClientCommandResultHandler[] = [];
  let unlistenInboxFn: (() => Promise<void>) | null = null;
  let unlistenConfigFn: (() => Promise<void>) | null = null;
  let unlistenSessionStateFn: (() => Promise<void>) | null = null;
  let unlistenSessionEventFn: (() => Promise<void>) | null = null;
  let unlistenRuntimeStateFn: (() => Promise<void>) | null = null;
  let unlistenSessionRuntimeFn: (() => Promise<void>) | null = null;
  let unlistenChatMessageFn: (() => Promise<void>) | null = null;
  let unlistenChatAudienceFn: (() => Promise<void>) | null = null;
  let unlistenChatUpdatedFn: (() => Promise<void>) | null = null;
  let unlistenMeChatsChangedFn: (() => Promise<void>) | null = null;
  let unlistenAgentRouteFn: (() => Promise<void>) | null = null;
  let unlistenDaemonClientCommandFn: (() => Promise<void>) | null = null;
  let unlistenDaemonClientCommandResultFn: (() => Promise<void>) | null = null;

  function handleNotification(payload: string) {
    // payload format: "inboxId:messageId"
    const sepIdx = payload.indexOf(":");
    if (sepIdx === -1) return;
    const inboxId = payload.slice(0, sepIdx);
    const messageId = payload.slice(sepIdx + 1);

    const sockets = subscriptions.get(inboxId);
    if (!sockets) return;

    for (const [ws, pushHandler] of sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      // Defer DB + frame work to the per-socket handler. It owns in-flight
      // backpressure, claim, build, and send. Resolution is intentionally
      // not awaited — the LISTEN loop must not stall on slow consumers.
      Promise.resolve(pushHandler(messageId)).catch(() => {
        // Handler-side errors are logged by the handler; swallow here so a
        // single misbehaving socket does not break notification fan-out for
        // the rest of the subscribers.
      });
    }
  }

  return {
    subscribe(inboxId: string, ws: WebSocket, pushHandler: InboxPushHandler) {
      let map = subscriptions.get(inboxId);
      if (!map) {
        map = new Map();
        subscriptions.set(inboxId, map);
      }
      map.set(ws, pushHandler);
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
        // Fire-and-forget: durable inbox rows are repaired by bound WS backlog
        // drains if this volatile NOTIFY hint is missed.
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

    async notifySessionRuntime(agentId: string, chatId: string, state: string, organizationId: string) {
      try {
        // `<agentId>:<chatId>:<state>:<organizationId>` — same shape as the
        // session-state channel so the listen-side split is reused verbatim.
        await listenClient`SELECT pg_notify(${SESSION_RUNTIME_CHANNEL}, ${`${agentId}:${chatId}:${state}:${organizationId}`})`;
      } catch {
        // fire-and-forget — admin UI's 30s agent-status poll re-syncs.
      }
    },

    async notifyChatMessage(chatId: string, messageId: string) {
      try {
        await listenClient`SELECT pg_notify(${CHAT_MESSAGE_CHANNEL}, ${`${chatId}:${messageId}`})`;
      } catch {
        // fire-and-forget — realtime is best-effort, web reconnect refetches
      }
    },

    async notifyChatAudience(chatId: string) {
      try {
        await listenClient`SELECT pg_notify(${CHAT_AUDIENCE_CHANNEL}, ${chatId})`;
      } catch {
        // fire-and-forget — a missed fan-out just means the stale replica
        // serves its cached audience until the TTL ages it out (≤ cache TTL).
      }
    },

    async notifyChatUpdated(chatId: string) {
      try {
        await listenClient`SELECT pg_notify(${CHAT_UPDATED_CHANNEL}, ${chatId})`;
      } catch {
        // fire-and-forget — realtime is best-effort; web reconnect refetches.
      }
    },

    async notifyMeChatsChanged(humanAgentId: string, organizationId: string) {
      try {
        await listenClient`SELECT pg_notify(${ME_CHATS_CHANNEL}, ${`${humanAgentId}:${organizationId}`})`;
      } catch {
        // fire-and-forget — realtime is best-effort; the 30s me-chats poll and
        // web reconnect refetch are the durable fallback.
      }
    },

    async notifyAgentRouteChange(payload: AgentRouteChangePayload) {
      try {
        await listenClient`SELECT pg_notify(${AGENT_ROUTE_CHANNEL}, ${JSON.stringify(payload)})`;
      } catch {
        // fire-and-forget — DB route/token checks are the durable fallback.
      }
    },

    async notifyDaemonClientCommand(payload: DaemonClientCommandPayload) {
      try {
        await listenClient`SELECT pg_notify(${DAEMON_CLIENT_COMMAND_CHANNEL}, ${JSON.stringify(payload)})`;
      } catch {
        // fire-and-forget — HTTP waiter timeout is the durable fallback.
      }
    },

    async notifyDaemonClientCommandResult(payload: DaemonClientCommandResultPayload) {
      try {
        await listenClient`SELECT pg_notify(${DAEMON_CLIENT_COMMAND_RESULT_CHANNEL}, ${JSON.stringify(payload)})`;
      } catch {
        // fire-and-forget — HTTP waiter timeout is the durable fallback.
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

    onSessionRuntime(handler: SessionRuntimeChangeHandler) {
      sessionRuntimeHandlers.push(handler);
    },

    onChatMessage(handler: ChatMessageChangeHandler) {
      chatMessageHandlers.push(handler);
    },

    onChatAudience(handler: ChatAudienceChangeHandler) {
      chatAudienceHandlers.push(handler);
    },

    onChatUpdated(handler: ChatUpdatedChangeHandler) {
      chatUpdatedHandlers.push(handler);
    },

    onMeChatsChanged(handler: MeChatsChangedHandler) {
      meChatsChangedHandlers.push(handler);
    },

    onAgentRouteChange(handler: AgentRouteChangeHandler) {
      agentRouteHandlers.push(handler);
    },

    onDaemonClientCommand(handler: DaemonClientCommandHandler) {
      daemonClientCommandHandlers.push(handler);
    },

    onDaemonClientCommandResult(handler: DaemonClientCommandResultHandler) {
      daemonClientCommandResultHandlers.push(handler);
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

      const sessionRuntimeResult = await listenClient.listen(SESSION_RUNTIME_CHANNEL, (payload) => {
        if (payload) {
          // payload format: "agentId:chatId:state:organizationId" — mirrors
          // the session-state channel split.
          const firstSep = payload.indexOf(":");
          const secondSep = payload.indexOf(":", firstSep + 1);
          const thirdSep = payload.indexOf(":", secondSep + 1);
          if (firstSep > 0 && secondSep > firstSep && thirdSep > secondSep) {
            const agentId = payload.slice(0, firstSep);
            const chatId = payload.slice(firstSep + 1, secondSep);
            const state = payload.slice(secondSep + 1, thirdSep);
            const organizationId = payload.slice(thirdSep + 1);
            for (const handler of sessionRuntimeHandlers) {
              try {
                handler({ agentId, chatId, state, organizationId });
              } catch {
                // swallow — handler errors must not poison fan-out
              }
            }
          }
        }
      });
      unlistenSessionRuntimeFn = sessionRuntimeResult.unlisten;

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

      const chatAudienceResult = await listenClient.listen(CHAT_AUDIENCE_CHANNEL, (payload) => {
        if (!payload) return;
        // payload is the bare chatId (a UUID).
        const chatId = payload;
        for (const handler of chatAudienceHandlers) {
          try {
            handler({ chatId });
          } catch {
            // swallow — handler errors must not poison fan-out
          }
        }
      });
      unlistenChatAudienceFn = chatAudienceResult.unlisten;

      const chatUpdatedResult = await listenClient.listen(CHAT_UPDATED_CHANNEL, (payload) => {
        if (!payload) return;
        // payload is the bare chatId (a UUID).
        const chatId = payload;
        for (const handler of chatUpdatedHandlers) {
          try {
            handler({ chatId });
          } catch {
            // swallow — handler errors must not poison fan-out
          }
        }
      });
      unlistenChatUpdatedFn = chatUpdatedResult.unlisten;

      const meChatsChangedResult = await listenClient.listen(ME_CHATS_CHANNEL, (payload) => {
        if (!payload) return;
        // payload format: "humanAgentId:organizationId" — both are UUIDs (no
        // colons), so the first separator wins.
        const sep = payload.indexOf(":");
        if (sep <= 0) return;
        const humanAgentId = payload.slice(0, sep);
        const organizationId = payload.slice(sep + 1);
        for (const handler of meChatsChangedHandlers) {
          try {
            handler({ humanAgentId, organizationId });
          } catch {
            // swallow — handler errors must not poison fan-out
          }
        }
      });
      unlistenMeChatsChangedFn = meChatsChangedResult.unlisten;

      const agentRouteResult = await listenClient.listen(AGENT_ROUTE_CHANNEL, (payload) => {
        if (!payload) return;
        try {
          const parsed = JSON.parse(payload) as Partial<AgentRouteChangePayload>;
          if (
            typeof parsed.agentId !== "string" ||
            (parsed.name !== null && typeof parsed.name !== "string") ||
            typeof parsed.displayName !== "string" ||
            typeof parsed.agentType !== "string" ||
            (parsed.oldClientId !== null && typeof parsed.oldClientId !== "string") ||
            typeof parsed.targetClientId !== "string" ||
            typeof parsed.runtimeProvider !== "string" ||
            typeof parsed.reason !== "string"
          ) {
            return;
          }
          for (const handler of agentRouteHandlers) {
            try {
              handler(parsed as AgentRouteChangePayload);
            } catch {
              // swallow — handler errors must not poison fan-out
            }
          }
        } catch {
          // ignore malformed payloads
        }
      });
      unlistenAgentRouteFn = agentRouteResult.unlisten;

      const daemonClientCommandResult = await listenClient.listen(DAEMON_CLIENT_COMMAND_CHANNEL, (payload) => {
        if (!payload) return;
        try {
          const parsed = JSON.parse(payload) as Partial<DaemonClientCommandPayload>;
          if (
            typeof parsed.type !== "string" ||
            typeof parsed.clientId !== "string" ||
            typeof parsed.provider !== "string" ||
            typeof parsed.ref !== "string" ||
            typeof parsed.targetInstanceId !== "string"
          ) {
            return;
          }
          for (const handler of daemonClientCommandHandlers) {
            try {
              handler(parsed as DaemonClientCommandPayload);
            } catch {
              // swallow — handler errors must not poison fan-out
            }
          }
        } catch {
          // ignore malformed payloads
        }
      });
      unlistenDaemonClientCommandFn = daemonClientCommandResult.unlisten;

      const daemonClientCommandResultWake = await listenClient.listen(
        DAEMON_CLIENT_COMMAND_RESULT_CHANNEL,
        (payload) => {
          if (!payload) return;
          try {
            const parsed = JSON.parse(payload) as Partial<DaemonClientCommandResultPayload>;
            if (typeof parsed.clientId !== "string" || typeof parsed.ref !== "string") {
              return;
            }
            for (const handler of daemonClientCommandResultHandlers) {
              try {
                handler(parsed as DaemonClientCommandResultPayload);
              } catch {
                // swallow — handler errors must not poison fan-out
              }
            }
          } catch {
            // ignore malformed payloads
          }
        },
      );
      unlistenDaemonClientCommandResultFn = daemonClientCommandResultWake.unlisten;
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
      if (unlistenSessionRuntimeFn) {
        await unlistenSessionRuntimeFn();
        unlistenSessionRuntimeFn = null;
      }
      if (unlistenChatMessageFn) {
        await unlistenChatMessageFn();
        unlistenChatMessageFn = null;
      }
      if (unlistenChatAudienceFn) {
        await unlistenChatAudienceFn();
        unlistenChatAudienceFn = null;
      }
      if (unlistenChatUpdatedFn) {
        await unlistenChatUpdatedFn();
        unlistenChatUpdatedFn = null;
      }
      if (unlistenMeChatsChangedFn) {
        await unlistenMeChatsChangedFn();
        unlistenMeChatsChangedFn = null;
      }
      if (unlistenAgentRouteFn) {
        await unlistenAgentRouteFn();
        unlistenAgentRouteFn = null;
      }
      if (unlistenDaemonClientCommandFn) {
        await unlistenDaemonClientCommandFn();
        unlistenDaemonClientCommandFn = null;
      }
      if (unlistenDaemonClientCommandResultFn) {
        await unlistenDaemonClientCommandResultFn();
        unlistenDaemonClientCommandResultFn = null;
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
