import { Button } from "../../components/ui/button.js";

/**
 * Redesign §5.5 Model — an inline dropdown with a "changed" hint and Revert.
 * No inline save: the page Save Bar handles submission.
 */

export type ModelOption = { value: string; label: string; hint?: string };

export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: "opus", label: "opus", hint: "most capable" },
  { value: "sonnet", label: "sonnet", hint: "balanced" },
  { value: "haiku", label: "haiku", hint: "fastest" },
];

export type ModelSectionProps = {
  value: string;
  baseline: string;
  onChange: (v: string) => void;
  onRevert: () => void;
  disabled?: boolean;
};

export function ModelSection({ value, baseline, onChange, onRevert, disabled }: ModelSectionProps) {
  const dirty = value !== baseline;
  const hasExtra = !CLAUDE_MODEL_OPTIONS.some((o) => o.value === value) && value !== "";

  return (
    <section
      style={{
        background: "var(--bg-raised)",
        border: `var(--hairline) solid ${dirty ? "color-mix(in oklch, var(--state-blocked) 40%, transparent)" : "var(--border)"}`,
        borderRadius: 6,
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{ padding: "var(--sp-2_5) var(--sp-3_5)", borderBottom: "var(--hairline) solid var(--border-faint)" }}
      >
        <h3 className="inline-flex items-center gap-2 text-body font-semibold" style={{ color: "var(--fg)" }}>
          Model
          {dirty && (
            <span
              className="mono uppercase text-caption"
              style={{
                padding: "var(--hairline) var(--sp-1_5)",
                borderRadius: 3,
                background: "color-mix(in oklch, var(--state-blocked) 16%, transparent)",
                color: "color-mix(in oklch, var(--state-blocked) 50%, var(--fg))",
              }}
            >
              changed
            </span>
          )}
        </h3>
        {dirty && (
          <Button size="xs" variant="ghost" onClick={onRevert} disabled={disabled}>
            Revert
          </Button>
        )}
      </header>
      <div className="px-4 py-3 space-y-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="flex h-9 w-full max-w-md rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          {value === "" && <option value="">(unset — inherits local)</option>}
          {CLAUDE_MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.hint ? ` — ${o.hint}` : ""}
            </option>
          ))}
          {hasExtra && <option value={value}>{value} — custom</option>}
        </select>
        <p className="text-caption text-muted-foreground">
          Choose which Claude model powers this agent. Aliases (opus / sonnet / haiku) follow the CLI's latest-in-family
          mapping and may shift across releases. Applies to new sessions immediately; active sessions switch on their
          next message. Unset falls back to the operator's local <code>~/.claude/settings.json</code> model preference,
          then the CLI default.
        </p>
      </div>
    </section>
  );
}
