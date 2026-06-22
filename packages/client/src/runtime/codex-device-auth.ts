import { type ChildProcess, spawn } from "node:child_process";

/**
 * Drive a codex login to completion on the daemon host and relay progress to
 * the operator's screen (web console), without the operator installing a
 * separate `codex` CLI.
 *
 * Two flows share one process skeleton ({@link runCodexLoginSubprocess}):
 *   - PRIMARY — browser OAuth ({@link runCodexBrowserLogin}): bare `codex
 *     login` opens the provider auth page on the host, redirects to codex's own
 *     localhost callback, and codex writes `~/.codex/auth.json` itself. No code
 *     to enter; First Tree never sees the token.
 *   - FALLBACK — device code ({@link runCodexDeviceAuthLogin}): for a headless
 *     host with no browser, `codex login --device-auth` prints a verification
 *     URL + one-time code the user enters on another device.
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

/** Matches a CSI ANSI escape sequence (the colour codes in codex output). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real ANSI escapes requires matching the ESC control char.
const ANSI_PATTERN = /\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

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

/** Terminal outcome of a codex login run. */
export type DeviceAuthOutcome =
  | { ok: true }
  | { ok: false; reason: "spawn-error" | "exit-nonzero" | "timeout" | "aborted" | "no-prompt"; error: string };

/** Default ceiling for the device-code flow: just past codex's 15-min expiry. */
export const DEVICE_AUTH_TIMEOUT_MS = 16 * 60_000;

/** Default ceiling for the browser-OAuth flow: the user signs in interactively. */
export const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000;

type CodexLoginSubprocessOptions = {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  spawnFn: typeof spawn;
  /** Human label for error messages, e.g. `codex login --device-auth`. */
  label: string;
  /** Called for every ANSI-stripped output chunk plus the full buffer so far. */
  onOutput?: (cleanChunk: string, fullBuffer: string) => void;
  /** Map a non-zero exit to a failure outcome (exit 0 is always success). */
  classifyExit: (info: { code: number | null; stderrTail: string }) => Extract<DeviceAuthOutcome, { ok: false }>;
};

/**
 * Shared skeleton for the codex login subprocesses: spawn, stream output to
 * `onOutput`, enforce a timeout + abort, resolve on exit (0 → ok, else
 * `classifyExit`). Never rejects — every failure mode resolves to a structured
 * `{ ok: false, reason, error }` so the relay layer maps it onto a provider
 * error state rather than handling a throw.
 */
function runCodexLoginSubprocess(opts: CodexLoginSubprocessOptions): Promise<DeviceAuthOutcome> {
  const { binary, args, env, signal, timeoutMs, spawnFn, label, onOutput, classifyExit } = opts;
  return new Promise<DeviceAuthOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "aborted", error: `${label} aborted before start` });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnFn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, reason: "spawn-error", error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let buffer = "";
    let stderrTail = "";
    let settled = false;

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", error: `${label} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const onAbort = (): void => finish({ ok: false, reason: "aborted", error: `${label} aborted by operator` });
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(outcome: DeviceAuthOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // SIGKILL on a natural-exit path hits an already-dead pid (harmless noop);
      // on timeout/abort it tears the still-running login down.
      child.kill("SIGKILL");
      resolve(outcome);
    }

    function ingest(chunk: string): void {
      const clean = stripAnsi(chunk);
      buffer += clean;
      onOutput?.(clean, buffer);
    }

    child.stdout?.on("data", (data: Buffer) => ingest(data.toString("utf-8")));
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      stderrTail = stripAnsi(stderrTail + text).slice(-500);
      ingest(text);
    });

    child.on("error", (err) => finish({ ok: false, reason: "spawn-error", error: err.message }));
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true });
      else finish(classifyExit({ code, stderrTail: stderrTail.trim() }));
    });
  });
}

export type CodexBrowserLoginOptions = {
  /** Absolute path to the codex binary the runtime resolved (bundled or PATH). */
  binary: string;
  /** Environment for the child (e.g. CODEX_HOME); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Fired at most once with a fallback auth URL parsed from output, so the web
   * can offer a "didn't open? open sign-in" link if the host browser did not
   * auto-launch. Optional.
   */
  onAuthUrl?: (url: string) => void;
  /** Raw, ANSI-stripped output, for diagnostics. Optional. */
  onRawOutput?: (chunk: string) => void;
  /** Abort the login (operator cancelled). */
  signal?: AbortSignal;
  /** Hard ceiling for the interactive browser sign-in. */
  timeoutMs?: number;
  /** Injectable spawn seam — tests pass a fake; production uses node spawn. */
  spawnFn?: typeof spawn;
};

const AUTH_URL_PATTERN = /https?:\/\/[^\s]+/;

/**
 * PRIMARY login: spawn bare `codex login` (browser OAuth). codex opens the
 * provider auth page on the host, runs its own localhost callback, and writes
 * `~/.codex/auth.json` on success (exit 0). The caller re-probes to flip the
 * provider to `ok`. The token never transits First Tree.
 */
export function runCodexBrowserLogin(options: CodexBrowserLoginOptions): Promise<DeviceAuthOutcome> {
  const { binary, onAuthUrl, onRawOutput, signal } = options;
  let urlFired = false;
  return runCodexLoginSubprocess({
    binary,
    args: ["login"],
    env: options.env ?? process.env,
    signal,
    timeoutMs: options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    spawnFn: options.spawnFn ?? spawn,
    label: "codex login",
    onOutput: (clean, full) => {
      onRawOutput?.(clean);
      if (urlFired || !onAuthUrl) return;
      const match = full.match(AUTH_URL_PATTERN);
      if (match) {
        urlFired = true;
        onAuthUrl(match[0]);
      }
    },
    classifyExit: ({ code, stderrTail }) => ({
      ok: false,
      reason: "exit-nonzero",
      error: stderrTail || `codex login exited with code ${code ?? "unknown"}`,
    }),
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
  /** Raw, ANSI-stripped output, for diagnostics / a raw-text fallback. Optional. */
  onRawOutput?: (chunk: string) => void;
  /** Abort the login (operator cancelled). */
  signal?: AbortSignal;
  /** Hard ceiling; codex states a 15-minute code expiry. */
  timeoutMs?: number;
  /** Injectable spawn seam — tests pass a fake; production uses node spawn. */
  spawnFn?: typeof spawn;
};

/**
 * FALLBACK login (headless): spawn `codex login --device-auth`, relay the
 * device code once parsed, resolve on exit (0 → codex wrote `~/.codex/auth.json`).
 */
export function runCodexDeviceAuthLogin(options: CodexDeviceAuthOptions): Promise<DeviceAuthOutcome> {
  const { binary, onDeviceCode, onRawOutput, signal } = options;
  let promptFired = false;
  return runCodexLoginSubprocess({
    binary,
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
