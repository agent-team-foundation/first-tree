import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * One configurable thing inside a Settings `Section`: an optional leading
 * glyph, the name of the setting, a one-line explanation of what it does, and
 * the control that changes it — the control right-aligned on the same line.
 *
 * Why a row instead of the previous stack (label → description → full-width
 * control): a settings section is scanned, not read. Keeping "what it is" on
 * the left and "change it" on the right lets the eye run down a single control
 * column, and stops a narrow `Select` from stretching across the whole page.
 *
 * The row draws no border, background, or radius of its own. The enclosing
 * `Section` owns the single rule above the block, and card chrome stays
 * reserved for genuinely selectable surfaces (DESIGN.md Pillar 5) — the leading
 * glyph gets a small sunken tile so the row reads as an object, but the row
 * content itself is never boxed.
 *
 * Extra props (`id`, `data-*`, `aria-*`) spread onto the row element so a call
 * site can keep its own test/scroll hooks on the outermost node.
 */
export function SettingRow({
  icon,
  title,
  description,
  control,
  children,
  className,
  style,
  ...rest
}: {
  /** Leading line glyph (lucide, `h-4 w-4`), rendered in a sunken tile. */
  icon?: ReactNode;
  /** What this row configures. */
  title: ReactNode;
  /** One line on what the setting does / its current effect. */
  description?: ReactNode;
  /** Right-aligned control — Switch, Select, Button cluster, or a status line. */
  control?: ReactNode;
  /** Full-width content under the row: disclosures, blockers, inline errors. */
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "title" | "children">): ReactNode {
  return (
    <div
      data-setting-row
      className={cn("flex flex-col", className)}
      style={{ gap: "var(--sp-2_5)", padding: "var(--sp-3) 0", ...style }}
      {...rest}
    >
      {/* Stacked on phones so a wide control never overflows; one line with the
          control right-aligned from sm up. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start" style={{ gap: "var(--sp-2_5)" }}>
          {icon ? (
            <span
              aria-hidden
              className="inline-flex shrink-0 items-center justify-center"
              style={{
                width: "var(--sp-7)",
                height: "var(--sp-7)",
                borderRadius: "var(--radius-input)",
                background: "var(--bg-sunken)",
                color: "var(--fg-3)",
              }}
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
              {title}
            </div>
            {description ? (
              <p className="text-label m-0" style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}>
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {control ? (
          <div className="flex shrink-0 flex-wrap items-center sm:justify-end" style={{ gap: "var(--sp-2)" }}>
            {control}
          </div>
        ) : null}
      </div>

      {/* Extras hang off the row's text column, not the section edge. Without
          this they reset to the container's left margin while the row's own
          title sits indented past the glyph, so an expanded block reads as a
          detached slab with a second, further-left edge. */}
      {children ? <div style={{ paddingLeft: textColumnOffset(icon) }}>{children}</div> : null}
    </div>
  );
}

/**
 * Distance from the row's left edge to where its title starts — the glyph tile
 * plus the gap after it, or nothing when the row has no glyph.
 */
function textColumnOffset(icon: ReactNode): string | undefined {
  return icon ? "var(--setting-row-indent)" : undefined;
}
