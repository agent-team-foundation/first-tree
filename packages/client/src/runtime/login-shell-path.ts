import { spawnSync } from "node:child_process";

/**
 * Unique marker that brackets `$PATH` in the probe output so we can isolate it
 * from any prompt / rc-file noise the interactive login shell prints. Chosen to
 * be vanishingly unlikely to appear in a real PATH entry.
 */
const DELIM = "__FT_SHELL_PATH__";

/** Injectable seam for hermetic tests — returns the raw shell stdout, or null on failure. */
export type RunShell = () => string | null;

let memo: { dirs: string[] } | undefined;

/**
 * Discover the directories on the user's interactive **login-shell** PATH.
 *
 * The daemon runs under launchd/systemd with a PATH frozen at service-install
 * time that does NOT source the user's shell rc files (`.zshrc`, `.bash_profile`,
 * …). Node version managers (nvm / fnm / volta / mise / asdf), `~/.npm-global/bin`,
 * pnpm / bun global bins, and any custom `export PATH=` typically live ONLY on
 * that interactive PATH — so a `claude` / `codex` installed there is invisible to
 * the daemon's `env.PATH`. This probes the login shell once and returns the extra
 * dirs so install-only capability detection can find those binaries.
 *
 * Properties:
 *   - **Memoized**: computed at most ONCE per process (the result — including the
 *     empty/failed case — is cached). Detection runs on a background poll, so we
 *     must never spawn a shell per probe.
 *   - **Synchronous** (`spawnSync`): the resolvers that call this run synchronously
 *     at spawn time.
 *   - **Graceful**: returns `[]` on Windows, a non-zero/timed-out shell, missing
 *     stdout, or a parse miss — never throws.
 *
 * @param runShell test-only seam to supply the raw shell stdout without spawning.
 */
export function getLoginShellPathDirs(runShell: RunShell = defaultRunShell): string[] {
  if (memo) return memo.dirs;
  const dirs = compute(runShell);
  memo = { dirs };
  return dirs;
}

/** Reset the memoized result. Tests only. */
export function resetLoginShellPathDirsCache(): void {
  memo = undefined;
}

function compute(runShell: RunShell): string[] {
  if (process.platform === "win32") return [];
  let output: string | null;
  try {
    output = runShell();
  } catch {
    return [];
  }
  if (!output) return [];
  return parsePathFromShellOutput(output);
}

/** Spawn the user's interactive login shell and echo `$PATH` bracketed by {@link DELIM}. */
function defaultRunShell(): string | null {
  const shell = pickShell();
  const result = spawnSync(shell, ["-lic", `printf '${DELIM}%s${DELIM}' "$PATH"`], {
    encoding: "utf-8",
    timeout: 4_000,
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

/** Extract the text between the two delimiters and split it into PATH dirs. */
function parsePathFromShellOutput(output: string): string[] {
  const start = output.indexOf(DELIM);
  if (start < 0) return [];
  const end = output.indexOf(DELIM, start + DELIM.length);
  if (end < 0) return [];
  const path = output.slice(start + DELIM.length, end);
  return path.split(":").filter((dir) => dir.length > 0);
}
