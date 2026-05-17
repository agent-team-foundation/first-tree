import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

type ConfigSectionProps = {
  eyebrow?: ReactNode;
  title: ReactNode;
  count?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function ConfigSection({ eyebrow, title, count, action, children, className }: ConfigSectionProps) {
  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-end sm:gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <div className="mono uppercase text-eyebrow" style={{ color: "var(--fg-4)", marginBottom: "var(--sp-1)" }}>
              {eyebrow}
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <h2 className="text-subtitle" style={{ color: "var(--fg)" }}>
              {title}
            </h2>
            {count != null && (
              <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                {count}
              </span>
            )}
          </div>
        </div>
        {action}
      </div>
      <div style={{ borderTop: "var(--hairline) solid var(--border)" }}>{children}</div>
    </section>
  );
}

type ConfigRowProps = {
  label: ReactNode;
  value?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  children?: ReactNode;
};

export function ConfigRow({ label, value, description, meta, action, icon, danger = false, children }: ConfigRowProps) {
  return (
    <div
      className="grid grid-cols-1 gap-2 text-body md:gap-3 md:[grid-template-columns:minmax(10rem,0.7fr)_minmax(0,1.7fr)_auto_auto] md:items-center"
      style={{
        padding: "var(--sp-2_5) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="font-medium truncate" style={{ color: danger ? "var(--state-error)" : "var(--fg)" }}>
          {label}
        </span>
      </div>
      <div className="min-w-0 break-words">
        {children ?? (
          <>
            {value != null && <div style={{ color: "var(--fg-2)" }}>{value}</div>}
            {description && (
              <div className="text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
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
