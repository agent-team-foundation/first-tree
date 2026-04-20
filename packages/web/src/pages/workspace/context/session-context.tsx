import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { listAgentSessions } from "../../../api/sessions.js";
import { StateChip } from "../../../components/ui/state-chip.js";
import { AgentContext } from "./agent-context.js";

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono uppercase"
      style={{
        fontSize: 9,
        letterSpacing: 0.1,
        color: "var(--fg-4)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function KV({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "auto 1fr",
        columnGap: 10,
        rowGap: 4,
        fontSize: 11.5,
      }}
    >
      {children}
    </div>
  );
}

function KVRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div style={{ color: "var(--fg-3)" }}>{label}</div>
      <div className="text-right truncate" style={{ color: "var(--fg)" }}>
        {children}
      </div>
    </>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return "\u2014";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function SessionContext({ agentId, chatId }: { agentId: string; chatId: string }) {
  const { data: session } = useQuery({
    queryKey: ["session", agentId, chatId],
    queryFn: () => listAgentSessions(agentId).then((sessions) => sessions.find((s) => s.chatId === chatId) ?? null),
    refetchInterval: 5_000,
  });

  return (
    <div className="flex flex-col overflow-hidden flex-1">
      {/* Session KV at top */}
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid var(--border-faint)",
        }}
      >
        <SectionLabel>Session</SectionLabel>
        <KV>
          <KVRow label="state">
            <StateChip state={session?.runtimeState ?? session?.state ?? null} />
          </KVRow>
          <KVRow label="chat">
            <span className="mono" style={{ fontSize: 10.5 }}>
              {chatId.slice(0, 12)}
            </span>
          </KVRow>
          <KVRow label="started">{formatRelative(session?.startedAt ?? null)}</KVRow>
          <KVRow label="last">{formatRelative(session?.lastActivityAt ?? null)}</KVRow>
          <KVRow label="messages">
            <span className="mono">{session?.messageCount ?? 0}</span>
          </KVRow>
        </KV>
      </div>
      <AgentContext agentId={agentId} />
    </div>
  );
}
