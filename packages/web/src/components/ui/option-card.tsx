import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Selectable radio "card" — a single shared primitive for the three radio
 * groups in the New Agent dialog (visibility / computer / runtime) and any
 * future option pickers. Replaces the bare `<input type="radio">` cards that
 * rendered the browser's saturated-blue dot and over-emphasised the selected
 * state with a near-black border.
 *
 * Design language (DESIGN.md §2 near-monochrome, §13 a11y):
 *   - Selected and unselected share the SAME faint `border-border` hairline —
 *     selection is signalled by a *filled* neutral dot + a light ink tint
 *     (~10%) + medium label weight, not by a heavier/darker border.
 *   - The real `<input>` is `sr-only`; the custom dot is the visual. Keyboard
 *     focus deepens the card's own border to `--ring` via `:focus-within`
 *     (a single line — no ringed second frame), matching `Input`.
 *   - Both selection signals are color-independent (filled vs hollow dot +
 *     presence of tint), so the control reads without relying on hue alone.
 */
const optionCardVariants = cva(
  "relative flex cursor-pointer rounded-[var(--radius-panel)] border border-border transition-colors focus-within:outline-none focus-within:border-ring",
  {
    variants: {
      layout: {
        card: "items-start gap-3 p-3",
        pill: "items-center gap-2 px-3 py-1.5",
      },
      selected: {
        // Tint at 10% + medium label weight: clearly apart from the unselected
        // hover wash (accent/30) at a glance, still neutral-ink per §7 — the
        // border stays the same hairline, selection never colors it.
        true: "bg-foreground/10 font-medium",
        false: "hover:bg-accent/30",
      },
      disabled: {
        true: "cursor-not-allowed opacity-50",
        false: "",
      },
    },
    defaultVariants: { layout: "card", selected: false, disabled: false },
  },
);

type OptionCardProps = {
  /** Radio group name — same value across the options in one group. */
  name: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
} & Pick<VariantProps<typeof optionCardVariants>, "layout">;

export function OptionCard({
  name,
  checked,
  onSelect,
  disabled = false,
  layout = "card",
  className,
  children,
}: OptionCardProps) {
  return (
    <label className={cn(optionCardVariants({ layout, selected: checked, disabled }), className)}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} disabled={disabled} className="sr-only" />
      <span
        aria-hidden
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors",
          // `card` aligns the dot with the first line of text; `pill` centers.
          layout === "card" && "mt-0.5",
          checked ? "border-foreground" : "border-border-strong",
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-foreground" />}
      </span>
      {children}
    </label>
  );
}
