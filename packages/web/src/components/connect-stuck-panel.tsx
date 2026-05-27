import { COPY } from "../pages/onboarding/copy.js";

/**
 * Wait this long on the connect command before a caller surfaces this
 * panel. Exported so both surfaces (Onboarding `StepConnectComputer`
 * and Settings → Computers `NewConnectionDialog`) share one source of
 * truth — drift between them was the silent UX regression the panel
 * was introduced to prevent.
 */
export const STUCK_AFTER_MS = 75_000;

/**
 * "Stuck?" recovery panel for the Connect-computer flow. Pure
 * presentational — the parent owns the timer that flips this on / off
 * because the conditions for clearing it differ by surface (onboarding
 * clears on `connectedClient`; the daily dialog clears on phase changes
 * or modal close). Sharing the visuals + copy keeps the two surfaces
 * showing the same recovery advice without forcing one of them to
 * implement an unnatural timer reset.
 */
export function ConnectStuckPanel() {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-3)",
        borderRadius: "var(--radius-input)",
        background: "color-mix(in oklch, var(--bg-raised) 40%, transparent)",
        border: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
        {COPY.connectComputer.stuckTitle}
      </p>
      <ul className="flex flex-col" style={{ gap: "var(--sp-1_5)", margin: 0, paddingLeft: "var(--sp-4)" }}>
        {COPY.connectComputer.stuckReasons.map((reason) => (
          <li key={reason} className="text-label" style={{ color: "var(--fg-3)" }}>
            {reason}
          </li>
        ))}
      </ul>
      <a
        href={COPY.connectComputer.nodeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-label font-medium self-start"
        style={{ color: "var(--accent)" }}
      >
        {COPY.connectComputer.nodeLinkLabel} →
      </a>
    </div>
  );
}
