import { RefreshCw } from "lucide-react";
import { useNewVersionAvailable } from "../hooks/use-version-check.js";

/**
 * Topbar chip that appears next to the brand once the server is serving a
 * newer web build than this tab loaded. Clicking reloads the page to pick up
 * the new build. Renders nothing in the common (up-to-date) case so the topbar
 * stays clean — same self-hiding pattern as `DisconnectChip`.
 *
 * Styled with the `needs-you` amber token family — the shared "user action
 * needed" vocabulary — so it reads as an informational nudge, not an error.
 * Copy is intentionally English-only; a future i18n pass owns translation.
 */
export function NewVersionChip() {
  const newVersionAvailable = useNewVersionAvailable();
  if (!newVersionAvailable) return null;

  const tooltip = "A new version is available. Click to refresh.";
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      title={tooltip}
      aria-label={tooltip}
      className="inline-flex items-center cursor-pointer text-body font-medium"
      style={{
        gap: 7,
        height: 26,
        padding: "0 var(--sp-2_5) 0 var(--sp-2_25)",
        borderRadius: 999,
        border: 0,
        outline: "var(--hairline) solid color-mix(in oklch, var(--state-needs-you) 42%, transparent)",
        outlineOffset: -1,
        background: "var(--state-needs-you-soft)",
        color: "var(--fg-needs-you-strong)",
        minWidth: 0,
      }}
    >
      <RefreshCw aria-hidden="true" size={13} style={{ flexShrink: 0 }} />
      <span>New version — refresh</span>
    </button>
  );
}
