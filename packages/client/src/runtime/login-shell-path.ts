import { spawnSync } from "node:child_process";

/**
 * Unique marker that brackets `$PATH` in the probe output so we can isolate it
 * from any prompt / rc-file noise the interactive login shell prints. Chosen to
 * be vanishingly unlikely to appear in a real PATH entry.
 */
const DELIM = "__FT_SHELL_PATH__";

/** Injectable seam for hermetic tests — returns the raw shell stdout, or null on failure. */
export type RunShell = () => string | null;

/**
 * Cap on the number of probe spawns per process. The first probe may run during
 * daemon startup under heavy load and time out; a transient failure must be
 * retryable so discovery is not permanently dead. But a persistently-failing
 * shell must not be re-spawned on every background poll, so after this many
 * unsuccessful attempts we settle to `[]` (cached) and stop probing.
 */
const MAX_ATTEMPTS = 3;

/** Cached result of a SUCCESSFUL probe — or the deterministic skip — kept for the process. */
let memo: { dirs: string[] } | undefined;
/** Count of probe spawns that did NOT succeed, used to enforce {@link MAX_ATTEMPTS}. */
let failedAttempts = 0;

/**
 * Discover the directories on the user's interactive **login-shell** PATH.
 *
 * The daemon runs under launchd/systemd with a PATH frozen at service-install
 * time that does NOT source the user's shell rc files (`.zshrc`, `.bash_profile`,
 * …). Node version managers (nvm / fnm / volta / mise / asdf), `~/.npm-global/bin`,
 * pnpm / bun global bins, and any custom `export PATH=` typically live ONLY on
 * that interactive PATH — so a `claude` / `codex` installed there is invisible to
 * the daemon's `env.PATH`. This probes the login shell and returns the extra
 * dirs so install-only capability detection can find those binaries.
 *
 * Properties:
 *   - **Memoized on success**: a probe that ran the shell, exited 0, and parsed a
 *     PATH is cached for the process — detection runs on a background poll, so we
 *     must never spawn a shell per probe once we have a real answer. The
 *     deterministic Windows / no-`$SHELL` skip is also cached immediately.
 *   - **Retries transient failure**: a spawn error, timeout, non-zero exit, or
 *     parse miss is NOT cached; a later call re-probes, up to {@link MAX_ATTEMPTS}
 *     spawns per process. After the cap is hit with no success, the result settles
 *     to `[]` (cached) so a persistently-failing shell is not re-spawned forever.
 *   - **Synchronous** (`spawnSync`): the resolvers that call this run synchronously
 *     at spawn time.
 *   - **Graceful**: returns `[]` on Windows, a non-zero/timed-out shell, missing
 *     stdout, or a parse miss — never throws.
 *
 * @param runShell test-only seam to supply the raw shell stdout without spawning.
 */
export function getLoginShellPathDirs(runShell: RunShell = defaultRunShell): string[] {
  if (memo) return memo.dirs;
  // Deterministic skip — cache immediately, this is not a transient failure.
  if (process.platform === "win32") {
    memo = { dirs: [] };
    return memo.dirs;
  }
  const dirs = probe(runShell);
  if (dirs) {
    memo = { dirs };
    return dirs;
  }
  // Probe failed (spawn error / timeout / non-zero exit / parse miss). Don't
  // cache a transient failure — allow a later call to re-probe — but stop once
  // the per-process attempt cap is reached, settling to `[]`.
  failedAttempts += 1;
  if (failedAttempts >= MAX_ATTEMPTS) {
    memo = { dirs: [] };
    return memo.dirs;
  }
  return [];
}

/** Reset the memoized result and attempt counter. Tests only. */
export function resetLoginShellPathDirsCache(): void {
  memo = undefined;
  failedAttempts = 0;
}

/**
 * Run one probe. Returns the parsed PATH dirs on success (shell ran, exit 0, PATH
 * parsed — possibly an empty array if the parsed PATH had no usable dirs), or
 * `null` on any failure (spawn error / timeout / non-zero exit / missing stdout /
 * parse miss) so the caller can distinguish "ran ok" from "must retry".
 */
function probe(runShell: RunShell): string[] | null {
  let output: string | null;
  try {
    output = runShell();
  } catch {
    return null;
  }
  if (!output) return null;
  return parsePathFromShellOutput(output);
}

/** Spawn the user's interactive login shell and echo `$PATH` bracketed by {@link DELIM}. */
function defaultRunShell(): string | null {
  const shell = pickShell();
  const result = spawnSync(shell, ["-lic", `printf '${DELIM}%s${DELIM}' "$PATH"`], {
    encoding: "utf-8",
    timeout: 4_000,
    // SIGTERM (the spawnSync default) is ignored by a shell that traps it, spawns
    // a pager, or reads /dev/tty — which would hang this SYNC call (and the event
    // loop) past the timeout. SIGKILL cannot be trapped, so the timeout reliably
    // kills the probe.
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return typeof result.stdout === "string" ? result.stdout : null;
}

function pickShell(): string {
  const shell = process.env.SHELL;
  if (shell && shell.length > 0) return shell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * Extract the text between the two delimiters and split it into PATH dirs.
 * Returns `null` on a parse miss (delimiters absent) so the caller treats it as a
 * retryable failure rather than a genuine empty PATH.
 */
function parsePathFromShellOutput(output: string): string[] | null {
  const start = output.indexOf(DELIM);
  if (start < 0) return null;
  const end = output.indexOf(DELIM, start + DELIM.length);
  if (end < 0) return null;
  const path = output.slice(start + DELIM.length, end);
  return path.split(":").filter((dir) => dir.length > 0);
}
