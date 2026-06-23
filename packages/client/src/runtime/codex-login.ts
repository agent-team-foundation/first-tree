import type { spawn } from "node:child_process";
import { BROWSER_LOGIN_TIMEOUT_MS, type LoginOutcome, runBrowserLogin } from "./runtime-login.js";

/**
 * Codex browser-OAuth login on top of the shared {@link runBrowserLogin}
 * plumbing: bare `codex login` opens the auth page on the host, redirects to
 * codex's localhost callback, and codex writes `~/.codex/auth.json` itself. No
 * code to enter. First Tree never sees the token; it only observes the process
 * outcome and re-probes capabilities.
 */

export { stripAnsi } from "./runtime-login.js";

export type CodexBrowserLoginOptions = {
  /** Absolute path to the codex binary the runtime resolved (bundled or PATH). */
  binary: string;
  /** Environment for the child (e.g. CODEX_HOME); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Fired at most once with a fallback auth URL parsed from output. */
  onAuthUrl?: (url: string) => void;
  /** Raw, ANSI-stripped output, for diagnostics. */
  onRawOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
};

/** Spawn bare `codex login` (browser OAuth → `~/.codex/auth.json`). */
export function runCodexBrowserLogin(options: CodexBrowserLoginOptions): Promise<LoginOutcome> {
  return runBrowserLogin({
    command: options.binary,
    args: ["login"],
    label: "codex login",
    env: options.env,
    onAuthUrl: options.onAuthUrl,
    onRawOutput: options.onRawOutput,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    spawnFn: options.spawnFn,
  });
}
