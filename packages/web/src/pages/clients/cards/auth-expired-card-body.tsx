import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardSection, CardSectionLabel } from "./shared/card-section.js";
import { CompactMetaLine } from "./shared/compact-meta-line.js";
import { PROVIDER_ORDER } from "./shared/providers.js";
import { RuntimeStateLine } from "./shared/runtime-state-line.js";
import { summarizeBoundAgents } from "./view-models.js";

type AuthExpiredCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
};

/**
 * Variant B body — token expired. Same `CardSection` skeleton as
 * Ready / Offline; supporting context (Runtimes / Agents from the
 * last successful heartbeat) renders dimmed.
 *
 * Layout:
 *   Meta:      Hasn't checked in for 8 days · First Tree X · OS
 *   Runtimes:  ✓ Claude Code v0.2.130 (dimmed)
 *   Agents:    per-agent list (dimmed)
 *
 * "Generate new token" button is rendered by `ComputerCard`'s
 * `HeaderAction` slot — paired with the pill so state ↔ action sit on
 * one horizontal line, no separate body action row needed.
 */
export function AuthExpiredCardBody({ client, boundAgents, agentName }: AuthExpiredCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  const reportedProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p] != null);
  return (
    <div className="flex flex-col">
      <CardSection>
        <CompactMetaLine client={client} timeMode="auth-expired" />
      </CardSection>
      {/* Point at the recovery action so the body isn't a dead readout: the
          "Generate new token" button lives in the card header (paired with the
          pill), which a reader scanning only the body would miss. */}
      <CardSection>
        <p className="text-caption" style={{ margin: 0, color: "var(--fg-3)" }}>
          This computer&apos;s access token expired. Use{" "}
          <span className="font-medium" style={{ color: "var(--fg-2)" }}>
            Generate new token
          </span>{" "}
          above to reconnect it.
        </p>
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
