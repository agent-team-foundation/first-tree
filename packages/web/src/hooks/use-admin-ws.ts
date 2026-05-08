import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getStoredTokens, refreshAccessToken } from "../api/client.js";

type WsMessage = {
  type: string;
  [key: string]: unknown;
};

type UseAdminWsOptions = {
  /** Called for every incoming WS message. */
  onMessage?: (msg: WsMessage) => void;
  /** Whether the hook is enabled (default: true). */
  enabled?: boolean;
};

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

// Module-level singleton connection shared across all hook instances.
type QC = ReturnType<typeof useQueryClient>;
type Subscriber = (msg: WsMessage) => void;

let ws: WebSocket | null = null;
let closing = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<Subscriber>();
let latestQc: QC | null = null;
let refCount = 0;

function broadcast(msg: WsMessage) {
  for (const sub of subscribers) {
    try {
      sub(msg);
    } catch {
      // swallow subscriber errors to avoid poisoning siblings
    }
  }
  if (latestQc) {
    if (msg.type === "notification") {
      latestQc.invalidateQueries({ queryKey: ["notifications"] });
    } else if (msg.type === "session:state") {
      latestQc.invalidateQueries({ queryKey: ["activity"] });
      latestQc.invalidateQueries({ queryKey: ["sessions"] });
    } else if (msg.type === "chat:message") {
      // Best-effort realtime nudge for the chat-first workspace. The frame
      // carries `{ type, chatId }` (see shared/me-chat.ts:chatMessageFrameSchema);
      // we invalidate the chat list, the chat's message timeline, and the
      // chat's detail panel. Failures are swallowed — the parent broadcast
      // wraps each subscriber in try/catch and the user-facing fallback is
      // the 5s polling refetch already wired into ChatView.
      const chatId = typeof msg.chatId === "string" ? msg.chatId : null;
      latestQc.invalidateQueries({ queryKey: ["me", "chats"] });
      if (chatId) {
        latestQc.invalidateQueries({ queryKey: ["chat-messages", chatId] });
        latestQc.invalidateQueries({ queryKey: ["chat-detail", chatId] });
      }
    }
  }
}

function connect() {
  const tokens = getStoredTokens();
  if (!tokens?.accessToken) return;

  // Resolve the selected org from localStorage. The org-scoped admin WS
  // path is `/api/v1/orgs/:orgId/ws/`. If no org is selected yet, skip
  // connecting — the hook reconnects automatically once the auth
  // context populates `selectedOrganizationId`.
  let orgId: string | null = null;
  try {
    orgId = localStorage.getItem("first-tree-hub:selectedOrganizationId");
  } catch {
    orgId = null;
  }
  if (!orgId) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/v1/orgs/${encodeURIComponent(orgId)}/ws/?token=${tokens.accessToken}`;
  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.onmessage = (ev) => {
    if (socket !== ws) return;
    try {
      const msg = JSON.parse(ev.data as string) as WsMessage;
      broadcast(msg);
    } catch {
      // ignore malformed
    }
  };
  socket.onopen = () => {
    if (socket !== ws) return;
    reconnectAttempt = 0;
  };
  socket.onclose = (ev) => {
    // Only the current (latest) socket's close triggers reconnect.
    // An aborted CONNECTING socket from strict-mode unmount will also close here
    // but must not touch module state.
    if (socket !== ws) return;
    ws = null;
    if (closing || refCount === 0) return;
    // 4001 = server-side auth rejection (see ws-admin.ts close paths). The
    // most common cause is an expired access token: the WS hook reads from
    // `localStorage` but never round-trips through the HTTP refresh
    // interceptor, so without this branch a stale token would loop forever
    // (~3s cadence: handshake → 4001 → 2s backoff → repeat). Drive a refresh
    // and reconnect immediately on success.
    if (ev.code === 4001) {
      refreshAccessToken().then((fresh) => {
        if (closing || refCount === 0) return;
        if (fresh) {
          reconnectAttempt = 0;
          connect();
        } else {
          // Refresh failed — fall through to standard backoff. The HTTP path
          // will eventually surface a 401 on the next API call, dispatch
          // `auth:logout`, and tear us down via refCount=0.
          scheduleReconnect();
        }
      });
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  reconnectAttempt++;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!closing && refCount > 0) connect();
  }, delay);
}

function teardown() {
  closing = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close(1000, "unmount");
    ws = null;
  }
}

/**
 * Admin WebSocket hook — maintains a single shared connection to /api/v1/ws/admin.
 *
 * Multiple consumers may subscribe simultaneously; each gets every message.
 * The connection opens on the first subscriber and closes when the last unmounts.
 */
export function useAdminWs(options?: UseAdminWsOptions) {
  const { onMessage, enabled = true } = options ?? {};
  const queryClient = useQueryClient();
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    latestQc = queryClient;
  }, [queryClient]);

  useEffect(() => {
    if (!enabled) return;

    const subscriber: Subscriber = (msg) => onMessageRef.current?.(msg);
    subscribers.add(subscriber);
    refCount++;

    if (refCount === 1) {
      closing = false;
      connect();
    }

    return () => {
      subscribers.delete(subscriber);
      refCount--;
      if (refCount === 0) teardown();
    };
  }, [enabled]);
}
