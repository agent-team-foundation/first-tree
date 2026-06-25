import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { wellKnownBinDirs } from "../runtime/install-locations.js";
import { getLoginShellPathDirs } from "../runtime/login-shell-path.js";

export type ClaudeExecutableSource = "env" | "path" | "well-known" | "default";

export type ClaudeExecutableResolution = {
  path: string | undefined;
  source: ClaudeExecutableSource;
};

/** Injectable seam so probe tests stay hermetic (no real shell spawn). */
export type ResolveClaudeExecutableDeps = {
  /** Returns the user's interactive-login-shell PATH dirs; defaults to the memoized probe. */
  loginShellPathDirs?: () => string[];
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
function wellKnownClaudeCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  return wellKnownBinDirs(home).map((dir) => join(dir, name));
}

/**
 * Resolve which Claude Code binary the SDK should spawn.
 *
 * Priority:
 *   1. `CLAUDE_CODE_EXECUTABLE` env var — explicit operator override
 *   2. `claude` on the daemon PATH — reuses whatever the user has installed
 *   3. `claude` on the user's interactive **login-shell** PATH — catches bins
 *      the daemon's frozen service PATH never sees (nvm / fnm / volta / mise /
 *      asdf, `~/.npm-global/bin`, pnpm / bun global, custom `export PATH=`)
 *   4. well-known install dirs (`~/.local/bin`, Homebrew, …) — covers binaries
 *      the daemon's service PATH cannot see, with no shell spawn
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
  const loginShellPathDirs = opts.loginShellPathDirs ?? getLoginShellPathDirs;

  const override = env.CLAUDE_CODE_EXECUTABLE;
  if (override && override.length > 0 && existsSync(override)) {
    return { path: override, source: "env" };
  }

  // Priority: daemon PATH → login-shell PATH → well-known dirs. The login-shell
  // PATH catches binaries that live only on the user's interactive PATH (nvm /
  // fnm / volta / mise / asdf, ~/.npm-global/bin, pnpm / bun, custom exports).
  // The login-shell probe is consulted lazily — only when the daemon PATH misses
  // — so a daemon-PATH hit never triggers a shell spawn.
  const seen = new Set<string>();
  const fromDaemon = findInDirs("claude", env, pathDirs(env), seen);
  if (fromDaemon) return { path: fromDaemon, source: "path" };
  const fromLogin = findInDirs("claude", env, loginShellPathDirs(), seen);
  if (fromLogin) return { path: fromLogin, source: "path" };

  for (const candidate of wellKnownClaudeCandidates(env)) {
    if (existsSync(candidate)) return { path: candidate, source: "well-known" };
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
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

function splitPathExt(pathext: string | undefined): string[] {
  if (!pathext) return [".EXE", ".CMD", ".BAT", ".COM", ""];
  const parts = pathext.split(";").filter(Boolean);
  return parts.length > 0 ? [...parts, ""] : [""];
}
