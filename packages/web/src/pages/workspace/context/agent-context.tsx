import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Leaf } from "lucide-react";
import { useSearchParams } from "react-router";
import { getActivityOverview, type RuntimeAgent } from "../../../api/activity.js";
import { listNotifications, markNotificationRead } from "../../../api/notifications.js";
import { StateChip } from "../../../components/ui/state-chip.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { useClientMap } from "../../../lib/use-client-map.js";
import { cn, formatDate } from "../../../lib/utils.js";
import { KV, KVRow, SectionLabel } from "./_shared.js";

function formatUptime(connectedAt: string | null): string {
  if (!connectedAt) return "\u2014";
  const ms = Date.now() - new Date(connectedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

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

function Tile({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div
      style={{
        padding: "6px 8px",
        background: "var(--bg-sunken)",
        borderRadius: 4,
      }}
    >
      <div className="mono uppercase" style={{ fontSize: 9, color: "var(--fg-4)", letterSpacing: 0.08 }}>
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: accent ?? "var(--fg)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function NotificationList({
  notifications,
  agentId,
}: {
  notifications: Array<{
    id: string;
    type: string;
    severity: string;
    message: string;
    read: boolean;
    chatId: string | null;
    createdAt: string;
  }>;
  agentId: string;
}) {
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const markReadMut = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications", "agent", agentId] });
    },
  });

  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      {notifications.map((n) => {
        const hasChatLink = !!n.chatId;
        const label = (NOTIFICATION_TYPE_LABELS[n.type] ?? n.type).toString();
        const severityColor =
          n.severity === "high"
            ? "var(--state-error)"
            : n.severity === "medium"
              ? "var(--state-blocked)"
              : "var(--accent-dim)";
        return (
          <button
            key={n.id}
            type="button"
            className={cn("w-full text-left transition-colors", hasChatLink && "cursor-pointer")}
            style={{
              padding: "6px 8px",
              background: !n.read ? "var(--bg-sunken)" : "transparent",
              borderLeft: `2px solid ${severityColor}`,
              borderRadius: "0 3px 3px 0",
              fontSize: 11,
            }}
            onMouseEnter={(e) => {
              if (hasChatLink) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = !n.read ? "var(--bg-sunken)" : "transparent";
            }}
            onClick={() => {
              if (!n.read) markReadMut.mutate(n.id);
              if (n.chatId) {
                setSearchParams({ a: agentId, c: n.chatId });
              }
            }}
          >
            <div className="flex items-baseline justify-between">
              <span
                className="mono uppercase"
                style={{
                  fontSize: 9,
                  letterSpacing: 0.08,
                  color: n.severity === "high" ? "var(--state-error)" : "var(--fg-3)",
                }}
              >
                {label.replace("_", " ")}
              </span>
              <span className="mono" style={{ fontSize: 9, color: "var(--fg-4)" }}>
                {formatDate(n.createdAt)}
              </span>
            </div>
            <div style={{ color: "var(--fg-2)", marginTop: 1 }}>{n.message}</div>
          </button>
        );
      })}
    </div>
  );
}

export function AgentContext({ agentId }: { agentId: string }) {
  const agentName = useAgentNameMap();
  const { resolve: resolveClient } = useClientMap();

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 10_000,
  });

  const agent: RuntimeAgent | undefined = activity?.agents?.find((a) => a.agentId === agentId);
  const client = resolveClient(agent?.clientId);

  const { data: notifications } = useQuery({
    queryKey: ["notifications", "agent", agentId],
    queryFn: () => listNotifications({ agentId, limit: 3 }),
    refetchInterval: 30_000,
  });

  const displayName = agentName(agentId);
  const runtimeLabel = agent?.runtimeState ?? "offline";

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Agent card */}
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--border-faint)",
        }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <div
            className="flex items-center justify-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 5,
              background: "var(--bg-active)",
              border: "1px solid var(--border-strong)",
            }}
          >
            <Leaf className="h-4 w-4" style={{ color: "var(--accent)" }} />
          </div>
          <div className="flex-1 min-w-0">
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{displayName}</div>
            <div className="mono truncate" style={{ fontSize: 10, color: "var(--fg-4)" }}>
              {agentId}
            </div>
          </div>
          <StateChip state={runtimeLabel} />
        </div>
        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 4,
            marginTop: 10,
          }}
        >
          <Tile
            label="sessions"
            value={agent?.totalSessions ?? 0}
            accent={(agent?.totalSessions ?? 0) > 0 ? "var(--fg)" : "var(--fg-4)"}
          />
          <Tile
            label="active"
            value={agent?.activeSessions ?? 0}
            accent={(agent?.activeSessions ?? 0) > 0 ? "var(--accent)" : "var(--fg-4)"}
          />
          <Tile label="uptime" value={formatUptime(client?.connectedAt ?? null)} />
        </div>
      </div>

      {/* Client / runtime */}
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--border-faint)",
        }}
      >
        <SectionLabel>Computer · runtime</SectionLabel>
        <KV>
          <KVRow label="host">
            <span className="mono" style={{ fontSize: 11 }}>
              {client?.hostname ?? "\u2014"}
            </span>
          </KVRow>
          <KVRow label="os">
            <span className="mono" style={{ fontSize: 11 }}>
              {client?.os ?? "\u2014"}
            </span>
          </KVRow>
          <KVRow label="runtime">
            <span className="mono">{agent?.runtimeType ?? "\u2014"}</span>
          </KVRow>
          <KVRow label="sdk">
            <span className="mono" style={{ fontSize: 11 }}>
              {client?.sdkVersion ?? "\u2014"}
            </span>
          </KVRow>
          <KVRow label="connected">
            <span className="mono" style={{ fontSize: 11 }}>
              {formatUptime(client?.connectedAt ?? null)}
            </span>
          </KVRow>
        </KV>
      </div>

      {/* Links */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border-faint)",
        }}
        className="flex flex-col"
      >
        <a href={`/agents/${agentId}`} style={{ fontSize: 11, color: "var(--accent)" }} className="hover:underline">
          Manage agent →
        </a>
        <a href="/clients" style={{ fontSize: 11, color: "var(--accent)", marginTop: 4 }} className="hover:underline">
          Computers →
        </a>
      </div>

      {/* Notifications */}
      <div style={{ padding: "12px 14px" }}>
        <SectionLabel>Notifications</SectionLabel>
        {!notifications?.items || notifications.items.length === 0 ? (
          <div className="text-center" style={{ fontSize: 11, color: "var(--fg-3)", padding: "12px 0" }}>
            No notifications for this agent
          </div>
        ) : (
          <NotificationList notifications={notifications.items} agentId={agentId} />
        )}
      </div>
    </div>
  );
}
