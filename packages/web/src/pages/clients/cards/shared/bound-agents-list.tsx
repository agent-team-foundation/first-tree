import { PresenceChip, runtimeStateToPresence } from "../../../../components/ui/presence-chip.js";
import { UppercaseLabel } from "../../../../components/ui/section-header.js";
import type { BoundAgentsSummary } from "../view-models.js";

type BoundAgentsListProps = {
  summary: BoundAgentsSummary;
  agentName: (uuid: string | null | undefined) => string;
  /**
   * When true, render the agents list in a compact "N agent(s) — M online"
   * form instead of a full per-agent list. Used by AuthExpired / Offline
   * cards where the agents section is supporting context, not the focus.
   */
  compact?: boolean;
};

/**
 * Renders the bound-agents section of a computer card.
 *
 * Two display modes — both driven by the same `BoundAgentsSummary` from
 * `view-models.ts`:
 *
 *   - **expanded** (Ready card): full list, one row per agent, with
 *     `PresenceChip` + active/total session counts.
 *   - **compact** (AuthExpired / Offline): single-line summary like
 *     "3 agents · all offline".
 */
export function BoundAgentsList({ summary, agentName, compact = false }: BoundAgentsListProps) {
  if (summary.total === 0) {
    return null;
  }

  if (compact) {
    // Sentence: "{N} agent(s) · {state}". For total === 1 the "all" qualifier
    // reads wrong, so collapse to bare "offline" / "online".
    const noun = summary.total === 1 ? "agent" : "agents";
    const allWord = summary.total === 1 ? "" : "all ";
    let suffix: string;
    if (summary.offline === summary.total) suffix = `${allWord}offline`;
    else if (summary.online === summary.total) suffix = `${allWord}online`;
    else suffix = `${summary.offline} offline`;
    return (
      <div className="text-caption" style={{ color: "var(--fg-3)" }}>
        {summary.total} {noun} · {suffix}
      </div>
    );
  }

  return (
    <>
      <UppercaseLabel style={{ display: "block", marginBottom: 6 }}>Agents · {summary.total}</UppercaseLabel>
      <div className="flex flex-col gap-1">
        {summary.agents.map((a) => (
          <div key={a.agentId} className="flex items-center gap-2.5 text-body">
            <span className="font-medium" style={{ minWidth: 140 }}>
              {agentName(a.agentId)}
            </span>
            <PresenceChip status={runtimeStateToPresence(a.runtimeState)} />
            {a.activeSessions !== null && (
              <span className="mono tnum text-caption" style={{ color: "var(--fg-3)" }}>
                {a.activeSessions} / {a.totalSessions ?? 0} sessions
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
