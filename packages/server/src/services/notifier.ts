import type postgres from "postgres";
import type { WebSocket } from "ws";

const INBOX_CHANNEL = "inbox_notifications";
const CONFIG_CHANNEL = "config_changes";
const SESSION_STATE_CHANNEL = "session_state_changes";

export type ConfigChangeHandler = (channel: string) => void;
export type SessionStateChangeHandler = (payload: { agentId: string; chatId: string; state: string }) => void;

export type Notifier = {
  /** Subscribe a WebSocket connection for an inbox */
  subscribe(inboxId: string, ws: WebSocket): void;
  /** Unsubscribe a WebSocket connection */
  unsubscribe(inboxId: string, ws: WebSocket): void;
  /** Notify that new messages are available for an inbox */
  notify(inboxId: string, messageId: string): Promise<void>;
  /** Notify that a config has changed */
  notifyConfigChange(configType: string): Promise<void>;
  /** Notify that a session state has changed */
  notifySessionStateChange(agentId: string, chatId: string, state: string): Promise<void>;
  /** Register a handler for config change notifications */
  onConfigChange(handler: ConfigChangeHandler): void;
  /** Register a handler for session state change notifications */
  onSessionStateChange(handler: SessionStateChangeHandler): void;
  /** Start listening for PG notifications */
  start(): Promise<void>;
  /** Stop listening */
  stop(): Promise<void>;
};

export function createNotifier(listenClient: postgres.Sql): Notifier {
  const subscriptions = new Map<string, Set<WebSocket>>();
  const configChangeHandlers: ConfigChangeHandler[] = [];
  const sessionStateChangeHandlers: SessionStateChangeHandler[] = [];
  let unlistenInboxFn: (() => Promise<void>) | null = null;
  let unlistenConfigFn: (() => Promise<void>) | null = null;
  let unlistenSessionStateFn: (() => Promise<void>) | null = null;

  function handleNotification(payload: string) {
    // payload format: "inboxId:messageId"
    const sepIdx = payload.indexOf(":");
    if (sepIdx === -1) return;
    const inboxId = payload.slice(0, sepIdx);
    const messageId = payload.slice(sepIdx + 1);

    const sockets = subscriptions.get(inboxId);
    if (!sockets) return;

    const data = JSON.stringify({ type: "new_message", inboxId, messageId });
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  return {
    subscribe(inboxId: string, ws: WebSocket) {
      let set = subscriptions.get(inboxId);
      if (!set) {
        set = new Set();
        subscriptions.set(inboxId, set);
      }
      set.add(ws);
    },

    unsubscribe(inboxId: string, ws: WebSocket) {
      const set = subscriptions.get(inboxId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
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

    async notifySessionStateChange(agentId: string, chatId: string, state: string) {
      try {
        await listenClient`SELECT pg_notify(${SESSION_STATE_CHANNEL}, ${`${agentId}:${chatId}:${state}`})`;
      } catch {
        // fire-and-forget
      }
    },

    onConfigChange(handler: ConfigChangeHandler) {
      configChangeHandlers.push(handler);
    },

    onSessionStateChange(handler: SessionStateChangeHandler) {
      sessionStateChangeHandlers.push(handler);
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
          // payload format: "agentId:chatId:state"
          const firstSep = payload.indexOf(":");
          const secondSep = payload.indexOf(":", firstSep + 1);
          if (firstSep > 0 && secondSep > firstSep) {
            const agentId = payload.slice(0, firstSep);
            const chatId = payload.slice(firstSep + 1, secondSep);
            const state = payload.slice(secondSep + 1);
            for (const handler of sessionStateChangeHandlers) {
              handler({ agentId, chatId, state });
            }
          }
        }
      });
      unlistenSessionStateFn = sessionStateResult.unlisten;
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
    },
  };
}

/** Fire-and-forget: notify all recipients that a new message is available. */
export function notifyRecipients(notifier: Notifier, recipients: string[], messageId: string): void {
  for (const inboxId of recipients) {
    notifier.notify(inboxId, messageId).catch(() => {});
  }
}
