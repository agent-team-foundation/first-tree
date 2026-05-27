import { StatusGlyph } from "../../components/ui/status-glyph.js";
import { cn } from "../../lib/utils.js";
import type { ComputerStatusPill as PillName } from "./derive-status.js";

type ComputerStatusPillProps = {
  pill: PillName;
  className?: string;
};

/**
 * Per-pill view model: label string + color token. Exported so tests
 * (and any future consumer that wants the same vocabulary without the
 * chip's DOM) can drive the same normalization.
 */
export const PILL_VIEW: Record<PillName, { label: string; color: string }> = {
  ready: { label: "Ready", color: "var(--state-idle)" },
  auth_expired: { label: "Auth expired", color: "var(--state-error)" },
  setup_incomplete: { label: "Setup incomplete", color: "var(--state-blocked)" },
  offline: { label: "Offline", color: "var(--fg-3)" },
};

/**
 * Four-state computer reachability pill for Settings → Computers.
 *
 * Replaces the previous mixed visuals (separate AUTH EXPIRED chip +
 * generic PresenceChip) with a single chip that conveys the user's
 * actionable answer: "can my agent run on this machine right now?"
 *
 * Driven by `deriveComputerStatus` — a pure function over the existing
 * `status` / `authState` / `capabilities` fields. No new server signal,
 * no time thresholds.
 */
export function ComputerStatusPill({ pill, className }: ComputerStatusPillProps) {
  const view = PILL_VIEW[pill];
  // role="status" + aria-label make this announce as a state region for
  // screen readers and ensure colorblind users still receive the label
  // text (the StatusGlyph dot is decorative, the prose is the truth).
  return (
    <span
      role="status"
      aria-label={`Computer status: ${view.label}`}
      className={cn("mono inline-flex items-center gap-1.5 text-caption", className)}
      style={{ color: view.color }}
    >
      <StatusGlyph shape="dot" colorVar={view.color} size={7} />
      {view.label}
    </span>
  );
}
