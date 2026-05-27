import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { Button } from "../../../components/ui/button.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardMetaFooter } from "./shared/card-meta-row.js";
import { PROVIDER_ORDER } from "./shared/providers.js";
import { DimmedGroup, StaleRuntimeLine } from "./shared/stale-runtimes.js";
import { authExpiredDiagnostic, summarizeBoundAgents } from "./view-models.js";

type AuthExpiredCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
  /**
   * Click handler for the "Generate new token" button. The page wires
   * this to `setReAuthClientId(client.id) + setNewConnectionOpen(true)`
   * so the dialog opens scoped to this specific machine (`targetClientId`
   * prop on the dialog). Without that scoping, a parallel re-auth on
   * another card could consume the wrong arrival event.
   */
  onGenerateNewToken: () => void;
};

/**
 * Variant B body — the most "we need to act" pill. Renders:
 *   - Diagnostic: "Hasn't checked in for N days. Token expired."
 *   - Primary action: inline "Generate new token" button
 *   - Affected agents: expanded list with PresenceChips so the operator
 *     can see exactly which agents are stuck (the "blast radius")
 *   - Dimmed Runtimes block (last reported) — tells the operator what
 *     will come back online once they re-auth. Runtime auth (e.g.
 *     `claude login`) is independent of first-tree login, so this also
 *     hints whether they'll need to re-auth a runtime separately.
 *   - Dimmed meta footer (heartbeat / first-tree / OS)
 */
export function AuthExpiredCardBody({ client, boundAgents, agentName, onGenerateNewToken }: AuthExpiredCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  const reportedProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p] != null);
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-2)" }}>
        {authExpiredDiagnostic(client)}
      </p>
      <div>
        <Button size="sm" onClick={onGenerateNewToken}>
          Generate new token
        </Button>
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
