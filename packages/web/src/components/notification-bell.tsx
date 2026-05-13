import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../api/notifications.js";
import { NotificationItem, type NotificationRow } from "./notification-item.js";

/**
 * Topbar notification bell. Visually aligned with the workspace right-rail
 * Notifications panel (same row styling via {@link NotificationItem}) so the
 * two surfaces feel like one feature rendered in two places, not two forks.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Both queries refetch on demand only — the admin WS hook (mounted by
  // `PulseProvider` at the auth-shell root) invalidates `["notifications",
  // …]` on every inbound `notification` frame, which is what drives the
  // bell to refresh. Polling was previously the safety net for an in-memory
  // cross-instance fanout that could silently drop frames; with PG NOTIFY
  // routing pushes across every server instance, polling adds nothing but
  // network noise. Reconnect-time catch-up (sleep/wake, network partition)
  // is handled by `use-admin-ws.ts` invalidating the same key on `onopen`.
  const { data } = useQuery({
    queryKey: ["notifications", "bell"],
    queryFn: () => listNotifications({ limit: 8 }),
  });

  const { data: unreadData } = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => getUnreadNotificationCount(),
  });

  const unreadCount = unreadData?.count ?? 0;
  const hasUnread = unreadCount > 0;

  const handleClickNotification = useCallback(
    async (n: NotificationRow & { agentId: string | null }) => {
      if (!n.read) {
        markNotificationRead(n.id).catch(() => {});
        // Local optimism so the unread count + row background update before
        // the refetch lands. Broad invalidate follows to keep everything
        // eventually-consistent with server state.
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
      }
      setOpen(false);
      // Two navigation targets, in priority order:
      //   - `chatId` → the workspace chat the event happened in (currently
      //     only `session_*` events, but the schema leaves room).
      //   - `agentId` → the per-agent detail page. Fault-scoped events
      //     (error / blocked / stale) carry only an agent id, so this is
      //     where the user lands to triage.
      // A row with neither is rendered non-clickable below, so the handler
      // never sees that case.
      if (n.chatId) navigate(`/?c=${n.chatId}`);
      else if (n.agentId) navigate(`/agents/${n.agentId}`);
    },
    [navigate, queryClient],
  );

  // Without an invalidate, the red badge stays up to 10s (refetchInterval)
  // after the API succeeds — visually indistinguishable from "nothing
  // happened". Broad-invalidate every `["notifications", …]` key so the
  // bell list, unread count, and per-agent panels all refresh in lockstep
  // — targeted invalidates miss any future consumer keyed on
  // `["notifications", "agent", id]` or a yet-unbuilt list page. Surface
  // failures inline since we don't have a toast system yet.
  const handleMarkAll = useCallback(async () => {
    setMarkAllError(null);
    try {
      await markAllNotificationsRead();
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } catch (err) {
      setMarkAllError(err instanceof Error ? err.message : "Failed to mark all as read");
    }
  }, [queryClient]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <Bell className="h-4 w-4" />
        {hasUnread && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full px-1 font-medium text-label"
            style={{
              height: 16,
              minWidth: 16,
              background: "var(--state-error)",
              color: "var(--bg)",
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            ref={popoverRef}
            className="absolute right-0 top-full mt-1 z-50"
            style={{
              width: 320,
              background: "var(--bg-raised)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: 6,
              boxShadow: "var(--shadow-md)",
            }}
          >
            {/* Header — matches workspace SectionLabel cadence */}
            <div
              className="flex items-center justify-between"
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                borderBottom: "var(--hairline) solid var(--border-faint)",
              }}
            >
              <span className="mono uppercase text-eyebrow" style={{ color: "var(--fg-4)" }}>
                Notifications
              </span>
              {hasUnread && (
                <button
                  type="button"
                  onClick={handleMarkAll}
                  className="hover:underline text-body"
                  style={{ color: "var(--accent)" }}
                >
                  Mark all read
                </button>
              )}
            </div>

            {markAllError && (
              <div
                className="text-body"
                style={{
                  padding: "var(--sp-1_5) var(--sp-3)",
                  color: "var(--state-error)",
                  background: "var(--bg-sunken)",
                  borderBottom: "var(--hairline) solid var(--border-faint)",
                }}
              >
                {markAllError}
              </div>
            )}

            <div className="flex flex-col overflow-y-auto" style={{ maxHeight: 360, padding: 8, gap: 4 }}>
              {!data?.items || data.items.length === 0 ? (
                <div className="text-center text-body" style={{ color: "var(--fg-3)", padding: "var(--sp-4_5) 0" }}>
                  No notifications
                </div>
              ) : (
                data.items.map((n) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    clickable={!!n.chatId || !!n.agentId}
                    onClick={() => handleClickNotification(n)}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
