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
//   mono / var(--sp-2_5) / uppercase / padding var(--hairline) var(--sp-1_75) / radius 3 / var(--hairline) border.
// shadcn Badge is var(--sp-3) + rounded-md and reads as "chunky" in dense panels.
// Typography is bound to the `text-caption` token from index.css; tones are
// resolved via the shared tones map so chips stay in sync with state chips.
export function DenseBadge({ tone = "neutral", className, style, ...rest }: DenseBadgeProps) {
  const t = TONE_STYLES[tone];
  const merged: CSSProperties = {
    background: t.bg,
    color: t.fg,
    border: `var(--hairline) solid ${t.bd}`,
    ...style,
  };
  return (
    <span
      className={cn("mono inline-flex items-center uppercase text-caption leading-[1.6]", className)}
      style={{
        padding: "var(--hairline) var(--sp-1_75)",
        borderRadius: "var(--radius-chip)",
        ...merged,
      }}
      {...rest}
    />
  );
}
