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

const MAX_PROMPT_APPEND_LENGTH = 32_000;

export function PromptSection({ value, baseline, onChange, onRevert, disabled }: PromptSectionProps) {
  const [editing, setEditing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty = value !== baseline;
  const countLabel = `${value.length.toLocaleString()} / ${MAX_PROMPT_APPEND_LENGTH.toLocaleString()}`;

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
        <Pencil className="h-3 w-3" /> Edit instructions
      </Button>
    ) : null;

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          Instructions
          {dirty && <DraftStatusChip status="modified" />}
        </span>
      }
      description="Guidance this agent follows during runtime. Changes remain drafts until saved from the Save bar."
      action={action}
    >
      <div style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}>
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
              style={{ minHeight: "16rem" }}
              placeholder="Add persistent instructions for how this agent should behave."
              maxLength={MAX_PROMPT_APPEND_LENGTH}
              spellCheck={false}
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-caption m-0" style={{ color: "var(--fg-4)" }}>
                {countLabel}
              </p>
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
                <Button size="xs" variant="outline" onClick={() => setEditing(false)}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="text-body"
            style={{
              minHeight: value ? "10rem" : undefined,
              border: "var(--hairline) solid var(--border-faint)",
              borderRadius: "var(--radius-panel)",
              background: value ? "var(--bg)" : "var(--bg-sunken)",
              padding: "var(--sp-3)",
            }}
          >
            {value ? <Markdown>{value}</Markdown> : <span className="text-muted-foreground">No instructions yet.</span>}
          </div>
        )}
      </div>
    </Section>
  );
}
