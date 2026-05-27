import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardMetaRow } from "./shared/card-meta-row.js";
import { InlineCommand } from "./shared/inline-command.js";
import { offlineDiagnostic, summarizeBoundAgents } from "./view-models.js";

type OfflineCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
};

/**
 * Variant B-3 body — credentials are alive but the machine isn't
 * checking in. Renders:
 *   - Diagnostic: "Last seen X ago. Make sure the machine is awake..."
 *   - Wake-guide command: `first-tree daemon start` (a hint the
 *     operator can run on the machine itself once they're at the
 *     keyboard)
 *   - Compact agents summary (will be all-offline by definition)
 *   - Heartbeat meta row, dimmed (matches AuthExpired's visual weight —
 *     the meta is stale context, not the focus)
 *
 * Distinct from AuthExpired: no inline button-action because there's
 * nothing the operator can do from the web side to wake the machine.
 * The wake-guide command is informational + copy-pasteable.
 */
export function OfflineCardBody({ client, boundAgents, agentName }: OfflineCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg)" }}>
        {offlineDiagnostic(client)}
      </p>
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
          If the daemon isn't running, on this computer:
        </p>
        <InlineCommand command="first-tree daemon start" ariaLabel="Daemon wake command" />
      </div>
      {summary.total > 0 && <BoundAgentsList summary={summary} agentName={agentName} compact />}
      <CardMetaRow client={client} dimmed />
    </div>
  );
}
