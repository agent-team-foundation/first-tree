import type { spawn } from "node:child_process";
import { BROWSER_LOGIN_TIMEOUT_MS, type LoginOutcome, runBrowserLogin } from "./runtime-login.js";

/**
 * Cursor browser-OAuth login on top of the shared {@link runBrowserLogin}
 * plumbing: `<cursor-binary> login` opens the provider's sign-in page on the
 * host, Cursor's own localhost callback completes the exchange, and the CLI
 * writes its local credential store itself. First Tree never sees the token;
 * it only observes the process outcome and re-probes capabilities.
 */

export type CursorBrowserLoginOptions = {
  /** Absolute path to the cursor binary the runtime resolved (external-only). */
  binary: string;
  /** Environment for the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Fired at most once with a fallback auth URL parsed from output. */
  onAuthUrl?: (url: string) => void;
  /** Raw, ANSI-stripped output, for diagnostics. */
  onRawOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
};

/** Spawn `<cursor-binary> login` (official browser OAuth on the host). */
export function runCursorBrowserLogin(options: CursorBrowserLoginOptions): Promise<LoginOutcome> {
  return runBrowserLogin({
    command: options.binary,
    args: ["login"],
    label: "cursor login",
    env: options.env,
    onAuthUrl: options.onAuthUrl,
    onRawOutput: options.onRawOutput,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    spawnFn: options.spawnFn,
  });
}
