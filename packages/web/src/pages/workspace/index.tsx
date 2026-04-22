import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { listAgentSessions } from "../../api/sessions.js";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { CenterPanel } from "./center/index.js";
import { ContextPanel } from "./context/index.js";
import { AgentRoster } from "./roster/index.js";

export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAgentId = searchParams.get("a");
  const selectedChatId = searchParams.get("c");

  useAdminWs();

  const selectAgent = useCallback(
    (agentId: string | null) => {
      if (!agentId) {
        setSearchParams({});
      } else {
        setSearchParams({ a: agentId });
      }
    },
    [setSearchParams],
  );

  const selectChat = useCallback(
    (agentId: string, chatId: string) => {
      setSearchParams({ a: agentId, c: chatId });
    },
    [setSearchParams],
  );

  const { data: agentSessions } = useQuery({
    queryKey: ["agent-sessions", selectedAgentId],
    queryFn: () => (selectedAgentId ? listAgentSessions(selectedAgentId) : Promise.resolve([])),
    enabled: !!selectedAgentId && !selectedChatId,
  });

  // Auto-redirect: when an agent is selected but no chat, jump to the most recent
  // non-terminated chat. Server already hides `evicted` from this listing; the
  // local filter is a belt-and-suspenders guard during optimistic-update windows.
  useEffect(() => {
    if (!selectedAgentId || selectedChatId) return;
    if (!agentSessions || agentSessions.length === 0) return;
    const latest = [...agentSessions]
      .filter((s) => s.state !== "evicted")
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))[0];
    if (latest) {
      setSearchParams({ a: selectedAgentId, c: latest.chatId }, { replace: true });
    }
  }, [selectedAgentId, selectedChatId, agentSessions, setSearchParams]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <AgentRoster
        selectedAgentId={selectedAgentId}
        selectedChatId={selectedChatId}
        onSelectAgent={selectAgent}
        onSelectChat={selectChat}
      />

      <main className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ background: "var(--bg)" }}>
        <CenterPanel selectedAgentId={selectedAgentId} selectedChatId={selectedChatId} />
      </main>

      {selectedAgentId && (
        <aside
          className="shrink-0 flex flex-col overflow-hidden"
          style={{
            width: 290,
            borderLeft: "var(--hairline) solid var(--border)",
            background: "var(--bg-raised)",
          }}
        >
          <ContextPanel selectedAgentId={selectedAgentId} selectedChatId={selectedChatId} />
        </aside>
      )}
    </div>
  );
}
