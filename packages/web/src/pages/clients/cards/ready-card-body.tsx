import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardSection, CardSectionLabel } from "./shared/card-section.js";
import { CompactMetaLine } from "./shared/compact-meta-line.js";
import { PROVIDER_ORDER } from "./shared/providers.js";
import { RuntimeProviderRow } from "./shared/runtime-provider-row.js";
import { summarizeBoundAgents } from "./view-models.js";

type ReadyCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
};

/**
 * Variant A body — the happy path. Renders three uniform sections via
 * the shared `CardSection`: Meta → Runtimes → Agents (last optional).
 *
 * Every section uses the same hairline-on-top + padding structure as
 * Offline / AuthExpired / SetupIncomplete, so the four pill states
 * share identical visual rhythm — only the content (and opacity for
 * stale data) differs.
 *
 * Runtimes the SDK never reported (`entry === null`) are filtered out
 * here, so the section hides entirely if the operator has no reported
 * runtimes at all (rare for Ready — usually means SDK is too old).
 */
export function ReadyCardBody({ client, boundAgents, agentName }: ReadyCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  const reportedProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p] != null);
  return (
    <div className="flex flex-col">
      <CardSection>
        <CompactMetaLine client={client} />
      </CardSection>
      {reportedProviders.length > 0 && (
        <CardSection>
          <CardSectionLabel>Runtimes</CardSectionLabel>
          <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
            {reportedProviders.map((provider) => {
              const entry = client.capabilities[provider];
              if (entry == null) return null;
              // Detection is install-only: each reported provider shows just its
              // status line (installed / missing / error). Install boxes stay
              // off here — a Ready card means at least one runtime is `ok`.
              return <RuntimeProviderRow key={provider} provider={provider} entry={entry} os={client.os} />;
            })}
          </div>
        </CardSection>
      )}
      {summary.total > 0 && (
        <CardSection>
          <CardSectionLabel>{summary.total === 1 ? "Agent" : `Agents · ${summary.total}`}</CardSectionLabel>
          <BoundAgentsList summary={summary} agentName={agentName} headerless />
        </CardSection>
      )}
    </div>
  );
}
