import type { RuntimeProvider } from "@first-tree/shared";
import { PresenceChip, runtimeStateToPresence } from "../../../../components/ui/presence-chip.js";
import type { BoundAgentsSummary } from "../view-models.js";
import { PROVIDER_LABEL } from "./providers.js";

type BoundAgentsListProps = {
  summary: BoundAgentsSummary;
  agentName: (uuid: string | null | undefined) => string;
  /**
   * When true, skip the in-component "Agents · N" header — the parent
   * Group is already labeling the block. Without this the Ready card
   * would render two labels (one in the group, one here).
   */
  headerless?: boolean;
};

/**
 * Per-agent rows under a computer card body.
 *
 * Format: `<name> · <runtime-type>   <PresenceChip>` — the mid-dot
 * separator matches the rest of the page's segment-meta rhythm
 * (`gandy · you`, `Claude Code · v0.2.141 · oauth`). The runtime
 * inline tells the operator which provider is carrying each agent so
 * they can correlate an agent's idle/offline state with the
 * runtime-level state above.
 *
 * Session counts (active / total) used to render here but were dropped
 * — the per-computer card is a *status* surface, not an agent detail
 * view. Session info lives on `/agent/:id`.
 *
 * AuthExpired and Offline cards used to render a compact summary line
 * here; that mode was retired so problem-state cards explicitly name
 * the affected agents (operator's primary question on a broken
 * machine is "which agents are down", not "how many").
 */
export function BoundAgentsList({ summary, agentName, headerless = false }: BoundAgentsListProps) {
  if (summary.total === 0) {
    return null;
  }

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
      {!headerless && (
        <div className="text-caption" style={{ color: "var(--fg-3)" }}>
          {summary.total === 1 ? "Agent" : `Agents · ${summary.total}`}
        </div>
      )}
      {summary.agents.map((a) => {
        const runtimeLabel = formatRuntimeLabel(a.runtimeType);
        return (
          <div key={a.agentId} className="flex items-center text-body" style={{ gap: "var(--sp-3)" }}>
            <span style={{ color: "var(--fg-2)" }}>
              {agentName(a.agentId)}
              {runtimeLabel && (
                <>
                  <span style={{ color: "var(--fg-4)", padding: "0 var(--sp-1)" }}>·</span>
                  <span className="text-caption" style={{ color: "var(--fg-3)" }}>
                    {runtimeLabel}
                  </span>
                </>
              )}
            </span>
            <PresenceChip status={runtimeStateToPresence(a.runtimeState)} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Map raw `runtimeType` (the wire-format string from `clients.agents`)
 * to the human label used in PROVIDER_LABEL. Returns null when the
 * provider isn't recognized so the row gracefully degrades to just
 * `name + chip` rather than rendering "· null".
 */
function formatRuntimeLabel(runtimeType: string | null): string | null {
  if (!runtimeType) return null;
  if (runtimeType === "claude-code" || runtimeType === "codex") {
    return PROVIDER_LABEL[runtimeType as RuntimeProvider];
  }
  return runtimeType;
}
