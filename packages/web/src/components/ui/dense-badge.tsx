import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

export type DenseBadgeTone = "neutral" | "accent" | "warn" | "error" | "outline";

type DenseBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: DenseBadgeTone;
};

// Mirrors the Badge atom in design-canvas/atoms.jsx:
//   mono / 10px / uppercase / padding 1px 7px / radius 3 / 1px border.
// shadcn Badge is 12px + rounded-md and reads as "chunky" in dense panels.
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
      className={cn("mono inline-flex items-center uppercase", className)}
      style={{
        fontSize: 10,
        padding: "1px 7px",
        borderRadius: 3,
        letterSpacing: "0.06em",
        lineHeight: 1.6,
        ...merged,
      }}
      {...rest}
    />
  );
}

const TONE_STYLES: Record<DenseBadgeTone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: "var(--bg-sunken)", fg: "var(--fg-2)", bd: "var(--border)" },
  accent: {
    bg: "var(--accent-bg)",
    fg: "var(--accent-dim)",
    bd: "color-mix(in oklch, var(--accent) 30%, transparent)",
  },
  warn: {
    bg: "color-mix(in oklch, var(--state-blocked) 16%, transparent)",
    fg: "color-mix(in oklch, var(--state-blocked) 50%, var(--fg))",
    bd: "color-mix(in oklch, var(--state-blocked) 30%, transparent)",
  },
  error: {
    bg: "color-mix(in oklch, var(--state-error) 14%, transparent)",
    fg: "var(--state-error)",
    bd: "color-mix(in oklch, var(--state-error) 30%, transparent)",
  },
  outline: { bg: "transparent", fg: "var(--fg-3)", bd: "var(--border)" },
};
