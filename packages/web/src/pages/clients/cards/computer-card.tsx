import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { RowActionsMenu } from "../../../components/ui/row-actions-menu.js";
import { ComputerStatusPill } from "../computer-status-pill.js";
import { AuthExpiredCardBody } from "./auth-expired-card-body.js";
import { OfflineCardBody } from "./offline-card-body.js";
import { ReadyCardBody } from "./ready-card-body.js";
import { SetupIncompleteCardBody } from "./setup-incomplete-card-body.js";
import { type ComputerCardViewModel, computerCardViewModel } from "./view-models.js";

export type ComputerCardProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
  /**
   * Opens the NewConnectionDialog scoped to this client.id (re-auth path
   * — used by AuthExpired card's primary action). The dialog's arrival
   * detector matches only this row; copy + title indicate re-auth.
   */
  onGenerateNewToken: () => void;
  /**
   * Opens the NewConnectionDialog UNSCOPED (fresh connect command).
   * Used by the offline-card kebab "Reconnect" entry — an offline
   * machine's credentials are still likely valid, so the operator just
   * needs a working connect token to re-pair from the machine. Routing
   * this through `onGenerateNewToken` would scope the arrival detector
   * to this row and mislead with re-auth copy.
   */
  onReconnect: () => void;
  /** Opens the disconnect-confirmation modal. */
  onDisconnect: () => void;
  /** Opens the retire-confirmation modal. */
  onRetire: () => void;
  /**
   * Optional owner label rendered in the header below the hostname.
   * Used by admin "Your computers" cards to display the viewer's name
   * (matches the pre-PR-B Owner column).
   */
  ownerLabel?: { text: string; title?: string };
};

/**
 * Top-level card shell. Routes by `deriveComputerStatus(client).pill`
 * to one of four body components — each mockup variant (A/B/B-2/B-3)
 * gets its own body so the per-pill content is encapsulated.
 *
 * Card chrome (shared across pills):
 *   - role="region" + aria-label for screen-reader semantic equivalence
 *     to the table's row/column structure pre-PR-B
 *   - Header row: hostname (+ optional owner) + pill chip + ⋯ menu
 *   - Body slot driven by pill
 *
 * The ⋯ menu carries the same actions the table's RowActionsMenu had —
 * Disconnect / Retire (+ Reconnect when offline). Reconnect on offline
 * cards opens the dialog as a fresh connect (no targetClientId), since
 * "the user wants to fire up a new install path" is the offline-mode
 * mental model. AuthExpired uses the Generate-new-token button instead
 * (it threads `targetClientId` through).
 */
export function ComputerCard({
  client,
  boundAgents,
  agentName,
  onGenerateNewToken,
  onReconnect,
  onDisconnect,
  onRetire,
  ownerLabel,
}: ComputerCardProps) {
  const vm = computerCardViewModel(client);
  const isOffline = client.status !== "connected";

  return (
    // `<section>` already conveys region semantics; biome flags an
    // explicit `role="region"` as redundant. `aria-label` on a labeled
    // section is the documented pattern for naming the region.
    <section
      aria-label={vm.ariaLabel}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-3_5)",
        padding: "var(--sp-4) var(--sp-5)",
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <header className="flex items-start" style={{ gap: "var(--sp-3)" }}>
        <div className="flex flex-col" style={{ flex: 1, minWidth: 0, gap: "var(--sp-1)" }}>
          <h3 className="text-subtitle" style={{ margin: 0, overflowWrap: "anywhere" }}>
            {vm.label}
          </h3>
          {ownerLabel && (
            <span className="text-caption" style={{ color: "var(--fg-3)" }} title={ownerLabel.title}>
              {ownerLabel.text}
            </span>
          )}
        </div>
        <ComputerStatusPill pill={vm.pill} />
        <RowActionsMenu
          ariaLabel="Computer actions"
          actions={[
            ...(isOffline ? [{ key: "reconnect", label: "Reconnect", onSelect: onReconnect }] : []),
            { key: "disconnect", label: "Disconnect", onSelect: onDisconnect },
            { key: "retire", label: "Retire", destructive: true, onSelect: onRetire },
          ]}
        />
      </header>
      <CardBody
        pill={vm.pill}
        client={client}
        boundAgents={boundAgents}
        agentName={agentName}
        onGenerateNewToken={onGenerateNewToken}
      />
    </section>
  );
}

function CardBody(props: {
  pill: ComputerCardViewModel["pill"];
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
  onGenerateNewToken: () => void;
}) {
  switch (props.pill) {
    case "ready":
      return <ReadyCardBody client={props.client} boundAgents={props.boundAgents} agentName={props.agentName} />;
    case "auth_expired":
      return (
        <AuthExpiredCardBody
          client={props.client}
          boundAgents={props.boundAgents}
          agentName={props.agentName}
          onGenerateNewToken={props.onGenerateNewToken}
        />
      );
    case "setup_incomplete":
      return (
        <SetupIncompleteCardBody client={props.client} boundAgents={props.boundAgents} agentName={props.agentName} />
      );
    case "offline":
      return <OfflineCardBody client={props.client} boundAgents={props.boundAgents} agentName={props.agentName} />;
    default: {
      const exhaustive: never = props.pill;
      return exhaustive;
    }
  }
}
