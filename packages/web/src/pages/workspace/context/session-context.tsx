import { useQuery } from "@tanstack/react-query";
import { listAgentSessions } from "../../../api/sessions.js";
import { StateChip } from "../../../components/ui/state-chip.js";
import { formatRelative, KV, KVRow, SectionLabel } from "./_shared.js";
import { AgentContext } from "./agent-context.js";

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
            <span className="mono" style={{ fontSize: 12.5 }}>
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
