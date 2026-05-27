import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { Button } from "../../../components/ui/button.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardMetaRow } from "./shared/card-meta-row.js";
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
 *   - Single primary action: "Generate new token" button. Clicking it
 *     opens the NewConnectionDialog (parameterized for re-auth wording),
 *     where the actual command + copy flow lives. We intentionally do
 *     NOT show a placeholder command on the card — a user copy-pasting a
 *     placeholder token would just hit AUTH_ERROR on the CLI side.
 *   - Affected agents: compact summary line ("3 agents · all offline").
 *   - Dimmed meta row (heartbeat / first-tree / OS) under a divider.
 */
export function AuthExpiredCardBody({ client, boundAgents, agentName, onGenerateNewToken }: AuthExpiredCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-2)" }}>
        {authExpiredDiagnostic(client)}
      </p>
      <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
        <Button size="sm" onClick={onGenerateNewToken}>
          Generate new token
        </Button>
        {summary.total > 0 && <BoundAgentsList summary={summary} agentName={agentName} compact />}
      </div>
      <div
        style={{
          borderTop: "var(--hairline) solid var(--border-faint)",
          paddingTop: "var(--sp-2_5)",
        }}
      >
        <CardMetaRow client={client} dimmed />
      </div>
    </div>
  );
}
