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
    <section className={`rounded-md border bg-white ${dirty ? "border-amber-300" : "border-gray-200"}`}>
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h3 className="text-sm font-medium flex items-center gap-2">
          System Prompt Append
          {dirty && <span className="text-xs rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">changed</span>}
        </h3>
        <div className="flex gap-2">
          {!editing && !disabled && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
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
              className="w-full rounded border bg-transparent p-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Appended to Claude Code's default system prompt."
              maxLength={32_000}
              spellCheck={false}
            />
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onRevert();
                  setEditing(false);
                }}
                disabled={!dirty}
              >
                Revert
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>
                Done
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              `Done` collapses this editor. The change is saved only when you click Save in the bar at the bottom of the
              page.
            </p>
          </div>
        ) : (
          <div className="rounded bg-muted p-3 text-sm max-h-64 overflow-auto min-h-8">
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
