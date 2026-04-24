import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { MessageSquare, Play } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { StateChip } from "../../components/ui/state-chip.js";
import { formatDate } from "../../lib/utils.js";

/**
 * Overview — the first section the operator sees. Surfaces the "who / what is
 * this agent" and "is it healthy right now" questions before the configuration
 * controls below. Identity editing keeps its own Dialog (IdentitySection) so
 * the SaveBar stays config-only; this component renders both the Profile card
 * and the Status & Health card side by side.
 *
 * Note: runtime + bound-computer labels are shown by the sticky ContextBar at
 * the top of the page, so Status & Health here intentionally omits a "Runs on"
 * row to avoid first-screen duplication.
 */

export type OverviewSectionProps = {
  agent: Agent;
  profileSlot: ReactNode;
  /** Platform bindings panel (Panel component) — rendered inline inside the Profile card. */
  bindingsSlot?: ReactNode;
  /** Everything the runtime panel needs to render, precomputed by the page. */
  health: OverviewHealth;
  isHuman: boolean;
  onOpenChat: () => void;
  onTest?: () => void;
  testPending?: boolean;
};

export type OverviewHealth = {
  runtimeState: string | null;
  model: string;
  activeSessions: number;
  totalSessions: number | string;
  /**
   * ISO timestamp marking when the bound client last went offline, or null
   * while the client is currently online / has never connected. Surfaced as
   * the "Offline since" row — NOT a generic "last active" timestamp.
   */
  offlineSince: string | null;
};

export function OverviewSection(props: OverviewSectionProps) {
  const { agent, isHuman } = props;
  return (
    <div className="space-y-3">
      {props.profileSlot}

      {props.bindingsSlot}

      <StatusHealthCard
        state={props.health.runtimeState}
        model={props.health.model}
        activeSessions={props.health.activeSessions}
        totalSessions={props.health.totalSessions}
        offlineSince={props.health.offlineSince}
        agentActive={agent.status === "active"}
        isHuman={isHuman}
        onOpenChat={props.onOpenChat}
        onTest={props.onTest}
        testPending={props.testPending ?? false}
      />
    </div>
  );
}

function StatusHealthCard(props: {
  state: string | null;
  model: string;
  activeSessions: number;
  totalSessions: number | string;
  offlineSince: string | null;
  agentActive: boolean;
  isHuman: boolean;
  onOpenChat: () => void;
  onTest?: () => void;
  testPending: boolean;
}) {
  return (
    <section
      style={{
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: 6,
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{ padding: "var(--sp-2_5) var(--sp-3_5)", borderBottom: "var(--hairline) solid var(--border-faint)" }}
      >
        <h3 className="inline-flex items-center gap-2 text-body font-semibold" style={{ color: "var(--fg)" }}>
          Status & health
          <StateChip state={props.state} />
        </h3>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="xs" onClick={props.onOpenChat}>
            <MessageSquare className="h-3 w-3" /> Open chat
          </Button>
          {!props.isHuman && props.agentActive && props.onTest && (
            <Button variant="outline" size="xs" onClick={props.onTest} disabled={props.testPending}>
              <Play className="h-3 w-3" />
              {props.testPending ? "Testing…" : "Test"}
            </Button>
          )}
        </div>
      </header>
      <div className="px-4 py-3 text-body grid gap-2" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <HealthRow label="Model" value={<span className="mono">{props.model}</span>} />
        <HealthRow
          label="Sessions"
          value={
            <span className="mono tnum">
              <span style={{ color: "var(--fg-2)" }}>{props.activeSessions}</span>
              <span style={{ color: "var(--fg-4)" }}> / {props.totalSessions}</span>{" "}
              <span className="text-caption" style={{ color: "var(--fg-4)" }}>
                active / total
              </span>
            </span>
          }
        />
        <HealthRow
          label="Offline since"
          value={
            props.offlineSince ? (
              <span className="mono text-label">{formatDate(props.offlineSince)}</span>
            ) : (
              <span className="text-caption" style={{ color: "var(--fg-4)" }}>
                — (online)
              </span>
            )
          }
        />
      </div>
    </section>
  );
}

function HealthRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-caption shrink-0" style={{ color: "var(--fg-4)", minWidth: 86 }}>
        {label}
      </span>
      <span className="min-w-0 truncate">{value}</span>
    </div>
  );
}
