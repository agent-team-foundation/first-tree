import type { QuestionOption, QuestionPreviewFormat } from "@agent-team-foundation/first-tree-hub-shared";
import DOMPurify from "dompurify";
import { useMemo } from "react";
import { cn } from "../../lib/utils.js";
import { Markdown } from "../ui/markdown.js";

/**
 * Single option inside a `<QuestionMessage />` — renders the SDK's
 * `{ label, description, preview }` shape as a clickable card.
 *
 * Preview rendering:
 *   - `previewFormat: "html"` → DOMPurify-sanitised innerHTML. SDK 0.2.84
 *     already strips `<script>/<style>/<!DOCTYPE>` server-side; DOMPurify
 *     is the second wall plus a CSP `script-src 'none'` content policy.
 *   - `previewFormat: "markdown"` → reuse the chat markdown renderer.
 *   - `null` → no preview block at all.
 *
 * Fully presentational — wiring up `onSelect` is the caller's job (see
 * `<QuestionMessage />`). Disabled state collapses interactivity but keeps
 * the option visible so `answered` / `superseded` cards can still display
 * what the user picked or what was abandoned.
 */
export function OptionCard({
  option,
  previewFormat,
  selected,
  disabled,
  showCheckmark,
  onToggle,
}: {
  option: QuestionOption;
  previewFormat: QuestionPreviewFormat;
  selected: boolean;
  disabled: boolean;
  /** Render a ✓ on the selected option even when disabled (for `answered` view). */
  showCheckmark: boolean;
  onToggle: () => void;
}) {
  const sanitisedHtml = useMemo(() => {
    if (!option.preview || previewFormat !== "html") return null;
    return DOMPurify.sanitize(option.preview, { USE_PROFILES: { html: true } });
  }, [option.preview, previewFormat]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={disabled ? undefined : onToggle}
      className={cn(
        "w-full text-left rounded-[var(--radius-input)] border transition-colors",
        "flex flex-col",
        disabled ? "cursor-default opacity-70" : "cursor-pointer hover:bg-[color:var(--bg-hover)]",
      )}
      style={{
        padding: "var(--sp-2_5) var(--sp-3)",
        gap: "var(--sp-1_5)",
        borderColor: selected ? "var(--accent)" : "var(--border)",
        background: selected ? "var(--bg-active)" : "var(--bg-raised)",
      }}
    >
      {option.preview ? (
        previewFormat === "html" && sanitisedHtml ? (
          <div
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised by DOMPurify above; SDK 0.2.84 also pre-strips script/style/<!DOCTYPE> on emit.
            dangerouslySetInnerHTML={{ __html: sanitisedHtml }}
            className="max-h-[20rem] overflow-auto rounded-[var(--radius-input)] border"
            style={{
              padding: "var(--sp-2)",
              borderColor: "var(--border)",
              background: "var(--bg-sunken)",
            }}
          />
        ) : previewFormat === "markdown" ? (
          <div
            className="max-h-[20rem] overflow-auto rounded-[var(--radius-input)] border"
            style={{
              padding: "var(--sp-2)",
              borderColor: "var(--border)",
              background: "var(--bg-sunken)",
            }}
          >
            <Markdown>{option.preview}</Markdown>
          </div>
        ) : null
      ) : null}
      <div className="flex items-baseline" style={{ gap: "var(--sp-2)" }}>
        <span
          className="mono text-body font-semibold"
          style={{
            color: selected ? "var(--accent)" : "var(--fg)",
          }}
        >
          {option.label}
        </span>
        {showCheckmark && selected ? (
          <span className="mono text-caption" style={{ color: "var(--accent)" }} title="Selected">
            ✓
          </span>
        ) : null}
      </div>
      {option.description ? (
        <span className="text-caption" style={{ color: "var(--fg-3)" }}>
          {option.description}
        </span>
      ) : null}
    </button>
  );
}
