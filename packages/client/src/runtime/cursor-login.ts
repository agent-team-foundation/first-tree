import type { spawn } from "node:child_process";
import { RUNTIME_PROVIDERS } from "@first-tree/shared";
import type {
  RuntimeAuthDriver,
  RuntimeAuthLoginResolution,
  RuntimeAuthProbeResult,
} from "../providers/auth-driver.js";
import { BROWSER_LOGIN_TIMEOUT_MS, type LoginOutcome, runBrowserLogin } from "../providers/runtime-login.js";
import { probeCursorCapability } from "./capabilities/cursor.js";
import { type CursorRuntimeBinaryResolution, resolveCursorRuntimeBinary } from "./cursor-binary.js";

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

/** Test seams; production composition passes nothing. */
export type CursorAuthDriverDeps = {
  resolveBinary?: () => CursorRuntimeBinaryResolution;
  runBrowserLogin?: typeof runCursorBrowserLogin;
  probe?: typeof probeCursorCapability;
};

/**
 * Cursor's in-product auth driver. Cursor is external-only, so login drives the
 * SAME resolved binary the handler spawns, including its bounded `--version`
 * smoke check.
 */
export function createCursorAuthDriver(deps: CursorAuthDriverDeps = {}): RuntimeAuthDriver {
  const resolveBinary = deps.resolveBinary ?? resolveCursorRuntimeBinary;
  const browserLogin = deps.runBrowserLogin ?? runCursorBrowserLogin;
  const probe = deps.probe ?? probeCursorCapability;

  // Frozen so this factory's promise ("a fresh, self-contained driver") holds
  // even for a caller that never routes through RUNTIME_AUTH_DRIVERS: nothing
  // downstream of this constructor can repoint resolveLogin/reprobe for the
  // rest of the process.
  return Object.freeze({
    logLabel: "cursor",
    loginLabel: "cursor login",
    artifactLabel: "binary",
    async resolveLogin(): Promise<RuntimeAuthLoginResolution> {
      const resolved = resolveBinary();
      if (!resolved.ok) return { ok: false, error: resolved.error };
      return { ok: true, login: ({ onAuthUrl }) => browserLogin({ binary: resolved.binary, onAuthUrl }) };
    },
    async reprobe(): Promise<readonly RuntimeAuthProbeResult[]> {
      return [{ provider: RUNTIME_PROVIDERS.CURSOR, entry: await probe() }];
    },
  });
}
