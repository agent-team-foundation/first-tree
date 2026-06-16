import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "../../../components/ui/markdown.js";

/** Collapsed cap for the markdown body (~26 lines) — applied ONLY when a
 *  section sits below Summary (GitHub). Sized so a typical summary renders
 *  fully without a click; this section is the catch-up surface someone reads to
 *  reconstruct the work, so forcing "Show more" on a normal-length summary would
 *  defeat its purpose. Only long bodies (approaching the ~1500 char description
 *  budget) clamp here with a bottom fade + "Show more". When Summary is the last
 *  section the cap is dropped entirely (see `capped`). */
const COLLAPSED_MAX_HEIGHT_REM = 30;

/**
 * Summary section — the chat's running work summary + status (set by the
 * owning agent via `chat update --description`), rendered as markdown in the
 * right rail (below Participants). Read-only on the web.
 *
 * Labelled "Summary" rather than "Description": this is a live, continuously
 * re-written account read by whoever is reconstructing context (a returning
 * human, a teammate or agent just joining / waking), not a static blurb. The
 * underlying field is still `chat.description`; only the surface label differs.
 *
 * Height is dynamic via `capped` (owned by ChatRightSidebar):
 *   - capped (GitHub section present below): clamp long bodies to ~30rem with a
 *     fade-to-background mask + "Show more". Overflow is measured against the
 *     cap and re-measured on width changes (the rail is resizable), so the
 *     toggle only appears when content actually exceeds the cap. A height cap +
 *     fade is used rather than `line-clamp`, which is unreliable across markdown
 *     block elements (headings / lists / code).
 *   - uncapped (Summary is the last visible section — the common no-GitHub
 *     case): render the whole body, no fade, no toggle. Nothing sits below it,
 *     so there is nothing to protect; the rail just scrolls.
 *
 * Hidden entirely when the chat has no description — an empty eyebrow would
 * just waste vertical space. The trailing hairline mirrors the other sections.
 */
export function DescriptionSection({
  description,
  capped = true,
}: {
  description: string | null;
  /** Apply the ~30rem cap + fade + "Show more". False when Summary is the last
   *  visible section (no GitHub below), in which case the full body renders. */
  capped?: boolean;
}): ReactNode {
  const trimmed = description?.trim();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const capPx = COLLAPSED_MAX_HEIGHT_REM * rootPx;
    // scrollHeight is the full content height regardless of the maxHeight cap,
    // so this holds whether or not we're currently expanded.
    setOverflowing(el.scrollHeight > capPx + 1);
  }, []);

  useEffect(() => {
    // Overflow only matters while capped; an uncapped body always renders fully.
    if (!trimmed || !capped) {
      setOverflowing(false);
      return;
    }
    measure();
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Width changes (sidebar resize) reflow markdown → re-measure overflow.
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [trimmed, capped, measure]);

  if (!trimmed) return null;

  const clamp = capped && !expanded;
  const showToggle = capped && overflowing;
  const showFade = clamp && overflowing;

  return (
    <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        Summary
      </div>

      <div style={{ position: "relative" }}>
        <div
          ref={bodyRef}
          className="text-body"
          style={{
            padding: "0 var(--sp-3) var(--sp-2_5)",
            color: "var(--fg)",
            maxHeight: clamp ? `${COLLAPSED_MAX_HEIGHT_REM}rem` : undefined,
            overflow: "hidden",
          }}
        >
          <Markdown>{trimmed}</Markdown>
        </div>
        {showFade ? (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: "2.5rem",
              background: "linear-gradient(to bottom, transparent, var(--bg-raised))",
              pointerEvents: "none",
            }}
          />
        ) : null}
      </div>

      {showToggle ? (
        <div style={{ padding: "0 var(--sp-2) var(--sp-2)" }}>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-caption transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]"
            style={{ padding: "var(--sp-1) var(--sp-1_5)", color: "var(--fg-3)", borderRadius: "var(--radius-input)" }}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
