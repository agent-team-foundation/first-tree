import type { AgentChatStatus, ChatParticipantDetail } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";

// Hold the hopeful "coming online" framing this long before escalating to the
// reconnect action. A just-created agent (onboarding's first chat) or a
// momentarily-dropped one usually binds within a few seconds, so we only frame
// it as "needs reconnect" once it is genuinely overdue.
const STARTING_GRACE_MS = 8_000;

export type OfflineNoticePhase = "starting" | "offline";

/**
 * Presentational inline notice (no data deps) — exported so the DEV preview and
 * tests render both phases directly. `starting` holds the hopeful framing during
 * the grace window; `offline` escalates to the reconnect action.
 */
export function OfflineNotice({
  phase,
  agentName,
  onReconnect,
}: {
  phase: OfflineNoticePhase;
  agentName: string;
  onReconnect: () => void;
}) {
  return (
    <div className="flex justify-center" style={{ margin: "var(--sp-2) 0 var(--sp-1)" }}>
      <div
        role="status"
        className="text-caption inline-flex items-center"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-1_75) var(--sp-3)",
          borderRadius: "var(--radius-input)",
          background: "var(--bg-sunken)",
          color: "var(--fg-3)",
        }}
      >
        {phase === "offline" ? (
          <>
            <span>{`${agentName} is offline — anything you send will start once its computer reconnects.`}</span>
            <button
              type="button"
              className="font-medium underline underline-offset-2 shrink-0"
              style={{ color: "var(--primary)" }}
              onClick={onReconnect}
            >
              Reconnect
            </button>
          </>
        ) : (
          <span>{`${agentName} is coming online…`}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Inline timeline notice for "you're waiting on an agent whose runtime is
 * offline". Most visible in onboarding's first chat: a just-created agent that
 * never comes online would otherwise leave a silent, dead chat — no sign the
 * agent is offline, no way out (the agent IS the product, so offline = nothing
 * happens). Rendered where the agent's reply would appear, it names the state
 * and routes to the one action that fixes it: reconnect the computer.
 *
 * Shown only when (a) a non-human agent in this chat is offline AND (b) the user
 * is awaiting its reply (the latest turn isn't the agent's) — so a finished chat
 * whose agent later sleeps stays quiet. General to any chat, not onboarding-only.
 */
export function ChatOfflineNotice({
  chatId,
  agents,
  awaitingReply,
}: {
  chatId: string;
  /** Non-human agent participants of this chat. */
  agents: ChatParticipantDetail[];
  /** True when the latest turn is not the agent's, i.e. a reply is expected. */
  awaitingReply: boolean;
}) {
  const navigate = useNavigate();
  const enabled = awaitingReply && agents.length > 0;
  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000, // safety net; admin-WS invalidation is the live path
    enabled,
  });

  const byAgent = new Map<string, AgentChatStatus>((statuses ?? []).map((s) => [s.agentId, s]));
  // An agent with no status row yet is treated as offline: a freshly-created
  // agent that hasn't reported in is exactly the case we want to surface.
  const offlineAgent = enabled
    ? agents.find((a) => (byAgent.get(a.agentId)?.main ?? "offline") === "offline")
    : undefined;
  const offlineAgentId = offlineAgent?.agentId ?? null;

  // Local grace timer: hold "coming online" briefly, then escalate. Re-armed
  // whenever the awaited offline agent changes (or clears).
  const [graceElapsed, setGraceElapsed] = useState(false);
  useEffect(() => {
    setGraceElapsed(false);
    if (!offlineAgentId) return;
    const timer = window.setTimeout(() => setGraceElapsed(true), STARTING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [offlineAgentId]);

  if (!offlineAgent) return null;

  return (
    <OfflineNotice
      phase={graceElapsed ? "offline" : "starting"}
      agentName={offlineAgent.displayName}
      onReconnect={() => navigate("/settings/computers")}
    />
  );
}
