import type { spawn } from "node:child_process";
import { RUNTIME_PROVIDERS } from "@first-tree/shared";
import type {
  RuntimeAuthDriver,
  RuntimeAuthLoginResolution,
  RuntimeAuthProbeResult,
} from "../providers/auth-driver.js";
import { BROWSER_LOGIN_TIMEOUT_MS, type LoginOutcome, runBrowserLogin } from "../providers/runtime-login.js";
import { type CodexBinaryResolution, probeCodexCapability, resolveCodexRuntimeBinary } from "./capabilities/codex.js";

/**
 * Codex browser-OAuth login on top of the shared {@link runBrowserLogin}
 * plumbing: bare `codex login` opens the auth page on the host, redirects to
 * codex's localhost callback, and codex writes `~/.codex/auth.json` itself. No
 * code to enter. First Tree never sees the token; it only observes the process
 * outcome and re-probes capabilities.
 */

export { stripAnsi } from "../providers/runtime-login.js";

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

/** Test seams; production composition passes nothing. */
export type CodexAuthDriverDeps = {
  resolveBinary?: () => Promise<CodexBinaryResolution>;
  runBrowserLogin?: typeof runCodexBrowserLogin;
  probe?: typeof probeCodexCapability;
};

/**
 * Codex's in-product auth driver. Login drives the SAME resolved binary the
 * handler spawns, including its bounded `--version` smoke check, so a login
 * cannot succeed against an artifact the runtime would not use.
 */
export function createCodexAuthDriver(deps: CodexAuthDriverDeps = {}): RuntimeAuthDriver {
  const resolveBinary = deps.resolveBinary ?? resolveCodexRuntimeBinary;
  const browserLogin = deps.runBrowserLogin ?? runCodexBrowserLogin;
  const probe = deps.probe ?? probeCodexCapability;

  // Frozen so this factory's promise ("a fresh, self-contained driver") holds
  // even for a caller that never routes through RUNTIME_AUTH_DRIVERS: nothing
  // downstream of this constructor can repoint resolveLogin/reprobe for the
  // rest of the process.
  return Object.freeze({
    logLabel: "codex",
    loginLabel: "codex login",
    artifactLabel: "binary",
    async resolveLogin(): Promise<RuntimeAuthLoginResolution> {
      const resolved = await resolveBinary();
      if (!resolved.ok) return { ok: false, error: resolved.error };
      return { ok: true, login: ({ onAuthUrl }) => browserLogin({ binary: resolved.binary, onAuthUrl }) };
    },
    async reprobe(): Promise<readonly RuntimeAuthProbeResult[]> {
      return [{ provider: RUNTIME_PROVIDERS.CODEX, entry: await probe() }];
    },
  });
}
