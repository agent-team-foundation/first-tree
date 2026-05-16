import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Markdown } from "../../components/ui/markdown.js";
import { ConfigSection } from "./flat-section.js";

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

  const action =
    !editing && !disabled ? (
      <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
        <Pencil className="h-3 w-3" /> Edit
      </Button>
    ) : null;

  return (
    <ConfigSection
      eyebrow="prompt"
      title={
        <span className="inline-flex items-center gap-2">
          System prompt append
          {dirty && <ChangedChip />}
        </span>
      }
      action={action}
    >
      <div style={{ padding: "var(--sp-3) 0" }}>
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
            <p className="text-caption text-muted-foreground">Use Save below to apply this prompt change.</p>
          </div>
        ) : (
          <div className="text-body max-h-64 overflow-auto min-h-8">
            {value ? (
              <Markdown>{value}</Markdown>
            ) : (
              <span className="text-muted-foreground italic">No prompt append.</span>
            )}
          </div>
        )}
      </div>
    </ConfigSection>
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
