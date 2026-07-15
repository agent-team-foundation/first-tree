import type { AgentChatStatus, ChatParticipantDetail } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { useAuth } from "../../auth/auth-context.js";
import { useOrgAgents } from "../../lib/use-org-agents.js";

// Hold the hopeful "coming online" framing this long before escalating to the
// reconnect action. A just-created agent (onboarding's first chat) or a
// momentarily-dropped one usually binds within a few seconds, so we only frame
// it as "needs reconnect" once it is genuinely overdue.
const STARTING_GRACE_MS = 8_000;

export type OfflineNoticePhase = "starting" | "offline";

/**
 * The non-human agents a turn awaits a reply from: the latest message's persisted
 * routed recipients (`metadata.addressedAgentIds` — the active non-human agents
 * the server actually routed it to, including system `addressedToAgentIds` such
 * as the onboarding kickoff bootstrap, which carries no `mentions`), intersected
 * with the chat's non-human participants. Routing-derived, never a sender
 * heuristic, so a group chat never flags an offline agent the latest turn did
 * not address.
 */
export function awaitedAgentsFromMessage(
  latestMessageMeta: Record<string, unknown> | null | undefined,
  nonHumanAgents: ChatParticipantDetail[],
): ChatParticipantDetail[] {
  const raw = latestMessageMeta?.addressedAgentIds;
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return [];
  return nonHumanAgents.filter((a) => ids.includes(a.agentId));
}

/**
 * Presentational inline notice (no data deps) — exported so the DEV preview and
 * tests render both phases directly. `starting` holds the hopeful framing during
 * the grace window; `offline` escalates to the reconnect action.
 */
export function OfflineNotice({
  phase,
  agentName,
  onReconnect,
  teammateComputer = false,
}: {
  phase: OfflineNoticePhase;
  agentName: string;
  onReconnect: () => void;
  /**
   * True when the offline agent runs on ANOTHER member's computer (a teammate's
   * org-visible agent). The viewer can't reconnect a machine they don't own, so
   * the notice names where the agent runs instead of offering a dead
   * "Reconnect" action.
   */
  teammateComputer?: boolean;
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
          teammateComputer ? (
            <span>{`${agentName} is offline — it runs on a teammate's computer and will pick this up when that computer reconnects.`}</span>
          ) : (
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
          )
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
 * `agents` are the non-human agents THIS turn awaits a reply from — the caller
 * derives them from the latest message's structured routing (metadata.mentions),
 * not a sender heuristic, so a group chat never flags an offline agent the latest
 * message didn't address. General to any chat, not onboarding-only.
 */
export function ChatOfflineNotice({
  chatId,
  agents,
}: {
  chatId: string;
  /** Non-human agents this turn is awaiting a reply from (routing-derived). */
  agents: ChatParticipantDetail[];
}) {
  const navigate = useNavigate();
  const enabled = agents.length > 0;
  const { data: statuses, isSuccess } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000, // safety net; admin-WS invalidation is the live path
    enabled,
  });

  // Only interpret status once the query has SUCCEEDED: a not-yet-loaded query
  // must not read as "offline" (that would flash "coming online" → reconnect on a
  // normal online-agent chat open). The /agent-status contract returns a row for
  // every non-human speaker (an unbound agent is main:"offline"), so a real
  // offline agent is an explicit "offline" row, not a missing one.
  const byAgent = new Map<string, AgentChatStatus>((statuses ?? []).map((s) => [s.agentId, s]));
  const offlineAgent = isSuccess ? agents.find((a) => byAgent.get(a.agentId)?.main === "offline") : undefined;
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

  // A teammate's org-visible agent runs on ITS OWNER's computer — the viewer
  // can't reconnect a machine they don't own, so the notice swaps the dead
  // "Reconnect" action for a where-it-runs explanation. Resolved from the
  // shared org roster cache; an agent we can't find there (e.g. beyond the
  // first roster page) keeps the reconnect action rather than hiding a
  // possibly-valid fix.
  const { memberId } = useAuth();
  const roster = useOrgAgents({ enabled: !!offlineAgentId });
  const rosterAgent = offlineAgentId ? (roster.data?.items ?? []).find((a) => a.uuid === offlineAgentId) : undefined;
  const teammateComputer = !!rosterAgent?.managerId && !!memberId && rosterAgent.managerId !== memberId;

  if (!offlineAgent) return null;

  return (
    <OfflineNotice
      phase={graceElapsed ? "offline" : "starting"}
      agentName={offlineAgent.displayName}
      onReconnect={() => navigate("/settings/computers")}
      teammateComputer={teammateComputer}
    />
  );
}
