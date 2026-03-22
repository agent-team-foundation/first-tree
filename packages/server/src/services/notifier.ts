import type postgres from "postgres";
import type { WebSocket } from "ws";

const CHANNEL = "inbox_notifications";

export type Notifier = {
  /** Subscribe a WebSocket connection for an inbox */
  subscribe(inboxId: string, ws: WebSocket): void;
  /** Unsubscribe a WebSocket connection */
  unsubscribe(inboxId: string, ws: WebSocket): void;
  /** Notify that new messages are available for an inbox */
  notify(inboxId: string, messageId: string): Promise<void>;
  /** Start listening for PG notifications */
  start(): Promise<void>;
  /** Stop listening */
  stop(): Promise<void>;
};

export function createNotifier(listenClient: postgres.Sql): Notifier {
  const subscriptions = new Map<string, Set<WebSocket>>();
  let unlistenFn: (() => Promise<void>) | null = null;

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
        await listenClient`SELECT pg_notify(${CHANNEL}, ${`${inboxId}:${messageId}`})`;
      } catch {
        // fire-and-forget: notification loss is acceptable, polling covers it
      }
    },

    async start() {
      const result = await listenClient.listen(CHANNEL, (payload) => {
        if (payload) handleNotification(payload);
      });
      unlistenFn = result.unlisten;
    },

    async stop() {
      if (unlistenFn) {
        await unlistenFn();
        unlistenFn = null;
      }
    },
  };
}
