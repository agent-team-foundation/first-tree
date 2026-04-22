import { Button } from "../../components/ui/button.js";

/**
 * Redesign §5.5 Model — an inline dropdown with a "changed" hint and Revert.
 * No inline save: the page Save Bar handles submission.
 */

export type ModelOption = { value: string; label: string; hint?: string };

export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: "claude-opus-4-6", label: "claude-opus-4-6", hint: "most capable" },
  { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6", hint: "default" },
  { value: "claude-haiku-4-5", label: "claude-haiku-4-5", hint: "fastest" },
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
        border: `1px solid ${dirty ? "color-mix(in oklch, var(--state-blocked) 40%, transparent)" : "var(--border)"}`,
        borderRadius: 6,
      }}
    >
      <header
        className="flex items-center justify-between"
        style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-faint)" }}
      >
        <h3 className="inline-flex items-center gap-2" style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>
          Model
          {dirty && (
            <span
              className="mono uppercase"
              style={{
                fontSize: 10,
                letterSpacing: "0.06em",
                padding: "1px 6px",
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
          className="flex h-9 w-full max-w-md rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="">(agent default)</option>
          {CLAUDE_MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.hint ? ` — ${o.hint}` : ""}
            </option>
          ))}
          {hasExtra && <option value={value}>{value} — custom</option>}
        </select>
        <p className="text-xs text-muted-foreground">
          Choose which Claude model powers this agent. Applies to new sessions immediately; active sessions switch on
          their next message.
        </p>
      </div>
    </section>
  );
}
