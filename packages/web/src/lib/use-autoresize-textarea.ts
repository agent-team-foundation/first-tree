import { useLayoutEffect } from "react";

/**
 * Grow a textarea's height to fit its content, capped by the element's
 * own CSS `max-height`. Pair with `style={{ minHeight: ..., maxHeight:
 * ..., overflow: "auto", resize: "none" }}` so:
 *
 *   - empty / short content sits at the min,
 *   - typing or pasting expands the box one line at a time,
 *   - past the cap the textarea stops growing and content scrolls
 *     inside.
 *
 * Why this instead of `react-textarea-autosize`: the library handles a
 * handful of edge cases (font-load delays, ResizeObserver-based width
 * tracking) but adds ~3KB of dependency for a composer that doesn't
 * exercise any of them. The two real edge cases users hit — paste a
 * long block, clear after send — are both covered by re-measuring on
 * every `value` change.
 *
 * Implementation note: setting `height = "auto"` before reading
 * `scrollHeight` is the canonical reset — without it scrollHeight just
 * reports the current rendered height, so the textarea never shrinks
 * back after deletions.
 */
export function useAutoResizeTextarea(ref: React.RefObject<HTMLTextAreaElement | null>, value: string): void {
  // `value` is the trigger: it changes the textarea's content, which
  // changes scrollHeight, which is what we re-measure. Biome can't see
  // the causal link because the effect reads scrollHeight, not value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value IS the dep — its change is what should re-measure.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}
