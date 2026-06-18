import { Check } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Every section on the agent-detail page now saves immediately, so there is no
 * longer a save-semantics distinction to explain — the old "Applies immediately /
 * Saved from the Save bar" tags are gone. What remains is a transient "Saved"
 * check that flashes next to a section title right after a successful write.
 */

/** Transient "Saved" check shown next to a section title after a successful immediate write. */
export function SavedFlash({ saved = false }: { saved?: boolean }) {
  if (!saved) return null;
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

/** Compose a section title with its transient "Saved" flash in one inline row. */
export function titleWithSemantics(title: string, saved?: boolean) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>{title}</span>
      <SavedFlash saved={saved} />
    </span>
  );
}

/**
 * Tracks a brief "just saved" window for an immediate-save surface. Returns the
 * flag plus a `markSaved` to call from a mutation's success path. Centralized so
 * every immediate surface flashes the same 2.5s confirmation.
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
