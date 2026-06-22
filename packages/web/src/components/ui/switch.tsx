import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Accessible on/off toggle — a single control that flips a boolean. Used on the
 * agent detail page to enable/disable a team-recommended resource in place (the
 * row stays, greyed, when off), and anywhere a compact binary toggle fits.
 *
 * Renders as an ARIA switch button: the whole track is the hit target,
 * Space/Enter toggle it, and `aria-checked` exposes the state to assistive tech.
 * It has no built-in visible label — name it via `aria-label`, or point
 * `aria-labelledby` at the row title that already names what it controls.
 *
 * The on/off track shades use confirmed design tokens (`bg-primary` / neutral
 * `bg-secondary`); exact shade is subject to the visual review pass.
 */
export function Switch(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name when no visible label element is associated. */
  "aria-label"?: string;
  /** Id of the visible element (e.g. the row title) that names this switch. */
  "aria-labelledby"?: string;
  id?: string;
  className?: string;
}): ReactNode {
  const { checked, onCheckedChange, disabled, className } = props;
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      aria-checked={checked}
      aria-label={props["aria-label"]}
      aria-labelledby={props["aria-labelledby"]}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0 transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-secondary",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
