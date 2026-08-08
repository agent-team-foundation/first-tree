import { type ChildProcess, spawn } from "node:child_process";
import { redactErrorPreview } from "./provider-support/index.js";

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

/**
 * Upper bound on the stderr we keep for a failure message. The login can stream
 * for the whole {@link BROWSER_LOGIN_TIMEOUT_MS} window, so only a tail is
 * retained. This bound stands on its own: a consumer that republishes the
 * failure applies its own ceiling, so the two need not agree exactly — what
 * matters here is that the tail never grows with the volume of output.
 */
export const LOGIN_STDERR_TAIL_MAX = 500;

export type LoginSubprocessOptions = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  spawnFn: typeof spawn;
  /** Human label for error messages, e.g. `codex login` / `claude auth login`. */
  label: string;
  /**
   * Called for every ANSI-stripped output chunk. Deliberately chunk-only: the
   * subprocess must not retain the whole stream so a chatty provider cannot
   * accumulate minutes of output in memory.
   */
  onOutput?: (cleanChunk: string) => void;
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
      onOutput?.(stripAnsi(chunk));
    }

    child.stdout?.on("data", (data: Buffer) => ingest(data.toString("utf-8")));
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      stderrTail = stripAnsi(stderrTail + text).slice(-LOGIN_STDERR_TAIL_MAX);
      ingest(text);
    });

    child.on("error", (err) => finish({ ok: false, reason: "spawn-error", error: err.message }));
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true });
      else finish(classifyExit({ code, stderrTail: stderrTail.trim() }));
    });
  });
}

// Only an `http(s)://` token is a candidate sign-in URL. Anchored at the token
// start so it is linear (no backtracking) — we tokenise on whitespace rather
// than scanning the buffer with a greedy URL regex, which risks polynomial
// backtracking on adversarial output (CodeQL js/polynomial-redos).
const URL_PREFIX = /^https?:\/\//;

// The CLIs print the URL inside prose ("If it didn't open, visit
// http://localhost:1455."), so a captured token can carry trailing sentence
// punctuation. Left on, the href is an INVALID URL — e.g. a port "1455." fails
// `new URL()` parsing — so trim a trailing run of these closers (a linear loop,
// not a `[...]+$` regex which CodeQL flags as polynomial-ReDoS).
const TRAILING_URL_PUNCT = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "'", '"']);

function stripTrailingPunct(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_URL_PUNCT.has(value[end - 1] ?? "")) end--;
  return value.slice(0, end);
}

/**
 * A loopback host is the login CLI's OWN local OAuth callback server (e.g. codex
 * prints "Starting local login server on http://localhost:1455."), never a
 * sign-in page: its root path 404s and opening it does not start the flow. We
 * never surface it as the fallback link.
 */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);
}

/**
 * True if the exact string we would publish as `pendingAuth.authUrl` carries
 * a credential by ANY of `redactErrorPreview`'s detection rules: URL
 * userinfo, a vendor-prefixed token shape (`ghp_...`, `sk-...`, ...)
 * regardless of which key or fragment it sits under, an
 * Authorization/Bearer shape, or a credential-named key=value pair anywhere
 * in the string, including inside a `#fragment`. The provider's real sign-in
 * link is, by definition, a URL the operator has NOT yet authenticated
 * against, so a string with this shape in a login CLI's output is
 * diagnostic noise (a proxy URL, a redirect echo, a copy-pasted example, ...)
 * rather than the fallback link. `pendingAuth.authUrl` is a structured field,
 * not error text, so it never passes through `redactErrorPreview` itself
 * (see `runtime-auth-login.ts`) - candidacy is the only gate standing
 * between such a string and the capability snapshot, and it rejects rather
 * than rewrites: an OAuth URL's query string is part of the provider's
 * protocol, so stripping or altering a matched parameter risks handing the
 * browser a broken redirect instead of just declining to surface an
 * unrelated string.
 *
 * Delegating to `redactErrorPreview` itself - rather than re-checking a
 * subset of its rules (e.g. only credential-NAMED query keys, which misses a
 * vendor token sitting under a neutral key like `?context=ghp_...`, and
 * misses a `#access_token=...` fragment entirely) - is what keeps this
 * candidacy gate provably at least as strict as the publication boundary
 * `CapabilityEntry.error` / `lastAuthError.message` go through: a partial
 * reimplementation would silently fall behind the moment that helper gains a
 * new detection rule.
 */
function hasCredentialShape(url: string): boolean {
  return redactErrorPreview(url, Number.POSITIVE_INFINITY) !== url;
}

/**
 * Pull a usable fallback *sign-in* URL out of accumulated, ANSI-stripped login
 * output, or `null` if none is present yet. The fallback link exists for when
 * the host browser did not auto-open, so it must be the provider's external
 * authorization URL — NOT the CLI's loopback callback server (codex prints that
 * first and, on a successful auto-open, prints nothing else, so a naive "first
 * URL" capture surfaces a link whose root 404s). We therefore:
 *   - only treat a whitespace-terminated token as complete (a trailing,
 *     unterminated token may still be streaming in across a stdout chunk
 *     boundary, so it is held back until the next chunk completes it),
 *   - strip trailing sentence punctuation (so the result parses),
 *   - skip loopback origins, and
 *   - skip a candidate that carries its own auth material, so scanning moves
 *     on to a later, legitimate URL in the same output instead of surfacing
 *     one that never should have been a candidate.
 * Tokenising on whitespace keeps this linear in the output length.
 */
function authUrlFromToken(token: string): string | null {
  if (!token || !URL_PREFIX.test(token)) return null;
  const url = stripTrailingPunct(token);
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (isLoopbackHost(parsed.hostname) || hasCredentialShape(url)) return null;
  return url;
}

const WHITESPACE = /\s/;

/**
 * Ceiling on any token the scanner will assemble or parse, whether it arrived
 * whole or across chunk boundaries. A sign-in URL that does not fit is not a
 * link worth handing to a browser anyway, so an over-long run of non-whitespace
 * is skipped rather than retained, concatenated, or matched. This bounds the
 * token state the scanner retains, assembles and URL-parses; finding token
 * boundaries still reads each character, so total scan work stays linear in the
 * bytes a provider prints during the five-minute login window.
 */
export const AUTH_URL_TOKEN_MAX = 2048;

/**
 * Incremental scanner for the fallback sign-in URL.
 *
 * Output is consumed chunk by chunk, and each complete token is judged exactly
 * once, so a chatty login never re-scans text it has already seen. The only
 * state kept between chunks is the trailing partial token, capped at
 * {@link AUTH_URL_TOKEN_MAX}; a URL split across two chunks is still
 * recognised, and once one is found the scanner retains nothing further.
 */
export type AuthUrlScanner = {
  /** Feed one ANSI-stripped chunk; returns the URL the moment one completes. */
  push(chunk: string): string | null;
  /** Characters currently held between chunks (diagnostics and tests). */
  retainedChars(): number;
  /**
   * Characters examined so far. Read-only seam that lets a test assert the
   * work stays linear in the output and stops entirely once a URL is found,
   * rather than inferring it from how fast the test ran.
   */
  scannedChars(): number;
};

export function createAuthUrlScanner(): AuthUrlScanner {
  let carry = "";
  /** The in-progress token blew the cap: drop it until the next whitespace. */
  let discarding = false;
  let found = false;
  let scanned = 0;

  return {
    push(chunk: string): string | null {
      if (found) return null;
      scanned += chunk.length;
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (!WHITESPACE.test(chunk[i] as string)) continue;
        // The cap applies to the completed token, not just to the tail we
        // carried: a carry that fits and a segment that fits can still exceed
        // it together, and a single over-long run inside one chunk must not be
        // concatenated or parsed either. Measure first, then skip without
        // building the string.
        const overflowed = discarding || carry.length + (i - start) > AUTH_URL_TOKEN_MAX;
        const token = overflowed ? "" : carry + chunk.slice(start, i);
        carry = "";
        discarding = false;
        start = i + 1;
        if (overflowed) continue;
        const url = authUrlFromToken(token);
        if (url) {
          found = true;
          return url;
        }
      }
      const tail = chunk.slice(start);
      if (!tail) return null;
      if (discarding || carry.length + tail.length > AUTH_URL_TOKEN_MAX) {
        discarding = true;
        carry = "";
      } else {
        carry += tail;
      }
      return null;
    },
    retainedChars: () => carry.length,
    scannedChars: () => scanned,
  };
}

/**
 * One-shot form of {@link createAuthUrlScanner} for callers and tests that
 * already hold the whole output as a single string.
 */
export function extractAuthUrl(buffer: string): string | null {
  return createAuthUrlScanner().push(buffer);
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
  // Built only when a caller wants the URL, and inert once it has produced one,
  // so the fallback-link feature never becomes a reason to retain login output.
  const scanner = onAuthUrl ? createAuthUrlScanner() : null;
  let urlFired = false;
  return runLoginSubprocess({
    command,
    args,
    env: options.env ?? process.env,
    signal,
    timeoutMs: options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    spawnFn: options.spawnFn ?? spawn,
    label,
    onOutput: (clean) => {
      onRawOutput?.(clean);
      if (urlFired || !onAuthUrl || !scanner) return;
      const url = scanner.push(clean);
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
