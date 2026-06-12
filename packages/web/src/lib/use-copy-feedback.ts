import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Default duration of the transient "Copied" / "Copy failed" feedback window.
 * Sites that need a different window pass `feedbackMs` instead of redefining
 * their own constant.
 */
export const COPY_FEEDBACK_MS = 1_500;

export type CopyFeedbackStatus = "idle" | "copied" | "failed";

/**
 * Copy-to-clipboard with transient button feedback — the single source of
 * truth for the copy → "Copied" pattern that used to be hand-rolled per
 * call site (issue 999).
 *
 * Contract (modeled on the most robust of the previous copies):
 *  - `copy(text)` writes to the clipboard and flips `status` to `"copied"`,
 *    or to `"failed"` when `navigator.clipboard.writeText` rejects (non-secure
 *    context, or the user denied the clipboard permission) — callers decide
 *    whether to surface the failed state or treat it as idle.
 *  - One reset timer, clear-before-set: a rapid second copy restarts the full
 *    feedback window instead of being cut short by the first timer.
 *  - The timer is cleared on unmount, so no state update fires after the
 *    owning component is gone.
 */
export function useCopyFeedback(options?: { feedbackMs?: number }): {
  status: CopyFeedbackStatus;
  copy: (text: string) => Promise<void>;
  /** Snap back to idle immediately (e.g. when a host dialog reopens). */
  reset: () => void;
} {
  const feedbackMs = options?.feedbackMs ?? COPY_FEEDBACK_MS;
  const [status, setStatus] = useState<CopyFeedbackStatus>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string): Promise<void> => {
      let next: CopyFeedbackStatus;
      try {
        await navigator.clipboard.writeText(text);
        next = "copied";
      } catch {
        next = "failed";
      }
      setStatus(next);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setStatus("idle"), feedbackMs);
    },
    [feedbackMs],
  );

  const reset = useCallback((): void => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = null;
    setStatus("idle");
  }, []);

  return { status, copy, reset };
}
