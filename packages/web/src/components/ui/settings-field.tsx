import { Check } from "lucide-react";
import { type ReactNode, useId } from "react";

/**
 * Vertical-layout field row for Settings panels.
 *
 *   Label
 *   Hint (optional, one line)
 *   ┌──────────────────────────┐
 *   │ input                     │   ← sunken bg, no border, focus-ring on focus
 *   └──────────────────────────┘
 *
 * The previous side-by-side grid (label/hint left, input right) cramped
 * inputs into half the page width and made longer URLs wrap mid-token.
 * Stacking gives the input full bleed and tightens hint-to-input
 * association.
 *
 * Saved indicator floats inline with the label rather than being a
 * separate banner — surfaced exactly where the user just changed a value.
 *
 * The input is a single visual treatment: sunken background only (no
 * border). The previous double-treatment (sunken bg + hairline border)
 * read as visual heavy. Focus state is conveyed via the standard
 * focus-visible ring from `--ring`.
 */
export function SettingsField({
  label,
  hint,
  value,
  onChange,
  saved = false,
  mono = false,
  type = "text",
  placeholder,
  rightSlot,
  readOnly = false,
  pattern,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange?: (next: string) => void;
  saved?: boolean;
  mono?: boolean;
  type?: string;
  placeholder?: string;
  rightSlot?: ReactNode;
  readOnly?: boolean;
  pattern?: string;
}) {
  const inputId = useId();
  const inputClass = `flex-1 min-w-0 outline-none text-body focus-visible:ring-1 focus-visible:ring-ring ${mono ? "mono" : ""}`;
  const inputStyle: React.CSSProperties = {
    padding: "var(--sp-1_5) var(--sp-2_5)",
    background: "var(--bg-sunken)",
    border: "var(--hairline) solid transparent",
    borderRadius: "var(--radius-input)",
    color: "var(--fg)",
  };

  return (
    <div style={{ marginBottom: "var(--sp-4)" }}>
      <div className="flex items-baseline justify-between" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor={inputId} className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {label}
        </label>
        {saved && <SavedIndicator />}
      </div>
      {hint && (
        <p className="text-label" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 var(--sp-2)" }}>
          {hint}
        </p>
      )}
      <div className="flex items-stretch" style={{ gap: "var(--sp-2)" }}>
        {readOnly ? (
          <input
            id={inputId}
            value={value}
            readOnly
            className={inputClass}
            style={{ ...inputStyle, color: "var(--fg-2)" }}
          />
        ) : (
          <input
            id={inputId}
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            type={type}
            placeholder={placeholder}
            pattern={pattern}
            className={inputClass}
            style={inputStyle}
          />
        )}
        {rightSlot}
      </div>
    </div>
  );
}

/**
 * Inline "Saved" confirmation. Fades in (CSS) when the parent renders it
 * and the parent times its own removal (~2s after a successful mutation).
 */
function SavedIndicator() {
  return (
    <span
      className="text-label inline-flex items-center fade-in"
      style={{
        gap: "var(--sp-1)",
        color: "color-mix(in oklch, var(--accent) 35%, var(--fg))",
      }}
    >
      <Check className="h-3 w-3" />
      Saved
    </span>
  );
}
