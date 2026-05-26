/**
 * Run `tick()` on a `setInterval` cadence, but only when the tab is in
 * the foreground:
 *
 *   - Mounts the interval immediately if the tab is currently visible
 *     and fires `tick()` once on mount to populate state.
 *   - On `visibilitychange` → hidden: `clearInterval` so the timer truly
 *     stops (no wakeups, no pointless tick-time `document.hidden` returns).
 *   - On `visibilitychange` → visible: `setInterval` again AND fire
 *     `tick()` immediately so the consumer catches up after a long
 *     background period without waiting `intervalMs`.
 *
 * Returns a teardown that clears the interval and removes the listener.
 * Callers that need their own cancelled-flag for stale-setState protection
 * should still keep it — this helper is purely about the timer lifecycle.
 *
 * Intended for foreground-only modal/dialog polls (Last-step, New-agent,
 * New-connection, onboarding step 2). React Query users already have
 * `refetchIntervalInBackground: false` for the same effect.
 */
export function runVisibilityAwareInterval(tick: () => void | Promise<void>, intervalMs: number): () => void {
  let handle: ReturnType<typeof setInterval> | null = null;

  const start = (): void => {
    if (handle !== null) return;
    void tick();
    handle = setInterval(tick, intervalMs);
  };

  const stop = (): void => {
    if (handle !== null) {
      clearInterval(handle);
      handle = null;
    }
  };

  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };

  if (!document.hidden) start();
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
