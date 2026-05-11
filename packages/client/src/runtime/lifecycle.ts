/**
 * Process-wide lifecycle helpers (Step 7).
 *
 * Centralises SIGTERM / SIGINT handling so multiple AgentSlots share a
 * single shutdown chain. Each registered hook runs sequentially; the
 * process exits with the first non-zero code seen, or 0 if all clean.
 *
 * Plan §7 distinguishes "graceful close" (this) from D9 (kill -9 / power
 * loss → orphan resources → manual cleanup). We do not attempt to detect
 * the latter.
 */

export type ShutdownHook = () => Promise<void> | void;

let installed = false;
const hooks: ShutdownHook[] = [];
let shuttingDown: Promise<void> | null = null;

export function registerShutdownHook(hook: ShutdownHook): () => void {
  hooks.push(hook);
  ensureInstalled();
  return () => {
    const idx = hooks.indexOf(hook);
    if (idx >= 0) hooks.splice(idx, 1);
  };
}

/** Run all hooks; idempotent (subsequent calls return the same promise). */
export function runShutdown(): Promise<void> {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    for (const h of [...hooks]) {
      try {
        await h();
      } catch {
        // Best-effort; one hook's failure must not abort the others.
      }
    }
  })();
  return shuttingDown;
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      runShutdown().finally(() => {
        // Replay the original signal default behaviour by exiting.
        process.exit(0);
      });
    });
  }
}

/** Test helper: clear hook list + reinstall on next register. */
export function _resetForTests(): void {
  hooks.length = 0;
  shuttingDown = null;
}
