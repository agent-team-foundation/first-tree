import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The design system defines its typography scale (text-eyebrow … text-display)
// as Tailwind v4 @theme font-size utilities — see the `@theme inline` block in
// index.css. tailwind-merge's default config doesn't know these custom names, so
// it misclassifies them as text-COLOR utilities. When a class string carries both
// a color (e.g. `text-primary-foreground`) and a size (e.g. `text-label`, added by
// Button size="sm"/"xs"), the default twMerge thinks they conflict and drops the
// earlier color class — leaving small filled buttons with no text color (they then
// inherit --fg → dark-on-dark). Registering the scale in the `font-size` group keeps
// size and color in separate conflict groups so both survive.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "eyebrow",
            "caption",
            "label",
            "body",
            "subtitle",
            "title",
            "mobile-caption",
            "mobile-label",
            "mobile-body",
            "mobile-subtitle",
            "mobile-title",
            "lead",
            "headline",
            "display",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

/**
 * Date-only formatter for "Created" / "Joined" / other one-time milestones
 * where minute precision is noise. Format mirrors `formatDate` (zh-CN
 * 2026/05/04) minus the time portion.
 */
export function formatDay(date: string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date));
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Relative-time formatter for "last seen" timestamps. Returns strings
 * like "12 seconds ago", "8 days ago", "yesterday". Native
 * `Intl.RelativeTimeFormat` — no extra dependency. Returns "—" for
 * null/undefined or invalid dates so callers don't have to branch.
 *
 * Unit picking favours days through the first 30 days (mockup Variant
 * B-1 calls out "8 days ago" — `Intl.RelativeTimeFormat` with the
 * coarsest-available unit would collapse 7-13 days to "last week",
 * which loses precision the operator cares about when chasing an
 * agent-offline incident).
 *
 * Locale is "en" intentionally: the Settings → Computers surface is
 * English-first ("first-tree", "Last seen", "Connect computer") and
 * `numeric: "auto"` produces idiomatic English ("yesterday" / "now")
 * that machine-translates poorly. When the wider app gains i18n we can
 * swap the locale here.
 *
 * @param iso ISO 8601 timestamp (server returns `lastSeenAt.toISOString()`).
 */
/**
 * Compact integer formatter used by the Team-page Usage column and the
 * Agent-profile KPI block. Renders values as `1.24M / 845K / 12K / 800`.
 * `Intl.NumberFormat("en", { notation: "compact" })` would say `1.2M` —
 * we want one decimal in the millions/thousands tier so a 1.04M agent
 * does not collapse to `1M` (operationally that hides a 4% delta).
 *
 * Returns `"—"` for null/undefined/NaN so callers don't have to branch.
 */
export function formatCompactCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2).replace(/\.?0+$/, "")}K`;
  return value.toLocaleString("en");
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  // Clamp future-dated timestamps (mild server clock skew can put
  // `lastSeenAt` a few seconds ahead) so the cell never reads "in 3
  // seconds". A clamp here is safer than letting "now" land in some
  // surfaces and "in N seconds" in others.
  const diffMs = Math.min(0, t - Date.now());
  const abs = Math.abs(diffMs);

  let unit: Intl.RelativeTimeFormatUnit;
  let unitMs: number;
  if (abs < MINUTE_MS) {
    unit = "second";
    unitMs = SECOND_MS;
  } else if (abs < HOUR_MS) {
    unit = "minute";
    unitMs = MINUTE_MS;
  } else if (abs < DAY_MS) {
    unit = "hour";
    unitMs = HOUR_MS;
  } else if (abs < MONTH_MS) {
    unit = "day";
    unitMs = DAY_MS;
  } else if (abs < YEAR_MS) {
    unit = "month";
    unitMs = MONTH_MS;
  } else {
    unit = "year";
    unitMs = YEAR_MS;
  }
  return RELATIVE_FORMATTER.format(Math.round(diffMs / unitMs), unit);
}

/**
 * Ultra-compact row timestamp for dense chat lists ("now", "5m", "3h",
 * then "MM/DD"). Shared by the conversation rail and the jump-to
 * palette so a chat reads the same age in both surfaces. Returns ""
 * for null/invalid input — these rows simply omit the time slot rather
 * than render a placeholder dash.
 *
 * ≥ 24h renders `MM/DD` only. Hour:minute is dropped — once a chat
 * slips out of "today", knowing the exact minute is rarely useful and
 * the extra " HH:mm" squeezes the title column for every older row.
 */
export function formatRowTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "";
  const ageMs = Date.now() - t;
  if (ageMs < MINUTE_MS) return "now";
  if (ageMs < HOUR_MS) return `${Math.round(ageMs / MINUTE_MS)}m`;
  if (ageMs < DAY_MS) return `${Math.round(ageMs / HOUR_MS)}h`;
  const parts = new Intl.DateTimeFormat("en-GB", {
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")}`;
}
