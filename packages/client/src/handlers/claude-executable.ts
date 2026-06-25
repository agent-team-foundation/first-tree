import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { wellKnownBinDirs } from "../runtime/install-locations.js";
import { getLoginShellPathDirs } from "../runtime/login-shell-path.js";

/**
 * A resolved `claude` candidate is usable only if it is a regular file that is
 * executable. Bare `existsSync` matches a directory named `claude` or a
 * non-executable shim, which would yield a false `ok` the runtime then can't
 * spawn (mirrors codex's executability gate, plus a regular-file check so a
 * directory entry named `claude` doesn't pass via the dir search bit).
 */
export function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type ClaudeExecutableSource = "env" | "path" | "well-known" | "default";

export type ClaudeExecutableResolution = {
  path: string | undefined;
  source: ClaudeExecutableSource;
};

/** Injectable seams so probe tests stay hermetic (no real shell spawn / no host install dirs). */
export type ResolveClaudeExecutableDeps = {
  /** Returns the user's interactive-login-shell PATH dirs; defaults to the memoized probe. */
  loginShellPathDirs?: () => string[];
  /** Returns the curated well-known bin dirs; defaults to the real host list. */
  wellKnownDirs?: () => string[];
  /**
   * Whether to consult the login-shell PATH (which may `spawnSync` a shell).
   * Default `true`. Set `false` on the daemon's pre-connect handler-registration
   * path so startup never blocks on a login shell — the capability probe and the
   * session-start handler resolution still pass `true`, finding a shell-only
   * `claude` lazily, after the WS is connected.
   */
  includeLoginShell?: boolean;
};

/**
 * Install locations probed when `claude` is not on the daemon's PATH.
 *
 * The daemon runs under launchd/systemd with a PATH baked at service-install
 * time, which does NOT include `~/.local/bin` — the Claude Code native
 * installer's default target — nor the node-version-manager / global-npm bins a
 * user installs into. A user who installed via the official installer (or
 * `npm i -g`) therefore has a perfectly working `claude` the daemon cannot see,
 * and the capability probe used to report it as "not installed" (false
 * negative). Checking the known install dirs directly removes the PATH
 * dependency.
 */
function wellKnownClaudeCandidates(dirs: readonly string[]): string[] {
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  return dirs.map((dir) => join(dir, name));
}

/**
 * Resolve which Claude Code binary the SDK should spawn.
 *
 * Priority — cheap (no-spawn) checks first, the login-shell probe last:
 *   1. `CLAUDE_CODE_EXECUTABLE` env var — explicit operator override
 *   2. `claude` on the daemon PATH — reuses whatever the user has installed
 *   3. well-known install dirs (`~/.local/bin`, Homebrew, npm-global, …) —
 *      covers binaries the daemon's service PATH cannot see, with no shell spawn
 *   4. `claude` on the user's interactive **login-shell** PATH — catches bins
 *      the daemon's frozen service PATH never sees (nvm / fnm / volta / mise /
 *      asdf, custom `export PATH=`). This step may `spawnSync` a shell, so it is
 *      consulted last (only when 2–3 miss) and is skipped entirely when
 *      `includeLoginShell: false` (the pre-connect handler-registration path).
 *   5. undefined — fall back to the SDK's bundled native binary
 *
 * The SDK's bundled binary ships as a per-platform **optional** npm dep
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). Any of: a proxy that
 * skips optional deps, an `.npmrc` with `omit=optional`, libc detection
 * failure, or a transient install error leaves that dep missing and the SDK
 * throws "Native CLI binary for <platform>-<arch> not found". Returning a PATH
 * or well-known hit here bypasses the missing bundle entirely.
 */
export function resolveClaudeCodeExecutable(
  opts: { env?: NodeJS.ProcessEnv } & ResolveClaudeExecutableDeps = {},
): ClaudeExecutableResolution {
  const env = opts.env ?? process.env;
  const includeLoginShell = opts.includeLoginShell ?? true;
  const loginShellPathDirs = opts.loginShellPathDirs ?? getLoginShellPathDirs;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const wellKnownDirs = opts.wellKnownDirs ?? (() => wellKnownBinDirs(home));

  const override = env.CLAUDE_CODE_EXECUTABLE;
  if (override && override.length > 0 && existsSync(override)) {
    return { path: override, source: "env" };
  }

  // Daemon PATH first, then cheap well-known dirs — both pure existence checks,
  // no subprocess. Only if those miss do we consult the login-shell PATH, which
  // may spawn a shell.
  const seen = new Set<string>();
  const fromDaemon = findInDirs("claude", env, pathDirs(env), seen);
  if (fromDaemon) return { path: fromDaemon, source: "path" };

  for (const candidate of wellKnownClaudeCandidates(wellKnownDirs())) {
    if (isExecutableFile(candidate)) return { path: candidate, source: "well-known" };
  }

  // Login-shell PATH last — catches binaries on the user's interactive PATH
  // only (nvm / fnm / volta / mise / asdf, custom exports). Skipped on the
  // pre-connect registration path so daemon startup never blocks on a shell.
  if (includeLoginShell) {
    const fromLogin = findInDirs("claude", env, loginShellPathDirs(), seen);
    if (fromLogin) return { path: fromLogin, source: "path" };
  }

  return { path: undefined, source: "default" };
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  if (!rawPath) return [];
  return rawPath.split(delimiter);
}

/**
 * Search `dirs` (in priority order, may contain dupes) for `name`. `seen` is
 * shared across calls so dirs already searched in an earlier (higher-priority)
 * group are not re-checked.
 */
function findInDirs(
  name: string,
  env: NodeJS.ProcessEnv,
  dirs: readonly string[],
  seen: Set<string>,
): string | undefined {
  const isWin = process.platform === "win32";
  const exts = isWin ? splitPathExt(env.PATHEXT) : [""];
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (isExecutableFile(full)) return full;
    }
  }
  return undefined;
}

function splitPathExt(pathext: string | undefined): string[] {
  if (!pathext) return [".EXE", ".CMD", ".BAT", ".COM", ""];
  const parts = pathext.split(";").filter(Boolean);
  return parts.length > 0 ? [...parts, ""] : [""];
}
