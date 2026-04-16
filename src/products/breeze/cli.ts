/**
 * Breeze product dispatcher — stub.
 *
 * The TypeScript rewrite of breeze is not yet available. This file is
 * intentionally a thin stub so the top-level dispatcher can wire up the
 * `first-tree breeze <cmd>` namespace without loading any breeze-specific
 * implementation. Phase 1+ will replace this with the real dispatcher.
 */

export async function runBreeze(_args: string[]): Promise<number> {
  console.error(
    "first-tree breeze: the TypeScript implementation is not yet available.",
  );
  console.error("Tracking: see docs/migration/ for the rewrite plan.");
  return 2;
}
