import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { Button } from "../../../components/ui/button.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardMetaFooter } from "./shared/card-meta-row.js";
import { InlineCommand } from "./shared/inline-command.js";
import { PROVIDER_ORDER } from "./shared/providers.js";
import { DimmedGroup, StaleRuntimeLine } from "./shared/stale-runtimes.js";
import { offlineDiagnostic, summarizeBoundAgents } from "./view-models.js";

type OfflineCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
  /**
   * Opens the NewConnectionDialog unscoped (fresh connect flow). The
   * Reconnect button is promoted out of the kebab on Offline cards
   * because it's the operator's primary affordance here — same role
   * as "Generate new token" on AuthExpired.
   */
  onReconnect: () => void;
};

/**
 * Variant B-3 body — credentials are alive but the machine isn't
 * checking in. Renders:
 *   - Diagnostic: "Last seen X ago. Make sure the machine is awake..."
 *   - Primary action row: "Reconnect" button (re-pair from this hub)
 *     + wake-guide hint with copy-pasteable `first-tree daemon start`
 *     for when the operator is at the keyboard of the offline machine
 *   - Expanded agents list with PresenceChips (operator wants to know
 *     which specific agents are down, not just the count)
 *   - Dimmed Runtimes block (last reported) so the operator knows
 *     what comes back when the machine reconnects
 *   - Dimmed meta footer
 */
export function OfflineCardBody({ client, boundAgents, agentName, onReconnect }: OfflineCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  const reportedProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p] != null);
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-2)" }}>
        {offlineDiagnostic(client)}
      </p>
      <div>
        <Button size="sm" onClick={onReconnect}>
          Reconnect
        </Button>
      </div>
      <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
        <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
          If the daemon isn't running, on this computer:
        </p>
        <InlineCommand command="first-tree daemon start" ariaLabel="Daemon wake command" />
      </div>
      {summary.total > 0 && (
        <DimmedGroup label={summary.total === 1 ? "Agent" : `Agents · ${summary.total}`}>
          <BoundAgentsList summary={summary} agentName={agentName} headerless />
        </DimmedGroup>
      )}
      {reportedProviders.length > 0 && (
        <DimmedGroup label="Runtimes · last reported">
          <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
            {reportedProviders.map((provider) => {
              const entry = client.capabilities[provider];
              if (entry == null) return null;
              return <StaleRuntimeLine key={provider} provider={provider} entry={entry} />;
            })}
          </div>
        </DimmedGroup>
      )}
      <CardMetaFooter client={client} />
    </div>
  );
}
