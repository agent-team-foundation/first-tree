import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getStoredTokens } from "../api/client.js";

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

/**
 * Admin WebSocket hook — connects to /api/v1/ws/admin and provides real-time push.
 *
 * Automatically:
 * - Reconnects with exponential backoff
 * - Invalidates React Query caches on notification/session:state events
 * - Closes cleanly on unmount
 */
export function useAdminWs(options?: UseAdminWsOptions) {
  const { onMessage, enabled = true } = options ?? {};
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closingRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // Stable ref for queryClient to avoid effect re-runs
  const qcRef = useRef(queryClient);
  qcRef.current = queryClient;

  useEffect(() => {
    if (!enabled) return;

    closingRef.current = false;

    function connect() {
      const tokens = getStoredTokens();
      if (!tokens?.accessToken) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/v1/ws/admin?token=${tokens.accessToken}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as WsMessage;
          onMessageRef.current?.(msg);

          if (msg.type === "notification") {
            qcRef.current.invalidateQueries({ queryKey: ["notifications"] });
          } else if (msg.type === "session:state") {
            qcRef.current.invalidateQueries({ queryKey: ["activity"] });
            qcRef.current.invalidateQueries({ queryKey: ["sessions"] });
          }
        } catch {
          // ignore malformed
        }
      };

      ws.onopen = () => {
        reconnectAttempt.current = 0;
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!closingRef.current) {
          reconnectAttempt.current++;
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt.current - 1), RECONNECT_MAX_MS);
          reconnectTimer.current = setTimeout(() => {
            reconnectTimer.current = null;
            if (!closingRef.current) connect();
          }, delay);
        }
      };
    }

    connect();

    return () => {
      closingRef.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, "unmount");
        wsRef.current = null;
      }
    };
  }, [enabled]);
}
