import { useState } from "react";
import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardSection, CardSectionLabel } from "./shared/card-section.js";
import { CompactMetaLine } from "./shared/compact-meta-line.js";
import { InlineCommand } from "./shared/inline-command.js";
import { PROVIDER_ORDER } from "./shared/providers.js";
import { RuntimeStateLine } from "./shared/runtime-state-line.js";
import { summarizeBoundAgents } from "./view-models.js";

type OfflineCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
};

/**
 * Variant B-3 body — Offline. Same `CardSection` skeleton as Ready;
 * stale sections (Runtimes / Agents reported before the heartbeat
 * stopped) render dimmed.
 *
 * Layout:
 *   Meta:           Last seen 2d ago · first-tree X · OS  (top)
 *   Runtimes:       ✓ Claude Code v0.2.130 (dimmed)
 *   Agents:         per-agent list (dimmed)
 *   Disclosure:     ⌄ Daemon not running? → wake command
 *
 * Reconnect button is rendered by `ComputerCard`'s `HeaderAction` slot
 * — paired with the pill so state ↔ action sit on one horizontal
 * line. Disclosure label is a self-explanatory question so the
 * operator doesn't need to know what a "wake command" is.
 */
export function OfflineCardBody({ client, boundAgents, agentName }: OfflineCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  const reportedProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p] != null);
  const [showCommand, setShowCommand] = useState(false);
  return (
    <div className="flex flex-col">
      <CardSection>
        <CompactMetaLine client={client} timeMode="offline" />
      </CardSection>
      {reportedProviders.length > 0 && (
        <CardSection dimmed>
          <CardSectionLabel>Runtimes · last reported</CardSectionLabel>
          <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
            {reportedProviders.map((provider) => {
              const entry = client.capabilities[provider];
              if (entry == null) return null;
              return <RuntimeStateLine key={provider} provider={provider} entry={entry} os={client.os} />;
            })}
          </div>
        </CardSection>
      )}
      {summary.total > 0 && (
        <CardSection dimmed>
          <CardSectionLabel>{summary.total === 1 ? "Agent" : `Agents · ${summary.total}`}</CardSectionLabel>
          <BoundAgentsList summary={summary} agentName={agentName} headerless />
        </CardSection>
      )}
      <CardSection>
        <button
          type="button"
          onClick={() => setShowCommand((v) => !v)}
          className="text-caption"
          style={{
            alignSelf: "flex-start",
            background: "transparent",
            color: "var(--fg-3)",
            border: "none",
            padding: 0,
            cursor: "pointer",
          }}
          aria-expanded={showCommand}
        >
          {showCommand ? "⌃ Daemon not running?" : "⌄ Daemon not running?"}
        </button>
        {showCommand && (
          <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
            <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
              Run on this computer:
            </p>
            <InlineCommand command="first-tree daemon start" ariaLabel="Daemon wake command" />
          </div>
        )}
      </CardSection>
    </div>
  );
}
