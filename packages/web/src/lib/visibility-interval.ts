/**
 * Run `tick()` on a `setInterval` cadence, but only when the tab is in
 * the foreground:
 *
 *   - Mounts the interval immediately if the tab is currently visible
 *     and fires `tick()` once on mount to populate state.
 *   - On `visibilitychange` → hidden: `clearInterval` so the timer truly
 *     stops (no wakeups, no pointless tick-time `document.hidden` returns).
 *   - On `visibilitychange` → visible, OR a window `focus` / `pageshow`:
 *     `setInterval` again AND fire `tick()` immediately so the consumer
 *     catches up after a background period without waiting `intervalMs`.
 *
 * Why resume on `focus` / `pageshow` too, not `visibilitychange` alone:
 * returning from *another application* — e.g. the user switches to a
 * terminal to run a command, then switches back — frequently does NOT
 * fire a reliable `visibilitychange`. That return is a window-focus
 * change, which is not always a page-visibility change, and the two
 * diverge across browser / OS / window-occlusion. Resuming on
 * `visibilitychange` alone leaves the poll paused forever after such a
 * return, so the UI goes stale until a manual refresh — exactly the
 * onboarding "connect your computer" failure mode, where leaving the tab
 * for the terminal is the *expected* flow. `focus` (app/tab refocus) and
 * `pageshow` (bfcache restore) are the belt-and-suspenders resume
 * triggers. Resuming is idempotent: `start()`'s handle guard makes a
 * refocus while already running a no-op (no double tick, no stacked
 * interval), and `onResume` never starts while the page is genuinely
 * hidden. Stop stays bound to `visibilitychange` → hidden only, so a mere
 * blur (window still visible, e.g. side-by-side with a terminal) does not
 * pause the poll.
 *
 * Returns a teardown that clears the interval and removes the listeners.
 * Callers that need their own cancelled-flag for stale-setState protection
 * should still keep it — this helper is purely about the timer lifecycle.
 *
 * Intended for foreground-only modal/dialog polls (Last-step, New-agent,
 * New-connection, onboarding connect-computer). React Query users already
 * have `refetchIntervalInBackground: false` for the same effect.
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

  // Resume on app/tab refocus or bfcache restore, but never start while the
  // page is actually hidden. `start()` is idempotent, so firing this while
  // the interval is already running is a harmless no-op.
  const onResume = (): void => {
    if (!document.hidden) start();
  };

  if (!document.hidden) start();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onResume);
  window.addEventListener("pageshow", onResume);

  return () => {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onResume);
    window.removeEventListener("pageshow", onResume);
  };
}
