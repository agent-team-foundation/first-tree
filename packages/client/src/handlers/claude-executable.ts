import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type ClaudeExecutableSource = "env" | "path" | "well-known" | "default";

export type ClaudeExecutableResolution = {
  path: string | undefined;
  source: ClaudeExecutableSource;
};

/**
 * Install locations probed when `claude` is not on the daemon's PATH.
 *
 * The daemon runs under launchd/systemd with a PATH baked at service-install
 * time, which does NOT include `~/.local/bin` — the Claude Code native
 * installer's default target. A user who installed via the official installer
 * therefore has a perfectly working `claude` the daemon cannot see, and the
 * capability probe used to report it as "not installed" (false negative).
 * Checking the known install dirs directly removes the PATH dependency.
 */
function wellKnownClaudeCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  return [
    join(home, ".local", "bin", name), // official native installer default
    join(home, ".claude", "local", name), // `claude migrate-installer` target
  ];
}

/**
 * Resolve which Claude Code binary the SDK should spawn.
 *
 * Priority:
 *   1. `CLAUDE_CODE_EXECUTABLE` env var — explicit operator override
 *   2. `claude` on PATH — reuses whatever the user has already installed
 *   3. well-known install dirs (`~/.local/bin`, …) — covers binaries the
 *      daemon's service PATH cannot see
 *   4. undefined — fall back to the SDK's bundled native binary
 *
 * The SDK's bundled binary ships as a per-platform **optional** npm dep
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). Any of: a proxy that
 * skips optional deps, an `.npmrc` with `omit=optional`, libc detection
 * failure, or a transient install error leaves that dep missing and the SDK
 * throws "Native CLI binary for <platform>-<arch> not found". Returning a PATH
 * or well-known hit here bypasses the missing bundle entirely.
 */
export function resolveClaudeCodeExecutable(opts: { env?: NodeJS.ProcessEnv } = {}): ClaudeExecutableResolution {
  const env = opts.env ?? process.env;

  const override = env.CLAUDE_CODE_EXECUTABLE;
  if (override && override.length > 0 && existsSync(override)) {
    return { path: override, source: "env" };
  }

  const found = findOnPath("claude", env);
  if (found) return { path: found, source: "path" };

  for (const candidate of wellKnownClaudeCandidates(env)) {
    if (existsSync(candidate)) return { path: candidate, source: "well-known" };
  }

  return { path: undefined, source: "default" };
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  if (!rawPath) return undefined;
  const isWin = process.platform === "win32";
  const exts = isWin ? splitPathExt(env.PATHEXT) : [""];
  for (const dir of rawPath.split(delimiter)) {
    if (!dir) continue;
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
