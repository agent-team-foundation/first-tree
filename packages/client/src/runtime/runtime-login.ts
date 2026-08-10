/**
 * Provider-facing login outcome type owned by Runtime contracts.
 *
 * The browser-login subprocess implementation lives under
 * `providers/runtime-login.ts` (provider-shared foundation). Provider
 * production code must import {@link LoginOutcome} via `runtime/contracts`
 * and must not deep-import this file.
 */

/** Terminal outcome of a CLI login run. */
export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: "spawn-error" | "exit-nonzero" | "timeout" | "aborted"; error: string };
