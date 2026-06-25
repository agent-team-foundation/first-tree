import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { wellKnownBinDirs } from "./install-locations.js";
import { getLoginShellPathDirs } from "./login-shell-path.js";

export type CodexRuntimeSource = "bundled" | "path";

export type CodexBinaryFallbackResult<TClient> = {
  client: TClient;
  runtimeSource: CodexRuntimeSource;
  codexPathOverride?: string;
  fallbackReason?: string;
};

export type CodexOptionsLike = {
  codexPathOverride?: string;
  env?: Record<string, string>;
};

export type CodexBinaryFallbackDeps = {
  resolvePath?: (env?: Record<string, string>) => string | null;
  verifyPath?: (path: string, env?: Record<string, string | undefined>) => CodexExecutableVerification;
  log?: (message: string) => void;
};

export type CodexExecutableVerification = { ok: true; output?: string } | { ok: false; reason: string };

const CODEX_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /codex runtime binary is missing/i,
  /unable to locate codex cli binaries/i,
  /findCodexPath/,
  /missing optional dependency\s+@openai\/codex[-\w]*/i,
];

export function isCodexBinaryMissingError(input: unknown): boolean {
  const text = errorSearchText(input);
  return CODEX_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

export function formatCodexBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Codex runtime binary is missing on this machine. " +
    "First Tree does not bundle the native Codex engine by default — it resolves a system `codex` on PATH. " +
    "Install it with the daemon's one-click `daemon install-codex` (or `npm install -g @openai/codex`), then run `codex login` and retry." +
    suffix
  );
}

export function createCodexClientWithBinaryFallback<TOptions extends CodexOptionsLike, TClient>(
  options: TOptions,
  construct: (options: TOptions) => TClient,
  deps: CodexBinaryFallbackDeps = {},
): CodexBinaryFallbackResult<TClient> {
  try {
    return { client: construct(options), runtimeSource: "bundled" };
  } catch (err) {
    if (!isCodexBinaryMissingError(err)) throw err;

    const fallbackPath = (deps.resolvePath ?? findCodexExecutableOnPath)(options.env);
    if (!fallbackPath) {
      throw new Error(formatCodexBinaryMissingMessage(err));
    }
    const verification = (deps.verifyPath ?? verifyCodexExecutable)(fallbackPath, options.env);
    if (!verification.ok) {
      throw new Error(
        formatCodexBinaryMissingMessage(`${errorText(err)} PATH codex failed validation: ${verification.reason}`),
      );
    }

    deps.log?.(
      `Codex SDK bundled binary missing; falling back to system codex at ${fallbackPath}. ` +
        `Original error: ${errorText(err)}`,
    );
    return {
      client: construct({ ...options, codexPathOverride: fallbackPath }),
      runtimeSource: "path",
      codexPathOverride: fallbackPath,
      fallbackReason: errorText(err),
    };
  }
}

export function verifyCodexExecutable(
  path: string,
  env: Record<string, string | undefined> = process.env,
): CodexExecutableVerification {
  const result = spawnSync(path, ["--version"], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
    shell: false,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const timedOut = code === "ETIMEDOUT";
    return { ok: false, reason: timedOut ? "`codex --version` timed out" : result.error.message };
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
      .join(" ")
      .trim();
    return { ok: false, reason: `\`codex --version\` exited ${result.status}${detail ? `: ${detail}` : ""}` };
  }
  const output = [result.stdout, result.stderr]
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join(" ")
    .trim();
  return { ok: true, output };
}

/** Injectable seams so probe tests stay hermetic (no real shell spawn / no host install dirs). */
export type FindCodexExecutableDeps = {
  /** Returns the user's interactive-login-shell PATH dirs; defaults to the memoized probe. */
  loginShellPathDirs?: () => string[];
  /** Returns the curated well-known bin dirs; defaults to the real host list. */
  wellKnownDirs?: () => string[];
};

export function findCodexExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindCodexExecutableDeps = {},
): string | null {
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const wellKnownDirs = deps.wellKnownDirs ?? (() => wellKnownBinDirs(home));
  const names = codexExecutableNames(env);
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      if (seen.has(base)) continue;
      seen.add(base);
      for (const name of names) {
        const candidate = join(base, name);
        if (isExecutable(candidate)) return candidate;
      }
    }
    return null;
  };

  // Priority — cheap (no-spawn) checks first, the login-shell probe last:
  // daemon PATH → curated well-known dirs → login-shell PATH. The well-known
  // dirs are pure existence checks; the login-shell PATH (which may `spawnSync`
  // a shell) is consulted last, only when daemon PATH + well-known miss, so a
  // hit in either never triggers a shell spawn. It catches binaries that live
  // only on the user's interactive PATH (nvm / fnm / volta / mise / asdf, custom
  // exports). Codex resolution is never on the daemon's pre-connect path.
  const pathValue = readPathValue(env);
  const fromDaemon = search(pathValue ? pathValue.split(delimiter) : []);
  if (fromDaemon) return fromDaemon;
  const fromWellKnown = search(wellKnownDirs());
  if (fromWellKnown) return fromWellKnown;
  return search(loginShellPathDirs());
}

function errorText(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const maybe = input as { message?: unknown };
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(input);
}

function errorSearchText(input: unknown): string {
  if (input instanceof Error) return [input.message, input.stack].filter(Boolean).join("\n");
  return errorText(input);
}

function readPathValue(env: Record<string, string | undefined>): string | undefined {
  if (process.platform !== "win32") return env.PATH;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === "path");
  return key ? env[key] : undefined;
}

function codexExecutableNames(env: Record<string, string | undefined>): string[] {
  if (process.platform !== "win32") return ["codex"];
  const pathExt = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  const exts = pathExt
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return ["codex", ...exts.map((ext) => `codex${ext.toLowerCase()}`), ...exts.map((ext) => `codex${ext}`)];
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
