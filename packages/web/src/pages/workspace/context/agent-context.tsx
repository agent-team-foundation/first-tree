import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { getActivityOverview, type RuntimeAgent } from "../../../api/activity.js";
import { listNotifications, markNotificationRead } from "../../../api/notifications.js";
import { FirstTreeLogo } from "../../../components/first-tree-logo.js";
import { NotificationItem } from "../../../components/notification-item.js";
import { StateChip } from "../../../components/ui/state-chip.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { useClientMap } from "../../../lib/use-client-map.js";
import { KV, KVRow, SectionLabel } from "./_shared.js";

function formatUptime(connectedAt: string | null): string {
  if (!connectedAt) return "—";
  const ms = Date.now() - new Date(connectedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function Tile({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div
      style={{
        padding: "var(--sp-1_5) var(--sp-2)",
        background: "var(--bg-sunken)",
        borderRadius: "var(--radius-input)",
      }}
    >
      <div className="mono uppercase text-caption" style={{ color: "var(--fg-4)" }}>
        {label}
      </div>
      <div className="mono text-subtitle" style={{ color: accent ?? "var(--fg)" }}>
        {value}
      </div>
    </div>
  );
}

function NotificationList({
  notifications,
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
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const markReadMut = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    // Broad-invalidate so the topbar bell's unread count, bell list, and any
    // other per-agent panel refresh in lockstep — otherwise the bell badge
    // lingers for up to 10s after a workspace-side click.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  return (
    <div className="flex flex-col" style={{ gap: 4 }}>
      {notifications.map((n) => (
        <NotificationItem
          key={n.id}
          notification={n}
          clickable={!!n.chatId}
          onClick={() => {
            if (!n.read) markReadMut.mutate(n.id);
            if (n.chatId) {
              // Preserve other query params (`engagement` etc.) — clobbering
              // the param set drops the user's filter context.
              const next = new URLSearchParams(searchParams);
              next.set("c", n.chatId);
              setSearchParams(next);
            }
          }}
        />
      ))}
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
          padding: "var(--sp-3) var(--sp-3_5)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
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
              border: "var(--hairline) solid var(--border-strong)",
            }}
          >
            <FirstTreeLogo width={14} height={16} style={{ color: "var(--accent)" }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-subtitle" style={{ color: "var(--fg)" }}>
              {displayName}
            </div>
            <div className="mono truncate text-body" style={{ color: "var(--fg-4)" }}>
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
          padding: "var(--sp-3) var(--sp-3_5)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <SectionLabel>Computer · runtime</SectionLabel>
        <KV>
          <KVRow label="host">
            <span className="mono text-label">{client?.hostname ?? "—"}</span>
          </KVRow>
          <KVRow label="os">
            <span className="mono text-label">{client?.os ?? "—"}</span>
          </KVRow>
          <KVRow label="runtime">
            <span className="mono">{agent?.runtimeType ?? "—"}</span>
          </KVRow>
          <KVRow label="sdk">
            <span className="mono text-label">{client?.sdkVersion ?? "—"}</span>
          </KVRow>
          <KVRow label="connected">
            <span className="mono text-label">{formatUptime(client?.connectedAt ?? null)}</span>
          </KVRow>
        </KV>
      </div>

      {/* Links */}
      <div
        style={{
          padding: "var(--sp-2_5) var(--sp-3_5)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
        className="flex flex-col"
      >
        <a href={`/agents/${agentId}`} style={{ color: "var(--accent)" }} className="hover:underline text-label">
          Manage agent →
        </a>
        <a href="/clients" style={{ color: "var(--accent)", marginTop: 4 }} className="hover:underline text-label">
          Computers →
        </a>
      </div>

      {/* Notifications */}
      <div style={{ padding: "var(--sp-3) var(--sp-3_5)" }}>
        <SectionLabel>Notifications</SectionLabel>
        {!notifications?.items || notifications.items.length === 0 ? (
          <div className="text-center text-label" style={{ color: "var(--fg-3)", padding: "var(--sp-3) 0" }}>
            No notifications for this agent
          </div>
        ) : (
          <NotificationList notifications={notifications.items} />
        )}
      </div>
    </div>
  );
}
