import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getActivityOverview } from "../../../api/activity.js";
import { getChat } from "../../../api/chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { AgentRow } from "./agent-row.js";

/**
 * Agents section — lists every agent participating in the current chat
 * plus a per-row session status indicator and an admin-gated Suspend
 * button. Humans (chat members who aren't agents) are not surfaced
 * here; the chat header already names them.
 */
export function AgentsSection({ chatId }: { chatId: string }) {
  const { role } = useAuth();
  // Shares the React-Query key with chat-view's own `getChat` call so we
  // get cache reuse for free — opening a chat with the right sidebar
  // open does not fire two parallel `/chats/:id` requests.
  const chatQuery = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    enabled: !!chatId,
  });
  // `/activity` tells us which agents the current user manages —
  // combined with the org-admin role check below, this is the front-end
  // mirror of the server's `requireAgentAccess(..., "manage")` rule.
  // Hiding the button when the user lacks permission keeps unauthorised
  // clicks from ever reaching a 403.
  const activityQuery = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 15_000,
  });

  const managedByMe = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const a of activityQuery.data?.agents ?? []) m.set(a.agentId, a.managedByMe);
    return m;
  }, [activityQuery.data?.agents]);

  const agents = useMemo(
    // Two non-human variants land here: `personal_assistant` and
    // `autonomous_agent` (per `AGENT_TYPES` in shared/agent.ts). Listing
    // them by exclusion of `human` future-proofs the filter against new
    // agent variants — the sidebar should surface any non-human
    // participant regardless of subtype.
    () => (chatQuery.data?.participants ?? []).filter((p) => p.type !== "human"),
    [chatQuery.data?.participants],
  );

  const isAdmin = role === "admin";

  return (
    <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
      <div className="flex items-center justify-between" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)" }}>
        <div className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
          Agents
        </div>
        <div className="mono text-caption" style={{ color: "var(--fg-4)" }}>
          {agents.length}
        </div>
      </div>

      <div className="flex flex-col" style={{ padding: "0 var(--sp-2) var(--sp-2)", gap: 2 }}>
        {chatQuery.isLoading ? (
          <div className="text-body" style={{ padding: "var(--sp-2) var(--sp-2)", color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : agents.length === 0 ? (
          <div className="text-body" style={{ padding: "var(--sp-2) var(--sp-2)", color: "var(--fg-3)" }}>
            No agents in this chat.
          </div>
        ) : (
          agents.map((p) => (
            <AgentRow
              key={p.agentId}
              chatId={chatId}
              participant={p}
              canSuspend={isAdmin || (managedByMe.get(p.agentId) ?? false)}
            />
          ))
        )}
      </div>
    </section>
  );
}
