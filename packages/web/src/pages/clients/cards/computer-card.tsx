import type { ReactNode } from "react";
import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { Button } from "../../../components/ui/button.js";
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
   * Opens the `ReconnectDialog` scoped to this offline machine. The
   * Offline card promotes this to an inline "Reconnect" button as its
   * primary affordance. The machine is already paired and its
   * credentials are usually still alive, so the dialog leads with the
   * lightweight `<binName> daemon start` (no reinstall, no token) and
   * demotes install+login to a "Still offline?" fallback — distinct
   * from `+ Connect`, which targets an unknown machine.
   */
  onReconnect: () => void;
  /** Opens the disconnect-confirmation modal. */
  onDisconnect: () => void;
  /** Opens the retire-confirmation modal. */
  onRetire: () => void;
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
 * The ⋯ menu only carries the destructive low-frequency actions
 * (Disconnect / Retire). State-specific *primary* actions live inline
 * inside the body — Generate new token on AuthExpired, Reconnect on
 * Offline — so they're discoverable without clicking a kebab.
 */
export function ComputerCard({
  client,
  boundAgents,
  agentName,
  onGenerateNewToken,
  onReconnect,
  onDisconnect,
  onRetire,
}: ComputerCardProps) {
  const vm = computerCardViewModel(client);

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
      {/*
        items-center lines up pill, kebab, and the hostname row on a
        single centerline — fixes the visible misalignment that the
        previous items-start caused (each child has a different
        rendered height so top-aligned ≠ visually-aligned).
      */}
      <header className="flex items-center" style={{ gap: "var(--sp-3)" }}>
        <div className="flex items-baseline" style={{ flex: 1, minWidth: 0, gap: "var(--sp-2)", flexWrap: "wrap" }}>
          <h3 className="text-body font-semibold" style={{ margin: 0, overflowWrap: "anywhere", color: "var(--fg)" }}>
            {vm.label}
          </h3>
        </div>
        {/*
          Reading order: state pill ("what's happening") → action
          ("what to do") → kebab (secondary). Matches the GitHub /
          Linear / Stripe admin-list convention where a status badge
          sits to the left of its CTA. Empty action slot collapses
          when no inline action applies (Ready / Setup-incomplete).
        */}
        <ComputerStatusPill pill={vm.pill} />
        <HeaderAction pill={vm.pill} onGenerateNewToken={onGenerateNewToken} onReconnect={onReconnect} />
        <RowActionsMenu
          ariaLabel="Computer actions"
          actions={[
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
        onReconnect={onReconnect}
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
  onReconnect: () => void;
}) {
  switch (props.pill) {
    case "ready":
      return <ReadyCardBody client={props.client} boundAgents={props.boundAgents} agentName={props.agentName} />;
    case "auth_expired":
      return <AuthExpiredCardBody client={props.client} boundAgents={props.boundAgents} agentName={props.agentName} />;
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

/**
 * State-specific primary action rendered in the card header. Lives
 * here (not inside the per-pill body) so it sits on the same horizontal
 * line as the pill — gives the operator a one-glance "this is the
 * state, this is what to do" pairing without scanning down.
 *
 * `null` (no header action) for Ready and Setup-incomplete:
 *   - Ready needs no action — the machine is fine
 *   - Setup-incomplete's primary action *is* the install-box body
 *     (per-runtime commands), which needs vertical space anyway
 */
function HeaderAction({
  pill,
  onGenerateNewToken,
  onReconnect,
}: {
  pill: ComputerCardViewModel["pill"];
  onGenerateNewToken: () => void;
  onReconnect: () => void;
}): ReactNode {
  // `outline` instead of the default filled variant — pill already
  // carries the color-coded urgency signal (red Auth expired / grey
  // Offline). Re-stating that urgency with a filled green button next
  // to the pill would just stack visual weight. Same low-strength
  // treatment matches the PageHeader's `[+ Connect]` button so the
  // whole tab speaks one visual language.
  if (pill === "auth_expired") {
    return (
      <Button variant="outline" size="sm" onClick={onGenerateNewToken}>
        Generate new token
      </Button>
    );
  }
  if (pill === "offline") {
    return (
      <Button variant="outline" size="sm" onClick={onReconnect}>
        Reconnect
      </Button>
    );
  }
  return null;
}
