import type { CSSProperties, HTMLAttributes } from "react";
import { TONE_STYLES, type Tone } from "../../lib/tones.js";
import { cn } from "../../lib/utils.js";

/**
 * DenseBadge tone subset. Limited to the tones that make sense inside a
 * dense chip (no state-specific tones — use StateChip for those).
 */
export type DenseBadgeTone = Extract<Tone, "neutral" | "accent" | "warn" | "error" | "outline">;

type DenseBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: DenseBadgeTone;
};

// Mirrors the Badge atom in design-canvas/atoms.jsx:
//   mono / 10px / uppercase / padding 1px 7px / radius 3 / 1px border.
// shadcn Badge is 12px + rounded-md and reads as "chunky" in dense panels.
// Typography is bound to the `text-caption` token from index.css; tones are
// resolved via the shared tones map so chips stay in sync with state chips.
export function DenseBadge({ tone = "neutral", className, style, ...rest }: DenseBadgeProps) {
  const t = TONE_STYLES[tone];
  const merged: CSSProperties = {
    background: t.bg,
    color: t.fg,
    border: `1px solid ${t.bd}`,
    ...style,
  };
  return (
    <span
      className={cn("mono inline-flex items-center uppercase text-caption", className)}
      style={{
        padding: "1px 7px",
        borderRadius: "var(--radius-chip)",
        // Override token line-height (1.4) with a taller 1.6 so dense badges
        // stay visually balanced against adjacent text in row cells.
        lineHeight: 1.6,
        ...merged,
      }}
      {...rest}
    />
  );
}
