import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { DraftStatusChip } from "../../components/ui/draft-status-chip.js";
import { Markdown } from "../../components/ui/markdown.js";
import { Section } from "../../components/ui/section.js";
import { Textarea } from "../../components/ui/textarea.js";

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
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [editing]);

  const action =
    !editing && !disabled ? (
      <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
        <Pencil className="h-3 w-3" /> Edit
      </Button>
    ) : null;

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          System prompt append
          {dirty && <DraftStatusChip status="modified" />}
        </span>
      }
      action={action}
    >
      <div style={{ padding: "var(--sp-3) 0" }}>
        {editing ? (
          <div className="space-y-2">
            <Textarea
              ref={taRef}
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                e.currentTarget.style.height = "auto";
                e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              className="resize-none overflow-hidden font-mono"
              style={{ minHeight: "10rem" }}
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
          <div className="text-body min-h-8">
            {value ? (
              <Markdown>{value}</Markdown>
            ) : (
              <span className="text-muted-foreground italic">No prompt append.</span>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
