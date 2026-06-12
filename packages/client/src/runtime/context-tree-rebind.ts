/**
 * Lazily re-resolve an agent's Context Tree binding when it started its slot
 * tree-LESS.
 *
 * The binding is resolved once at `AgentSlot.start()` and frozen into the
 * handler config for the slot's lifetime. That's wrong for the new-tree
 * onboarding flow: the agent's slot comes up before the org's `context_tree`
 * setting exists (the kickoff step provisions it moments later), so the slot is
 * frozen tree-less and would never pick up the tree until a daemon restart.
 *
 * This decides whether a fresh re-resolution is warranted at session start:
 *   - already bound (`currentPath` is a non-empty string) → returns null and
 *     does NOT call `resolve`, so the steady-state path pays nothing;
 *   - unbound → calls `resolve` once and returns whatever it produced (a
 *     binding, or null when the org still has no tree).
 *
 * Never throws — a failed re-resolution just leaves the session unbound for
 * this turn (the next new session retries). The caller owns applying the
 * returned binding to its (mutable) handler config.
 *
 * Generic over the resolver's result so callers can thread richer shapes
 * (e.g. `ContextTreeSyncResult` = binding + workspace-health verdict) through
 * the same already-bound short-circuit without this helper knowing about them.
 */
export async function reresolveUnboundTree<T>(
  currentPath: unknown,
  resolve: () => Promise<T | null>,
): Promise<T | null> {
  if (typeof currentPath === "string" && currentPath.length > 0) return null;
  try {
    return await resolve();
  } catch {
    return null;
  }
}
