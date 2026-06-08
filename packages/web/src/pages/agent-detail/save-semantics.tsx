import { Check } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The two save semantics on the agent-detail page, made explicit (PR2 P0).
 * Every section is one of exactly two kinds, with ONE canonical label each so
 * the distinction reads at a glance:
 *   - immediate: writes land as soon as you make them (identity, appearance,
 *     bind/re-bind, repositories, skills, MCP, instructions).
 *   - draft: changes are staged and committed together from the Save bar
 *     (model, reasoning effort, environment variables).
 */
export type SaveSemanticsKind = "immediate" | "draft";

const LABELS: Record<SaveSemanticsKind, string> = {
  immediate: "Applies immediately",
  draft: "Saved from the Save bar",
};

/**
 * Quiet tag rendered next to a section title. For immediate sections it flips to
 * a transient "Saved" check right after a successful write (drive `saved` from
 * `useJustSaved`); draft sections never flash here — the Save bar owns their
 * saved state.
 */
export function SaveSemanticsTag({ kind, saved = false }: { kind: SaveSemanticsKind; saved?: boolean }) {
  if (saved && kind === "immediate") {
    return (
      <span
        className="inline-flex items-center gap-1 text-caption font-normal"
        style={{ color: "var(--success)" }}
        role="status"
      >
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  }
  return (
    <span className="text-caption font-normal" style={{ color: "var(--fg-4)" }}>
      {LABELS[kind]}
    </span>
  );
}

/** Compose a section title with its save-semantics tag in one inline row. */
export function titleWithSemantics(title: string, kind: SaveSemanticsKind, saved?: boolean) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{title}</span>
      <SaveSemanticsTag kind={kind} saved={saved} />
    </span>
  );
}

/**
 * Tracks a brief "just saved" window for an immediate-save surface. Returns the
 * flag plus a `markSaved` to call from a mutation's success path. Centralized so
 * every immediate surface flashes the same 2.5s confirmation (mirrors the
 * SaveBar's own justSaved timing).
 */
export function useJustSaved(): { justSaved: boolean; markSaved: () => void } {
  // Tick-based, not a plain boolean: each markSaved bumps `tick`, which re-runs
  // the effect and restarts the 2.5s window even when a save lands while the
  // previous "Saved" is still showing (a boolean would no-op the second save and
  // let the confirmation expire early).
  const [tick, setTick] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (tick === 0) return;
    setJustSaved(true);
    const t = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(t);
  }, [tick]);
  return { justSaved, markSaved: () => setTick((t) => t + 1) };
}
