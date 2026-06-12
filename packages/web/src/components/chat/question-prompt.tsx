/**
 * QuestionPrompt — renders an open question's prompt
 * (`metadata.request.questions[].prompt`) as markdown, clamped when long.
 *
 * Prompts are supposed to be one-line asks (the CLI caps new ones at 200
 * chars), but requests sent before the cap exist with whole markdown
 * documents crammed into the prompt. Rendering those as a bare text node
 * produced an unreadable wall — literal `###` / `**` markers with every
 * newline collapsed. Markdown rendering keeps the formatting; the clamp keeps
 * a legacy wall from swallowing the dock/card (expand on demand).
 *
 * `fadeColor` must match the surface the prompt sits on (the dock and the
 * card's answer block share the needs-you 4% tint) so the clamp's fade-out
 * blends instead of banding.
 */
import { useState } from "react";
import { Markdown } from "../ui/markdown.js";

/** A prompt longer than this (or spanning several lines) gets clamped. */
const CLAMP_CHARS = 240;
const CLAMP_NEWLINES = 2;
/** Collapsed height — roughly six lines of body text. */
const CLAMP_MAX_HEIGHT = "8.5em";

export const QUESTION_SURFACE_BG = "color-mix(in oklch, var(--state-needs-you) 4%, var(--bg-raised))";

export function QuestionPrompt({ prompt, fadeColor = QUESTION_SURFACE_BG }: { prompt: string; fadeColor?: string }) {
  const long = prompt.length > CLAMP_CHARS || prompt.split("\n").length > CLAMP_NEWLINES + 1;
  const [expanded, setExpanded] = useState(false);

  const body = (
    // Headings collapse to body size — a prompt is an ask, not a document;
    // bold weight alone carries the hierarchy without a legacy wall's `##`
    // exploding inside the dock/card.
    <Markdown className="prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-[length:1em] first:prose-p:mt-0 last:prose-p:mb-0">
      {prompt}
    </Markdown>
  );

  if (!long) return body;

  return (
    <div>
      <div style={expanded ? undefined : { maxHeight: CLAMP_MAX_HEIGHT, overflow: "hidden", position: "relative" }}>
        {body}
        {!expanded ? (
          <div
            aria-hidden
            style={{
              position: "absolute",
              insetInline: 0,
              bottom: 0,
              height: "3em",
              background: `linear-gradient(to bottom, transparent, ${fadeColor})`,
            }}
          />
        ) : null}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="mono text-caption rounded-[var(--radius-input)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          marginTop: "var(--sp-1)",
          color: "var(--fg-3)",
          cursor: "pointer",
        }}
      >
        {expanded ? "Show less" : "Show all"}
      </button>
    </div>
  );
}
