import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type ClaudeExecutableSource = "env" | "path" | "default";

export type ClaudeExecutableResolution = {
  path: string | undefined;
  source: ClaudeExecutableSource;
};

/**
 * Resolve which Claude Code binary the SDK should spawn.
 *
 * Priority:
 *   1. `CLAUDE_CODE_EXECUTABLE` env var — explicit operator override
 *   2. `claude` on PATH — reuses whatever the user has already installed
 *   3. undefined — fall back to the SDK's bundled native binary
 *
 * The SDK's bundled binary ships as a per-platform **optional** npm dep
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). Any of: a proxy that
 * skips optional deps, an `.npmrc` with `omit=optional`, libc detection
 * failure, or a transient install error leaves that dep missing and the SDK
 * throws "Native CLI binary for <platform>-<arch> not found". Returning a PATH
 * hit here bypasses the missing bundle entirely.
 */
export function resolveClaudeCodeExecutable(opts: { env?: NodeJS.ProcessEnv } = {}): ClaudeExecutableResolution {
  const env = opts.env ?? process.env;

  const override = env.CLAUDE_CODE_EXECUTABLE;
  if (override && override.length > 0 && existsSync(override)) {
    return { path: override, source: "env" };
  }

  const found = findOnPath("claude", env);
  if (found) return { path: found, source: "path" };

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
