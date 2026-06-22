import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Unified Section frame used across agent-detail and Settings pages.
 * Replaces the old `ConfigSection` (agent-detail/flat-section.tsx) and
 * `SettingsSection` (settings-section.tsx) — same shape, same rhythm,
 * so the two surfaces no longer drift visually.
 *
 * Visual hierarchy this enforces inside one tab:
 *   - title       = text-subtitle / 600   ("chapter")
 *   - row label   = text-body     / 400   ("field")
 *   - description = text-caption  / 400   ("annotation")
 *
 * Section spacing (`marginTop: var(--sp-1_5)`) is intentionally smaller
 * than the previous SettingsSection's `padding: var(--sp-4) 0` so the page
 * rhythm reads "title — content block — small gap — next title". Adjust
 * via the `className` override if a specific page wants more breathing.
 */

type SectionProps = {
  /** Section heading. `ReactNode` so callers can wrap a coloured span etc. */
  title: ReactNode;
  /** Optional count rendered inline after the title (e.g. " · 3"). */
  count?: ReactNode;
  /** Optional one-line subtitle beneath the heading (Settings-style). */
  description?: ReactNode;
  /** Right-aligned slot for actions or metadata. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function Section({ title, count, description, action, children, className }: SectionProps) {
  return (
    <section className={cn("space-y-3", className)} style={{ marginTop: "var(--sp-6)" }}>
      <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0">
          <h2 className="text-subtitle font-semibold m-0" style={{ color: "var(--fg)" }}>
            {title}
            {count != null && (
              <span className="font-normal" style={{ color: "var(--fg-4)" }}>
                {" · "}
                {count}
              </span>
            )}
          </h2>
          {description && (
            <p className="text-label m-0" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {/* Flat grouped container: a faint rounded outline groups each section's
          rows without a lifted "card" — no shadow, no fill, a hairline-faint
          border. The low-contrast palette wants restraint, so grouping comes
          from the outline + radius alone, not from elevation. */}
      <div
        style={{
          border: "var(--hairline) solid var(--border-faint)",
          borderRadius: "var(--radius-panel)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </section>
  );
}
