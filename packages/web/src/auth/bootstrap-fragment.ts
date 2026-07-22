let pendingFragment: string | null = null;

/** Install the already-scrubbed callback fragment before React mounts. */
export function installBootstrapAuthFragment(fragment: string | null): void {
  pendingFragment = fragment;
}

/**
 * Consume the callback fragment exactly once. It is intentionally memory-only
 * and is never mirrored into Web Storage, React state, Query state, or logs.
 */
export function consumeBootstrapAuthFragment(): string | null {
  const fragment = pendingFragment;
  pendingFragment = null;
  return fragment;
}
