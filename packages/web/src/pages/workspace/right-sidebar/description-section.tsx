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
          <Markdown
            // The shared Markdown defaults to `prose prose-sm`, which (a) blows
            // headings far past body size and (b) silently enlarges the BODY too
            // — both wrong for this narrow rail, where the design body size is the
            // `--text-body` token, the rest of the rail matches it, and the module
            // already has its own "Summary" eyebrow title above. Scope a coherent
            // type scale to the Summary surface only (chat messages keep the
            // default):
            //   - body (p / li) pinned to --text-body, matching the rail
            //     (prose-sm otherwise enlarges it and leaves headings SMALLER than
            //     body text).
            //   - headings collapse to two compact tiers — h1/h2 at
            //     --text-subtitle, h3–h6 at --text-body — so they read as SECTION
            //     LABELS, not titles, and a stray deep heading can't blow up the
            //     layout. Hierarchy is carried by weight + top-margin, not a size
            //     jump.
            //   - tidy-ups: first block hugs the eyebrow (mt-0), last hugs the
            //     hairline (mb-0), list indent tightened for the column.
            //
            // Uses `[&_hN]` / `[&_p]` descendant variants, NOT `prose-*:` — the
            // typography plugin's `prose-*` modifiers wrap selectors in
            // `:where()` (zero specificity), so they only TIE prose-sm's own rules
            // and lose on source order. `[&_h1]` emits a real `.cls h1` selector
            // that reliably beats it.
            //
            // Arbitrary font-sizes need the `length:` data-type hint — a bare
            // `text-[token]` is ambiguous (Tailwind can't tell a length from a
            // color and silently treats it as color), so the size is a no-op
            // unless the value is prefixed with `length:`.
            className="[&_p]:text-[length:var(--text-body)] [&_li]:text-[length:var(--text-body)] [&_:is(h1,h2)]:text-[length:var(--text-subtitle)] [&_:is(h3,h4,h5,h6)]:text-[length:var(--text-body)] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug [&_:is(h1,h2,h3,h4,h5,h6)]:mt-3.5 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:pl-4 [&_ol]:pl-4"
          >
            {trimmed}
          </Markdown>
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
