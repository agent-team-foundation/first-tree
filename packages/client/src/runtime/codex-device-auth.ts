import { spawn } from "node:child_process";
import {
  BROWSER_LOGIN_TIMEOUT_MS,
  DEVICE_AUTH_TIMEOUT_MS,
  type LoginOutcome,
  runBrowserLogin,
  runLoginSubprocess,
  stripAnsi,
} from "./runtime-login.js";

/**
 * Codex login runners on top of the shared {@link runLoginSubprocess} plumbing:
 *   - PRIMARY browser OAuth ({@link runCodexBrowserLogin}): bare `codex login`
 *     opens the auth page on the host, redirects to codex's localhost callback,
 *     and codex writes `~/.codex/auth.json` itself. No code to enter.
 *   - FALLBACK device code ({@link runCodexDeviceAuthLogin}): headless host;
 *     `codex login --device-auth` prints a verification URL + one-time code.
 *
 * Why device-code parses human text: codex (verified codex-cli 0.130.0 / QA
 * 0.140.0) has NO `--json` for device-auth; it prints an ANSI-coloured prompt.
 * The parse is deliberately lenient (strip ANSI, loose regex) and degrades to a
 * raw-text fallback rather than hard-failing.
 *
 * Real 0.130.0 device-auth first screen this parser is built against:
 *   Follow these steps to sign in with ChatGPT using device code authorization:
 *   1. Open this link in your browser and sign in to your account
 *      https://auth.openai.com/codex/device
 *   2. Enter this one-time code (expires in 15 minutes)
 *      0WYJ-KDUHH
 */

export { stripAnsi } from "./runtime-login.js";
/** @deprecated provider-agnostic alias — prefer {@link LoginOutcome}. */
export type DeviceAuthOutcome = LoginOutcome;

/** A verification URL pointing at the provider's device-authorization page. */
const VERIFICATION_URL_PATTERN = /https?:\/\/[^\s]*device[^\s]*/i;

/**
 * A device user code: groups of uppercase letters/digits joined by a dash
 * (e.g. `0WYJ-KDUHH`). Case-sensitive uppercase so prose words and the
 * dotted version string (`0.130.0`) cannot match.
 */
const USER_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

const EXPIRES_PATTERN = /expires in (\d+)\s*minutes?/i;

export type DeviceCodePrompt = {
  /** Page the user opens on any device to enter the code. */
  verificationUrl: string;
  /** One-time code the user types on that page. */
  userCode: string;
  /** Minutes until the code expires, when the prompt states it. */
  expiresInMinutes?: number;
};

/**
 * Extract the device-code prompt from accumulated `codex login --device-auth`
 * output. Returns null until BOTH the verification URL and the user code are
 * present (they can arrive in separate stdout chunks), so a caller can re-run
 * this on a growing buffer and fire exactly once when the pair is complete.
 */
export function parseDeviceCodePrompt(rawOutput: string): DeviceCodePrompt | null {
  const text = stripAnsi(rawOutput);
  const url = text.match(VERIFICATION_URL_PATTERN);
  const code = text.match(USER_CODE_PATTERN);
  if (!url || !code) return null;
  const prompt: DeviceCodePrompt = { verificationUrl: url[0], userCode: code[0] };
  const minutesRaw = text.match(EXPIRES_PATTERN)?.[1];
  if (minutesRaw) {
    const minutes = Number.parseInt(minutesRaw, 10);
    if (Number.isFinite(minutes)) prompt.expiresInMinutes = minutes;
  }
  return prompt;
}

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

/** PRIMARY: spawn bare `codex login` (browser OAuth). */
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

export type CodexDeviceAuthOptions = {
  /** Absolute path to the codex binary the runtime resolved (bundled or PATH). */
  binary: string;
  /** Environment for the child (e.g. CODEX_HOME); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Fired exactly once, when the verification URL + user code are first parsed
   * out of the child's output. This is the structured event the relay forwards.
   */
  onDeviceCode: (prompt: DeviceCodePrompt) => void;
  /** Raw, ANSI-stripped output, for diagnostics / a raw-text fallback. */
  onRawOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
};

/**
 * FALLBACK (headless): spawn `codex login --device-auth`, relay the device code
 * once parsed, resolve on exit (0 → codex wrote `~/.codex/auth.json`).
 */
export function runCodexDeviceAuthLogin(options: CodexDeviceAuthOptions): Promise<LoginOutcome> {
  const { binary, onDeviceCode, onRawOutput, signal } = options;
  let promptFired = false;
  return runLoginSubprocess({
    command: binary,
    args: ["login", "--device-auth"],
    env: options.env ?? process.env,
    signal,
    timeoutMs: options.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS,
    spawnFn: options.spawnFn ?? spawn,
    label: "codex login --device-auth",
    onOutput: (clean, full) => {
      onRawOutput?.(clean);
      if (promptFired) return;
      const prompt = parseDeviceCodePrompt(full);
      if (prompt) {
        promptFired = true;
        onDeviceCode(prompt);
      }
    },
    classifyExit: ({ code, stderrTail }) => ({
      ok: false,
      // If we never surfaced a code, say so explicitly — the parse-failure /
      // version-drift signal the caller degrades on.
      reason: promptFired ? "exit-nonzero" : "no-prompt",
      error: stderrTail || `codex login --device-auth exited with code ${code ?? "unknown"}`,
    }),
  });
}
