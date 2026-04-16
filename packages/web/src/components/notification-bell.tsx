import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../api/notifications.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { cn } from "../lib/utils.js";

function severityDot(severity: string) {
  switch (severity) {
    case "high":
      return "bg-red-500";
    case "medium":
      return "bg-yellow-500";
    default:
      return "bg-gray-400";
  }
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const agentName = useAgentNameMap();

  const { data } = useQuery({
    queryKey: ["notifications", "bell"],
    queryFn: () => listNotifications({ limit: 5 }),
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
    async (n: { id: string; agentId: string | null; chatId: string | null; read: boolean }) => {
      if (!n.read) {
        markNotificationRead(n.id).catch(() => {});
      }
      setOpen(false);
      if (n.agentId && n.chatId) {
        navigate(`/?a=${n.agentId}&c=${n.chatId}`);
      } else if (n.agentId) {
        navigate(`/?a=${n.agentId}`);
      }
    },
    [navigate],
  );

  const handleMarkAll = useCallback(() => {
    markAllNotificationsRead().catch(() => {});
  }, []);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        <Bell className="h-4 w-4" />
        {hasUnread && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            ref={popoverRef}
            className="absolute right-0 top-full mt-1 z-50 w-80 rounded-md border border-border bg-card shadow-lg"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-sm font-medium">Notifications</span>
              {hasUnread && (
                <button
                  type="button"
                  onClick={handleMarkAll}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Mark all
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {!data?.items || data.items.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">No notifications</div>
              ) : (
                data.items.map((n) => (
                  <button
                    type="button"
                    key={n.id}
                    onClick={() => handleClickNotification(n)}
                    className={cn(
                      "w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors",
                      !n.read && "bg-accent/20",
                    )}
                  >
                    <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", severityDot(n.severity))} />
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm truncate", !n.read && "font-medium")}>{n.message}</p>
                      <p className="text-xs text-muted-foreground">
                        {n.agentId ? agentName(n.agentId) : ""} {relativeTime(n.createdAt)}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
