import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";

// NOTE: The old `ConfigSection` was removed in favour of the unified
// `Section` component at `components/ui/section.tsx` (shared with Settings).
// This file now hosts only the row primitives — ConfigRow, the help-icon
// tooltip, and the dense table header used by Tools / Resources tabs.

type ConfigRowProps = {
  label: ReactNode;
  value?: ReactNode;
  /** Inline hint rendered beneath the value (always visible). Use for warnings,
   *  guidance that the user must see (e.g. unbound state). For background
   *  explanations, prefer `helpText` (hover-tooltip via ? icon). */
  description?: ReactNode;
  /** Hover-only help text. Rendered as a ? icon next to the value; the
   *  browser shows the string via the native `title` tooltip. Use for
   *  background context that experienced users don't need to re-read. */
  helpText?: string;
  meta?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  children?: ReactNode;
};

export function ConfigRow({
  label,
  value,
  description,
  helpText,
  meta,
  action,
  icon,
  danger = false,
  children,
}: ConfigRowProps) {
  return (
    <div
      className="grid grid-cols-1 gap-2 text-body md:grid-cols-[8.25rem_minmax(0,1fr)_auto_auto] md:items-start md:gap-4"
      style={{
        padding: "var(--sp-2_5) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate" style={{ color: danger ? "var(--state-error)" : "var(--fg-2)" }}>
          {label}
        </span>
      </div>
      <div className="min-w-0 break-words">
        {children ? (
          <>
            <div className="flex items-center" style={{ gap: "var(--sp-1_5)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
              {helpText && <HelpIconTooltip text={helpText} />}
            </div>
            {description && (
              <div className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-1)" }}>
                {description}
              </div>
            )}
          </>
        ) : (
          <>
            {value != null && (
              <div className="font-medium flex items-center" style={{ color: "var(--fg)", gap: "var(--sp-1_5)" }}>
                <span>{value}</span>
                {helpText && <HelpIconTooltip text={helpText} />}
              </div>
            )}
            {description && (
              <div className="text-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-1)" }}>
                {description}
              </div>
            )}
          </>
        )}
      </div>
      {meta && <div className="shrink-0 md:justify-self-end">{meta}</div>}
      {action && <div className="shrink-0 md:col-start-4 md:justify-self-end">{action}</div>}
    </div>
  );
}

function HelpIconTooltip({ text }: { text: string }) {
  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      className="inline-flex items-center"
      style={{ color: "var(--fg-4)", cursor: "help" }}
    >
      <HelpCircle className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

type TableHeaderProps = {
  columns: string[];
  template: string;
};

export function ConfigTableHeader({ columns, template }: TableHeaderProps) {
  return (
    <div
      className="grid gap-3 mono uppercase text-eyebrow"
      style={{
        gridTemplateColumns: template,
        padding: "var(--sp-2) 0",
        color: "var(--fg-4)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      {columns.map((c) => (
        <div key={c}>{c}</div>
      ))}
    </div>
  );
}
