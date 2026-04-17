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
    <section className={`rounded-md border bg-white ${dirty ? "border-amber-300" : "border-gray-200"}`}>
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h3 className="text-sm font-medium flex items-center gap-2">
          Model
          {dirty && <span className="text-xs rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">changed</span>}
        </h3>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={onRevert} disabled={disabled}>
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
