import { RefreshCw } from "lucide-react";
import type { CSSProperties } from "react";

const TOOLTIP = "A new version is available. Click to refresh.";

// Shared visual vocabulary for both variants — the `needs-you` amber token
// family reads as "user action needed", not an error.
const CHIP_STYLE: CSSProperties = {
  height: 26,
  border: 0,
  outline: "var(--hairline) solid color-mix(in oklch, var(--state-needs-you) 42%, transparent)",
  outlineOffset: -1,
  background: "var(--state-needs-you-soft)",
  color: "var(--fg-needs-you-strong)",
  borderRadius: 999,
  minWidth: 0,
};

type NewVersionChipProps = {
  /** Whether the server is serving a newer build than this tab is running. */
  show: boolean;
  /**
   * Icon-only rendering for the narrow/mobile topbar, where the brand cluster
   * (and the full chip) is dropped. Keeps a tappable refresh entry without
   * crowding the tabs/avatar row.
   */
  compact?: boolean;
};

/**
 * Topbar control prompting a manual refresh once the server is serving a newer
 * web build than this tab loaded; clicking reloads the page. Presentational
 * only — detection/polling lives in `useNewVersionAvailable`, lifted to
 * `Layout` so it runs at every breakpoint (including narrow, where this chip
 * renders as the compact variant outside the dropped brand cluster). Renders
 * nothing when up to date, so the topbar stays clean.
 *
 * Copy is intentionally English-only; a future i18n pass owns translation.
 */
export function NewVersionChip({ show, compact = false }: NewVersionChipProps) {
  if (!show) return null;

  const reload = () => window.location.reload();

  if (compact) {
    return (
      <button
        type="button"
        onClick={reload}
        title={TOOLTIP}
        aria-label={TOOLTIP}
        className="inline-flex items-center justify-center cursor-pointer"
        style={{ ...CHIP_STYLE, width: 26, padding: 0 }}
      >
        <RefreshCw aria-hidden="true" size={14} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={reload}
      title={TOOLTIP}
      aria-label={TOOLTIP}
      className="inline-flex items-center cursor-pointer text-body font-medium"
      style={{ ...CHIP_STYLE, gap: 7, padding: "0 var(--sp-2_5) 0 var(--sp-2_25)" }}
    >
      <RefreshCw aria-hidden="true" size={13} style={{ flexShrink: 0 }} />
      <span>New version — refresh</span>
    </button>
  );
}
