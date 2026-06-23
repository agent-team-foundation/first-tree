import { type ChildProcess, spawn } from "node:child_process";

/**
 * Provider-agnostic plumbing for driving an official CLI login on the daemon
 * host (codex / claude). The OAuth dance is browser ↔ provider ↔ the CLI's own
 * localhost callback, all on the host — First Tree never sees the token; it
 * only observes the process outcome and re-probes capabilities.
 */

/** Matches a CSI ANSI escape sequence (the colour codes in CLI output). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping real ANSI escapes requires matching the ESC control char.
const ANSI_PATTERN = /\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Terminal outcome of a CLI login run. */
export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: "spawn-error" | "exit-nonzero" | "timeout" | "aborted"; error: string };

/** Default ceiling for the browser-OAuth flow: the user signs in interactively. */
export const BROWSER_LOGIN_TIMEOUT_MS = 5 * 60_000;

export type LoginSubprocessOptions = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  spawnFn: typeof spawn;
  /** Human label for error messages, e.g. `codex login` / `claude auth login`. */
  label: string;
  /** Called for every ANSI-stripped output chunk plus the full buffer so far. */
  onOutput?: (cleanChunk: string, fullBuffer: string) => void;
  /** Map a non-zero exit to a failure outcome (exit 0 is always success). */
  classifyExit: (info: { code: number | null; stderrTail: string }) => Extract<LoginOutcome, { ok: false }>;
};

/**
 * Shared skeleton for a login subprocess: spawn, stream output to `onOutput`,
 * enforce a timeout + abort, resolve on exit (0 → ok, else `classifyExit`).
 * Never rejects — every failure mode resolves to a structured
 * `{ ok: false, reason, error }` so the relay layer maps it onto a provider
 * error state rather than handling a throw.
 */
export function runLoginSubprocess(opts: LoginSubprocessOptions): Promise<LoginOutcome> {
  const { command, args, env, signal, timeoutMs, spawnFn, label, onOutput, classifyExit } = opts;
  return new Promise<LoginOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "aborted", error: `${label} aborted before start` });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnFn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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

    function finish(outcome: LoginOutcome): void {
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

// Capture a sign-in URL only once it is whitespace-terminated in the (already
// ANSI-stripped) buffer. `onOutput` fires per stdout chunk, so a URL that spans
// a chunk boundary would otherwise match while still truncated and latch a
// broken fallback link via `urlFired`. The `(?=\s)` lookahead defers the match
// until the terminator (the URL's trailing newline) has actually arrived.
const AUTH_URL_PATTERN = /https?:\/\/\S+(?=\s)/;

// The CLIs print the URL inside prose ("If it didn't open, visit
// http://localhost:1455."), so the captured token can carry trailing sentence
// punctuation. Left on, the href is an INVALID URL — e.g. a port "1455." fails
// `new URL()` parsing — so trim a trailing run of these closers.
const TRAILING_URL_PUNCT = /[.,;:!?)\]}>'"]+$/;

/**
 * Pull a usable fallback sign-in URL out of accumulated, ANSI-stripped login
 * output, or `null` if a complete one isn't present yet. Requires a whitespace
 * terminator (so a URL split across stdout chunks isn't returned truncated) and
 * strips trailing sentence punctuation (so the result is a parseable URL).
 * Exported for unit tests.
 */
export function extractAuthUrl(buffer: string): string | null {
  const match = buffer.match(AUTH_URL_PATTERN);
  if (!match) return null;
  const url = match[0].replace(TRAILING_URL_PUNCT, "");
  return url || null;
}

export type BrowserLoginOptions = {
  /** Command to spawn (a binary path, or `process.execPath` for `node cli.js`). */
  command: string;
  /** Args including any login subcommand, e.g. `["login"]` / `["auth","login"]`. */
  args: string[];
  /** Human label for diagnostics, e.g. `codex login` / `claude auth login`. */
  label: string;
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

/**
 * PRIMARY login: spawn a provider's browser-OAuth login and resolve on exit 0
 * (the CLI wrote its local credentials). Surfaces a fallback auth URL once, so
 * the web can offer a link if the host browser did not auto-launch.
 */
export function runBrowserLogin(options: BrowserLoginOptions): Promise<LoginOutcome> {
  const { command, args, label, onAuthUrl, onRawOutput, signal } = options;
  let urlFired = false;
  return runLoginSubprocess({
    command,
    args,
    env: options.env ?? process.env,
    signal,
    timeoutMs: options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    spawnFn: options.spawnFn ?? spawn,
    label,
    onOutput: (clean, full) => {
      onRawOutput?.(clean);
      if (urlFired || !onAuthUrl) return;
      const url = extractAuthUrl(full);
      if (url) {
        urlFired = true;
        onAuthUrl(url);
      }
    },
    classifyExit: ({ code, stderrTail }) => ({
      ok: false,
      reason: "exit-nonzero",
      error: stderrTail || `${label} exited with code ${code ?? "unknown"}`,
    }),
  });
}
