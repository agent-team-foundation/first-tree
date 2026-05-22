import { useQuery } from "@tanstack/react-query";
import { listAgentSessions } from "../../../api/sessions.js";
import { StateChip } from "../../../components/ui/state-chip.js";
import { formatRelative, KV, KVRow, SectionLabel } from "./_shared.js";
import { AgentContext } from "./agent-context.js";

export function SessionContext({ agentId, chatId }: { agentId: string; chatId: string }) {
  const { data: session } = useQuery({
    queryKey: ["session", agentId, chatId],
    queryFn: () => listAgentSessions(agentId).then((sessions) => sessions.find((s) => s.chatId === chatId) ?? null),
  });

  return (
    <div className="flex flex-col overflow-hidden flex-1">
      {/* Session KV at top */}
      <div
        style={{
          padding: "var(--sp-3) var(--sp-3_5)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <SectionLabel>Session</SectionLabel>
        <KV>
          <KVRow label="state">
            {/* Use the per-(agent, chat) session.state lifecycle (active /
                suspended / errored / evicted). The pre-fix fallback chained
                `session.runtimeState`, which is the agent-global runtime
                state — for this chat's session it was the wrong axis and
                would surface "working" while the agent was actually busy
                in a different chat. */}
            <StateChip state={session?.state ?? null} />
          </KVRow>
          <KVRow label="chat">
            <span className="mono text-body">{chatId.slice(0, 12)}</span>
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
