import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Markdown } from "../../components/ui/markdown.js";

/**
 * Redesign §5.4 System Prompt Append — inline editor, no dialog.
 * `Done` collapses the editor but does NOT hit the server; the page-level
 * Save Bar is the single submission path for behavior drafts.
 */

export type PromptSectionProps = {
  value: string;
  baseline: string;
  onChange: (v: string) => void;
  onRevert: () => void;
  disabled?: boolean;
};

export function PromptSection({ value, baseline, onChange, onRevert, disabled }: PromptSectionProps) {
  const [editing, setEditing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty = value !== baseline;

  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

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
          System Prompt Append
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
        <div className="flex gap-2">
          {!editing && !disabled && (
            <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-3 w-3" /> Edit
            </Button>
          )}
        </div>
      </header>

      <div className="px-4 py-3">
        {editing ? (
          <div className="space-y-2">
            <textarea
              ref={taRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              rows={10}
              className="w-full rounded border bg-transparent p-2 font-mono text-body shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Appended to Claude Code's default system prompt."
              maxLength={32_000}
              spellCheck={false}
            />
            <div className="flex justify-end gap-2">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  onRevert();
                  setEditing(false);
                }}
                disabled={!dirty}
              >
                Revert
              </Button>
              <Button size="xs" onClick={() => setEditing(false)}>
                Done
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">
              `Done` collapses this editor. The change is saved only when you click Save in the bar at the bottom of the
              page.
            </p>
          </div>
        ) : (
          <div className="rounded bg-muted p-3 text-body max-h-64 overflow-auto min-h-8">
            {value ? (
              <Markdown>{value}</Markdown>
            ) : (
              <span className="text-muted-foreground italic">No prompt append.</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
