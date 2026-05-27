import { type MentionParticipant, segmentMentions } from "@first-tree/shared";
import { type CSSProperties, type RefObject, useEffect, useRef } from "react";

/**
 * Renders a mirror layer that paints `@<participant>` chips behind a
 * regular `<textarea>` so the user sees inline highlight for resolved
 * mentions as they type / paste. The textarea itself stays plain text;
 * the host sets `color: transparent; caret-color: var(--fg)` on the
 * textarea so the caret + selection stay visible while the text is
 * actually drawn by this overlay.
 *
 * Layout contract — to keep the rendered glyphs character-for-character
 * aligned with the textarea, the overlay MUST inherit the textarea's
 * `font`, `letter-spacing`, `line-height`, padding, and `white-space`
 * behaviour. The host passes those via `mirrorStyle` (typically the
 * same style object used on the textarea, minus background/color).
 *
 * Long drafts that scroll inside the textarea are handled by an inner
 * `transform: translateY(-scrollTop)` — using a fixed-position inner
 * shifts the painted glyphs in lockstep with the textarea's own
 * scrolling without us having to manage two scroll containers.
 *
 * The overlay is `pointer-events: none`, so it never steals clicks /
 * selection from the textarea below it.
 */
export function MentionHighlightOverlay({
  value,
  participants,
  textareaRef,
  mirrorStyle,
  chipClassName,
}: {
  value: string;
  participants: MentionParticipant[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Style overrides that MUST match the textarea so glyph positions
   *  align (font, padding, line-height, white-space, box-sizing). */
  mirrorStyle: CSSProperties;
  /** Visual class for the chip span — kept out of the component so
   *  callers can theme it without forking the layout logic. */
  chipClassName: string;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const segments = segmentMentions(value, participants);

  // Mirror the textarea's scroll position into the inner mirror box.
  // Listen to `scroll` for manual scrolls, and re-sync after every render
  // because layout-altering edits (Enter at the bottom, paste of a long
  // string) change scrollHeight without firing a scroll event — the
  // `value` dep below is what drives that post-edit re-sync.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is intentionally a sentinel — its identity change is what triggers the post-edit re-sync, but the effect body doesn't read it.
  useEffect(() => {
    const ta = textareaRef.current;
    const inner = innerRef.current;
    if (!ta || !inner) return;
    const sync = () => {
      inner.style.transform = `translateY(${-ta.scrollTop}px)`;
    };
    sync();
    ta.addEventListener("scroll", sync, { passive: true });
    return () => ta.removeEventListener("scroll", sync);
  }, [value, textareaRef]);

  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        // Background must stay transparent so the textarea's own
        // background (and focus border) keeps showing through.
        background: "transparent",
        // The outer box doesn't typeset anything itself — typography
        // lives on the inner box so callers can spread the textarea's
        // style as-is. Keeping the outer style minimal also avoids
        // accidental inheritance (e.g. a `padding` on the outer box
        // would shrink the painted area relative to the textarea).
      }}
    >
      <div
        ref={innerRef}
        style={{
          // `inset: 0` would clip the inner box to the outer's size,
          // but scrolling requires the inner box to be as tall as the
          // textarea's full scrollHeight — height: auto + width: 100%
          // lets it grow vertically while the outer `overflow: hidden`
          // hides anything beyond the visible window.
          width: "100%",
          color: "var(--fg)",
          whiteSpace: "pre-wrap",
          wordWrap: "break-word",
          ...mirrorStyle,
          // Always transparent — only the chip span gets a background.
          background: "transparent",
        }}
      >
        {segments.map((seg, i) =>
          seg.kind === "mention" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are recomputed every render; positional key is stable for THIS frame.
            <span key={`m-${i}`} className={chipClassName}>
              {seg.value}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: same as above — purely presentational mapping.
            <span key={`t-${i}`}>{seg.value}</span>
          ),
        )}
        {/* Trailing newline guard: a textarea with a final `\n` renders an
         *  extra empty line that adds to scrollHeight. A pure-text mirror
         *  collapses trailing whitespace, so we pad with a zero-width
         *  space inside an extra line to keep heights in sync. */}
        {value.endsWith("\n") && "​"}
      </div>
    </div>
  );
}
