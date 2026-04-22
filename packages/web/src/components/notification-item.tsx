import type { MouseEventHandler } from "react";
import { cn, formatDate } from "../lib/utils.js";

/**
 * Shared, workspace-styled notification row. Used by both the topbar bell
 * popover and the workspace right-rail Notifications panel so the two
 * surfaces never drift apart visually.
 *
 * Visual conventions (matches workspace aesthetic):
 *   - Left-edge severity stripe (red / yellow / dim-accent)
 *   - Mono uppercase type label
 *   - Absolute timestamp (locale-formatted)
 *   - Unread rows get a raised background
 */

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  agent_error: "Error",
  session_error: "Error",
  agent_blocked: "Blocked",
  agent_stale: "Stale",
  agent_disconnected: "Disconnected",
  agent_connected: "Connected",
  agent_needs_decision: "Decision",
  session_completed: "Completed",
};

function severityColor(severity: string): string {
  switch (severity) {
    case "high":
      return "var(--state-error)";
    case "medium":
      return "var(--state-blocked)";
    default:
      return "var(--accent-dim)";
  }
}

export type NotificationRow = {
  id: string;
  type: string;
  severity: string;
  message: string;
  read: boolean;
  chatId: string | null;
  createdAt: string;
};

export function NotificationItem({
  notification,
  onClick,
  clickable,
}: {
  notification: NotificationRow;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /**
   * When true, the row shows a pointer cursor and hover highlight. Set to
   * false for rows that lack a meaningful navigation target (e.g. bell
   * popover entries with no chat link) so users aren't baited into a click
   * that does nothing.
   */
  clickable?: boolean;
}) {
  const label = (NOTIFICATION_TYPE_LABELS[notification.type] ?? notification.type).toString();
  const stripe = severityColor(notification.severity);
  const isClickable = clickable ?? true;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("w-full text-left transition-colors", isClickable ? "cursor-pointer" : "cursor-default")}
      style={{
        padding: "6px 8px",
        background: !notification.read ? "var(--bg-sunken)" : "transparent",
        borderLeft: `2px solid ${stripe}`,
        borderRadius: "0 3px 3px 0",
        fontSize: 13,
      }}
      onMouseEnter={(e) => {
        if (isClickable) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = !notification.read ? "var(--bg-sunken)" : "transparent";
      }}
    >
      <div className="flex items-baseline justify-between" style={{ gap: 8 }}>
        <span
          className="mono uppercase"
          style={{
            fontSize: 11,
            letterSpacing: 0.08,
            color: notification.severity === "high" ? "var(--state-error)" : "var(--fg-3)",
          }}
        >
          {label.replace("_", " ")}
        </span>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg-4)", whiteSpace: "nowrap" }}>
          {formatDate(notification.createdAt)}
        </span>
      </div>
      <div style={{ color: "var(--fg-2)", marginTop: 1, wordBreak: "break-word" }}>{notification.message}</div>
    </button>
  );
}
