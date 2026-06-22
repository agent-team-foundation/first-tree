import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardSection, CardSectionLabel } from "./shared/card-section.js";
import { CompactMetaLine } from "./shared/compact-meta-line.js";
import { PROVIDER_ORDER } from "./shared/providers.js";
import { RuntimeInstallBox } from "./shared/runtime-install-box.js";
import { cardHostnameLabel, summarizeBoundAgents } from "./view-models.js";

type SetupIncompleteCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
};

/**
 * Variant B-2 body — Setup incomplete. Same `CardSection` skeleton as
 * Ready / Offline / AuthExpired: Meta → (optional Agents waiting) →
 * Install a runtime.
 *
 * Meta line matches Ready's `heartbeat` mode (`Heartbeat 7 seconds
 * ago · First Tree X · OS`) so the four pill states share one rhythm.
 * The earlier `Online · no runtime ready` prefix was dropped: the
 * yellow "Setup incomplete" pill already says it, and the install
 * boxes below are the action.
 *
 * The Agents section reuses Ready's component — when an operator has
 * already attached agents but no runtime is installed yet, listing
 * them ("Claude · Claude Code  offline") shows exactly which agents
 * are waiting on the install they're about to run.
 */
export function SetupIncompleteCardBody({ client, boundAgents, agentName }: SetupIncompleteCardBodyProps) {
  const hostname = cardHostnameLabel(client);
  const summary = summarizeBoundAgents(boundAgents);
  const installableProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p]?.state !== "ok");

  return (
    <div className="flex flex-col">
      <CardSection>
        <CompactMetaLine client={client} />
      </CardSection>
      {summary.total > 0 && (
        <CardSection>
          <CardSectionLabel>
            {summary.total === 1 ? "Agent waiting" : `Agents waiting · ${summary.total}`}
          </CardSectionLabel>
          <BoundAgentsList summary={summary} agentName={agentName} headerless />
        </CardSection>
      )}
      <CardSection>
        <CardSectionLabel>Install a runtime to start</CardSectionLabel>
        <div
          style={{
            display: "grid",
            gap: "var(--sp-3)",
            // Side-by-side install boxes when the card is wide enough,
            // stacked 1-up below the breakpoint (--sp-70 = 280 baseline
            // for the install-command pre block).
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, var(--sp-70)), 1fr))",
          }}
        >
          {installableProviders.map((provider) => (
            <RuntimeInstallBox
              key={provider}
              provider={provider}
              entry={client.capabilities[provider] ?? null}
              hostname={hostname}
              os={client.os}
            />
          ))}
        </div>
      </CardSection>
    </div>
  );
}
