import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardSection, CardSectionLabel } from "./shared/card-section.js";
import { CompactMetaLine } from "./shared/compact-meta-line.js";
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
 *   Meta:           Last seen 2d ago · First Tree X · OS  (top)
 *   Runtimes:       ✓ Claude Code v0.2.130 (dimmed)
 *   Agents:         per-agent list (dimmed)
 *
 * Reconnect button is rendered by `ComputerCard`'s `HeaderAction` slot
 * — paired with the pill so state ↔ action sit on one horizontal line.
 * The recovery command (`<binName> daemon start`, plus the reinstall +
 * login fallback) lives in the `ReconnectDialog` that button opens, so
 * this body stays a read-only "last reported" snapshot with no inline
 * command to drift from the dialog's copy.
 */
export function OfflineCardBody({ client, boundAgents, agentName }: OfflineCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  const reportedProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p] != null);
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
    </div>
  );
}
