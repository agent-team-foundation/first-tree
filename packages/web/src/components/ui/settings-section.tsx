import type { ReactNode } from "react";

/**
 * Section frame for Settings pages. Mirrors the agent configuration
 * sections: compact heading, optional metadata at the right, then a single
 * hairline before the fields/list rows. The page reads as a clean stack
 * without card frames or sidebar-era visual weight.
 *
 * Title sits as a normal H2 with optional one-line description below;
 * the optional `right` slot is for inline metadata (e.g. count badge).
 * Form-style sections put their Save button next to the relevant field,
 * not in the right slot — see the existing Settings panels for the pattern.
 */
export function SettingsSection({
  title,
  description,
  right,
  children,
}: {
  title: string;
  description?: string;
  right?: ReactNode;
  children: ReactNode;
  /** Kept for existing call sites; sections no longer draw a top divider. */
  isFirst?: boolean;
}) {
  return (
    <section
      style={{
        padding: "var(--sp-4) 0",
      }}
    >
      <div className="flex items-end justify-between" style={{ gap: "var(--sp-3)" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="text-subtitle font-medium m-0" style={{ color: "var(--fg)" }}>
            {title}
          </h2>
          {description && (
            <p className="text-label m-0" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
              {description}
            </p>
          )}
        </div>
        {right}
      </div>
      <div
        style={{
          marginTop: "var(--sp-2)",
          paddingTop: "var(--sp-3)",
          borderTop: "var(--hairline) solid var(--border)",
        }}
      >
        {children}
      </div>
    </section>
  );
}
