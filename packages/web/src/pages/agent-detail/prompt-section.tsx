import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Markdown } from "../../components/ui/markdown.js";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "../../components/ui/panel.js";

/**
 * System Prompt Append — inline editor, no dialog. `Done` collapses the editor
 * but does NOT hit the server; the page-level Save Bar is the single submission
 * path for behavior drafts.
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
    <Panel
      style={{
        borderColor: dirty ? "color-mix(in oklch, var(--state-blocked) 70%, transparent)" : undefined,
      }}
    >
      <PanelHeader>
        <PanelTitle>
          System prompt append
          {dirty && <ChangedChip />}
        </PanelTitle>
        {!editing && !disabled && (
          <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
            <Pencil className="h-3 w-3" /> Edit
          </Button>
        )}
      </PanelHeader>

      <PanelBody>
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
      </PanelBody>
    </Panel>
  );
}

function ChangedChip() {
  return (
    <span
      className="mono uppercase text-caption"
      style={{
        padding: "var(--hairline) var(--sp-1_5)",
        borderRadius: "var(--radius-chip)",
        background: "color-mix(in oklch, var(--state-blocked) 16%, transparent)",
        color: "color-mix(in oklch, var(--state-blocked) 60%, var(--fg))",
      }}
    >
      changed
    </span>
  );
}
