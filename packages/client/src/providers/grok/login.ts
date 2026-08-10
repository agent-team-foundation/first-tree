import type { spawn } from "node:child_process";
import { RUNTIME_PROVIDERS } from "@first-tree/shared";
import type { RuntimeAuthDriver, RuntimeAuthLoginResolution, RuntimeAuthProbeResult } from "../auth-driver.js";
import { BROWSER_LOGIN_TIMEOUT_MS, type LoginOutcome, runBrowserLogin } from "../runtime-login.js";
import { type GrokRuntimeBinaryResolution, resolveGrokRuntimeBinary } from "./binary.js";
import { probeGrokCapability } from "./capability.js";

/**
 * Grok Build browser-OAuth login on top of the shared {@link runBrowserLogin}
 * plumbing: `<grok-binary> login` opens the provider's sign-in page on the
 * host, Grok's own callback completes the exchange, and the CLI writes its
 * local credential store itself. First Tree never sees the token; it only
 * observes the process outcome and re-probes capabilities. (`grok login
 * --device-auth` exists for headless hosts but stays operator-run; the
 * in-product flow always drives the browser path.)
 */

export type GrokBrowserLoginOptions = {
  /** Absolute path to the grok binary the runtime resolved (external-only). */
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
  /** Test-only platform override; production reads `process.platform`. */
  platform?: NodeJS.Platform;
};

/** Spawn `<grok-binary> login` (official browser OAuth on the host). */
export function runGrokBrowserLogin(options: GrokBrowserLoginOptions): Promise<LoginOutcome> {
  // Fail closed on Windows before any spawn (belt-and-braces next to the
  // resolver gate — this function is also reachable from the CLI auth flow).
  if ((options.platform ?? process.platform) === "win32") {
    return Promise.resolve({
      ok: false,
      reason: "spawn-error",
      error: "Grok Build login is not supported on Windows in V1 (macOS/Linux only); First Tree fails closed.",
    });
  }
  return runBrowserLogin({
    command: options.binary,
    args: ["login"],
    label: "grok login",
    env: options.env,
    onAuthUrl: options.onAuthUrl,
    onRawOutput: options.onRawOutput,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    spawnFn: options.spawnFn,
  });
}

/** Test seams; production composition passes nothing. */
export type GrokAuthDriverDeps = {
  resolveBinary?: () => GrokRuntimeBinaryResolution;
  runBrowserLogin?: typeof runGrokBrowserLogin;
  probe?: typeof probeGrokCapability;
};

/**
 * Grok Build's in-product auth driver. Grok is external-only, so login drives
 * the SAME resolved binary the handler spawns, including its bounded
 * `--version` smoke check; the Windows fail-closed gate lives in the resolver
 * and in {@link runGrokBrowserLogin}.
 */
export function createGrokAuthDriver(deps: GrokAuthDriverDeps = {}): RuntimeAuthDriver {
  const resolveBinary = deps.resolveBinary ?? resolveGrokRuntimeBinary;
  const browserLogin = deps.runBrowserLogin ?? runGrokBrowserLogin;
  const probe = deps.probe ?? probeGrokCapability;

  // Frozen so this factory's promise ("a fresh, self-contained driver") holds
  // even for a caller that never routes through RUNTIME_AUTH_DRIVERS: nothing
  // downstream of this constructor can repoint resolveLogin/reprobe for the
  // rest of the process.
  return Object.freeze({
    logLabel: "grok",
    loginLabel: "grok login",
    artifactLabel: "binary",
    async resolveLogin(): Promise<RuntimeAuthLoginResolution> {
      const resolved = resolveBinary();
      if (!resolved.ok) return { ok: false, error: resolved.error };
      return { ok: true, login: ({ onAuthUrl }) => browserLogin({ binary: resolved.binary, onAuthUrl }) };
    },
    async reprobe(): Promise<readonly RuntimeAuthProbeResult[]> {
      return [{ provider: RUNTIME_PROVIDERS.GROK, entry: await probe() }];
    },
  });
}
