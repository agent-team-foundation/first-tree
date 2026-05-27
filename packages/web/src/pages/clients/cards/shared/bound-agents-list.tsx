import { PresenceChip, runtimeStateToPresence } from "../../../../components/ui/presence-chip.js";
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
  /**
   * When true, skip the in-component "Agents · N" header — the parent
   * Group is already labeling the block. Without this the Ready card
   * would render two labels (one in the group, one here).
   */
  headerless?: boolean;
};

/**
 * Renders the bound-agents block of a computer card body.
 *
 * Two display modes — both fed by the same `BoundAgentsSummary`:
 *   - **expanded** (Ready card): per-agent row with `PresenceChip`
 *   - **compact** (AuthExpired / Offline): single-line summary like
 *     "3 agents · all offline"
 *
 * Session counts (active / total) used to render here but were dropped
 * in the minimal-style pass — the per-computer card is a *status*
 * surface, not an agent detail view. Session info belongs on
 * `/agent/:id`, which the user reaches from the bound name.
 */
export function BoundAgentsList({ summary, agentName, compact = false, headerless = false }: BoundAgentsListProps) {
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
    <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
      {!headerless && (
        <div className="text-caption" style={{ color: "var(--fg-3)" }}>
          {summary.total === 1 ? "Agent" : `Agents · ${summary.total}`}
        </div>
      )}
      {summary.agents.map((a) => (
        <div key={a.agentId} className="flex items-center text-body" style={{ gap: "var(--sp-2_5)" }}>
          <span style={{ color: "var(--fg-2)" }}>{agentName(a.agentId)}</span>
          <PresenceChip status={runtimeStateToPresence(a.runtimeState)} />
        </div>
      ))}
    </div>
  );
}
