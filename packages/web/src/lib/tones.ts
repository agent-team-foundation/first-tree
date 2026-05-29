/**
 * Centralized tone palette for chips, badges, and state indicators.
 *
 * Shared by DenseBadge, StateChip, StateDot, and any future tone-aware
 * component so state colors stay in sync across the app. Each tone
 * returns CSS-variable expressions (not literal colors) so light / dark
 * theming resolves automatically via the --bg-* / --fg-* / --state-*
 * cascade defined in index.css.
 *
 * Adding a new tone? Define it here once and all consumers pick it up.
 */

export type Tone =
  | "neutral"
  | "accent"
  | "warn"
  | "error"
  | "outline"
  | "idle"
  | "working"
  | "needs-you"
  | "blocked"
  | "offline";

export type ToneStyle = {
  /** Background color. */
  bg: string;
  /** Foreground (text / icon) color. */
  fg: string;
  /** Border color. */
  bd: string;
};

/**
 * Canonical tone map. Reference this instead of redefining tones inside
 * individual components — otherwise identical visual roles will drift.
 */
export const TONE_STYLES: Record<Tone, ToneStyle> = {
  neutral: {
    bg: "var(--bg-sunken)",
    fg: "var(--fg-2)",
    bd: "var(--border)",
  },
  // Brand-green tone (the "accent" name is kept for call-site compatibility;
  // it maps to the brand signature color, used for shared/active status badges).
  accent: {
    bg: "var(--brand-bg)",
    fg: "var(--brand-dim)",
    bd: "color-mix(in oklch, var(--brand) 30%, transparent)",
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
  outline: {
    bg: "transparent",
    fg: "var(--fg-3)",
    bd: "var(--border)",
  },
  idle: {
    bg: "color-mix(in oklch, var(--state-idle) 14%, transparent)",
    fg: "var(--state-idle)",
    bd: "color-mix(in oklch, var(--state-idle) 30%, transparent)",
  },
  working: {
    bg: "color-mix(in oklch, var(--state-working) 14%, transparent)",
    fg: "var(--state-working)",
    bd: "color-mix(in oklch, var(--state-working) 30%, transparent)",
  },
  "needs-you": {
    bg: "color-mix(in oklch, var(--state-needs-you) 14%, transparent)",
    fg: "color-mix(in oklch, var(--state-needs-you) 50%, var(--fg))",
    bd: "color-mix(in oklch, var(--state-needs-you) 30%, transparent)",
  },
  blocked: {
    bg: "color-mix(in oklch, var(--state-blocked) 14%, transparent)",
    fg: "color-mix(in oklch, var(--state-blocked) 50%, var(--fg))",
    bd: "color-mix(in oklch, var(--state-blocked) 30%, transparent)",
  },
  offline: {
    bg: "color-mix(in oklch, var(--state-offline) 14%, transparent)",
    fg: "var(--state-offline)",
    bd: "color-mix(in oklch, var(--state-offline) 30%, transparent)",
  },
};

/**
 * Resolve a tone to its style. Useful when the tone is dynamic (e.g.
 * derived from an agent status string). Returns the neutral tone as a
 * safe default when the input is unknown at runtime.
 */
export function toneOf(tone: Tone): ToneStyle {
  return TONE_STYLES[tone] ?? TONE_STYLES.neutral;
}
