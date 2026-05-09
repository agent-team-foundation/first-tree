import type { ReactNode } from "react";

/**
 * Section frame for Settings master-detail pages. The first section in a
 * page renders without a top divider (it sits flush against the page
 * header); every subsequent section gets a hairline rule above so the
 * page reads as a clean vertical stack of related-but-distinct
 * configuration groups, not a jumble of forms.
 *
 * Title sits as a normal H2 with optional one-line description below;
 * the optional `right` slot is for inline metadata (e.g. count badge).
 * Form-style sections put their Save button at the *bottom* of the
 * children, not in the right slot — see the existing Settings panels
 * for the pattern.
 */
export function SettingsSection({
  title,
  description,
  right,
  children,
  isFirst = false,
}: {
  title: string;
  description?: string;
  right?: ReactNode;
  children: ReactNode;
  /** Pass `true` to suppress the top divider — the first section in a stack. */
  isFirst?: boolean;
}) {
  return (
    <section
      style={{
        padding: "var(--sp-6) 0",
        borderTop: isFirst ? undefined : "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div className="flex items-baseline justify-between" style={{ gap: "var(--sp-3)" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="text-subtitle font-medium m-0" style={{ color: "var(--fg)" }}>
            {title}
          </h2>
          {description && (
            <p className="text-label m-0" style={{ color: "var(--fg-3)", marginTop: 2 }}>
              {description}
            </p>
          )}
        </div>
        {right}
      </div>
      <div style={{ marginTop: "var(--sp-4)" }}>{children}</div>
    </section>
  );
}
