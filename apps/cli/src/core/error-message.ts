/**
 * Normalize unknown thrown values into a single-line string for logs and CLI
 * error envelopes. Prefer Error.message; otherwise fall back to String().
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
