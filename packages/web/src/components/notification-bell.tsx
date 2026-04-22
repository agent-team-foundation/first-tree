import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../api/notifications.js";
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

  const { data } = useQuery({
    queryKey: ["notifications", "bell"],
    queryFn: () => listNotifications({ limit: 8 }),
    refetchInterval: 10_000,
  });

  const { data: unreadData } = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => listNotifications({ read: false, limit: 100 }),
    refetchInterval: 10_000,
  });

  const unreadCount = unreadData?.items?.length ?? 0;
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
      if (n.agentId && n.chatId) {
        navigate(`/?a=${n.agentId}&c=${n.chatId}`);
      } else if (n.agentId) {
        navigate(`/?a=${n.agentId}`);
      }
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
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full px-1 font-medium"
            style={{
              height: 16,
              minWidth: 16,
              background: "var(--state-error)",
              color: "var(--bg)",
              fontSize: 11,
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
              border: "1px solid var(--border)",
              borderRadius: 6,
              boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            }}
          >
            {/* Header — matches workspace SectionLabel cadence */}
            <div
              className="flex items-center justify-between"
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-faint)",
              }}
            >
              <span className="mono uppercase" style={{ fontSize: 11, letterSpacing: 0.1, color: "var(--fg-4)" }}>
                Notifications
              </span>
              {hasUnread && (
                <button
                  type="button"
                  onClick={handleMarkAll}
                  className="hover:underline"
                  style={{ fontSize: 12, color: "var(--accent)" }}
                >
                  Mark all read
                </button>
              )}
            </div>

            {markAllError && (
              <div
                style={{
                  padding: "6px 12px",
                  fontSize: 13,
                  color: "var(--state-error)",
                  background: "var(--bg-sunken)",
                  borderBottom: "1px solid var(--border-faint)",
                }}
              >
                {markAllError}
              </div>
            )}

            <div className="flex flex-col overflow-y-auto" style={{ maxHeight: 360, padding: 8, gap: 4 }}>
              {!data?.items || data.items.length === 0 ? (
                <div className="text-center" style={{ fontSize: 13, color: "var(--fg-3)", padding: "18px 0" }}>
                  No notifications
                </div>
              ) : (
                data.items.map((n) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    clickable={!!n.agentId}
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
