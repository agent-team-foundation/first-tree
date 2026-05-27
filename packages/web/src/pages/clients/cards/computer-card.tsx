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
 * Per-computer detail block. Renders as a flat region inside its parent
 * `<Section>` ("Your computers" / "Team computers") — no raised
 * background, no shadow, no border. The visual vocabulary matches the
 * rest of Settings (Section → fields → hairline separators) so this tab
 * sits next to /settings/github and /settings/messaging without looking
 * like an outlier.
 *
 * Multiple machines stack vertically; the parent `CardStack` paints a
 * hairline between adjacent entries so the eye still sees the boundary
 * without an explicit card chrome.
 *
 * Header row: hostname + optional owner caption + pill + ⋯ menu.
 * The ⋯ menu carries the same actions the legacy table's RowActionsMenu
 * had — Disconnect / Retire (+ Reconnect when offline). Reconnect on
 * offline rows opens the dialog as a fresh connect (no targetClientId);
 * AuthExpired uses the inline "Generate new token" button instead.
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
    // `<article>` (instead of nested `<section>`) keeps the page outline
    // flat: the parent `<Section>` is the named region, each computer is
    // an article inside it. `aria-label` names it for screen readers.
    <article
      aria-label={vm.ariaLabel}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-3)",
        // Padding only on the inline axis — vertical spacing comes from
        // the parent stack's hairline separators so adjacent rows don't
        // collide but also don't waste extra padding on themselves.
        padding: "var(--sp-3_5) 0",
      }}
    >
      <header className="flex items-start" style={{ gap: "var(--sp-3)" }}>
        <div className="flex flex-col" style={{ flex: 1, minWidth: 0, gap: "var(--sp-0_5)" }}>
          <h3 className="text-body font-semibold" style={{ margin: 0, overflowWrap: "anywhere", color: "var(--fg)" }}>
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
    </article>
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
