import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { wellKnownBinDirs } from "./install-locations.js";
import { getLoginShellPathDirs } from "./login-shell-path.js";

/**
 * Cursor CLI binary resolution.
 *
 * The Cursor agent CLI ships as a single binary exposed under TWO names —
 * `agent` (preferred) and `cursor-agent` (legacy alias, same binary). We
 * resolve either from PATH, well-known install directories, or the user's
 * interactive-login-shell PATH, and prefer `agent` when both are present.
 *
 * Unlike codex, First Tree does NOT bundle a Cursor binary: the runtime always
 * spawns an externally-installed `cursor-agent` (installed via
 * `curl https://cursor.com/install -fsS | bash`). So there is no bundled-first
 * fallback chain here — resolution is PATH-only.
 */

export type CursorExecutableVerification =
  | { ok: true; output?: string }
  | { ok: false; reason: string; transient: boolean };

/**
 * `<cursor> --version` smoke-check ceiling. A cold binary behind a
 * version-manager shim or on a loaded machine can take a few seconds to first
 * respond, so keep the bound generous. Paired with the transient-vs-missing
 * split below so a flaked check is retried, not declared permanently missing.
 */
const CURSOR_VERSION_VERIFY_TIMEOUT_MS = 10_000;

/**
 * Spawn errnos that mean "the machine couldn't run the check right now", NOT
 * "the binary is broken/absent" — these map to a transient verification
 * failure (→ retry), never to a missing-binary verdict.
 */
const TRANSIENT_SPAWN_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "EAGAIN", "ENOMEM", "ETXTBSY"]);

/**
 * Kill signals that mean "the binary crashed deterministically" — a broken /
 * incompatible native install that faults the same way on every retry. These
 * stay NON-transient; any other kill signal (the timeout SIGTERM/SIGKILL, an
 * OOM kill, an external shutdown) is a host condition and stays transient.
 */
const DETERMINISTIC_CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set([
  "SIGSEGV",
  "SIGABRT",
  "SIGILL",
  "SIGBUS",
  "SIGFPE",
]);

/**
 * Executable names to probe, in preference order. `agent` first, `cursor-agent`
 * second — both symlink the same binary, so either works; preferring `agent`
 * matches the interactive CLI the user installed.
 */
export const CURSOR_EXECUTABLE_NAMES: readonly string[] = ["agent", "cursor-agent"];

const CURSOR_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /cursor runtime binary is missing/i,
  /unable to locate the cursor-agent cli/i,
];

export function isCursorBinaryMissingError(input: unknown): boolean {
  const text = errorText(input);
  return CURSOR_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

export function formatCursorBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Cursor runtime binary is missing on this machine. " +
    "First Tree resolves the Cursor agent CLI (`agent` / `cursor-agent`) from PATH or well-known install directories. " +
    "Install it with `curl https://cursor.com/install -fsS | bash`, then run `cursor-agent login` and retry." +
    suffix
  );
}

/** Injectable seams so probe/handler tests stay hermetic (no real shell spawn / host dirs). */
export type FindCursorExecutableDeps = {
  loginShellPathDirs?: () => string[];
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/**
 * Resolve the absolute path of the Cursor agent CLI the runtime would spawn.
 *
 * Priority: daemon PATH → curated well-known install dirs → interactive
 * login-shell PATH. For each source, `agent` is tried before `cursor-agent`.
 * Returns null when neither name resolves anywhere.
 */
export function findCursorExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindCursorExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const wellKnownDirs = deps.wellKnownDirs ?? (() => wellKnownBinDirs(home));
  const names = cursorExecutableNames(env, platform);
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

  const pathValue = readPathValue(env, platform);
  const fromDaemon = search(pathValue ? pathValue.split(pathDelimiter) : []);
  if (fromDaemon) return fromDaemon;
  const fromWellKnown = search(wellKnownDirs());
  if (fromWellKnown) return fromWellKnown;
  return search(loginShellPathDirs());
}

/**
 * `<cursor> --version` smoke check. Runtime/login helper only — the capability
 * probe is install-only and does NOT call this (it never launches the binary).
 */
export function verifyCursorExecutable(
  path: string,
  env: Record<string, string | undefined> = process.env,
): CursorExecutableVerification {
  const result = spawnSync(path, ["--version"], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
    shell: false,
    timeout: CURSOR_VERSION_VERIFY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    const code = readErrnoCode(result.error);
    const timedOut = code === "ETIMEDOUT";
    const transient = timedOut || (typeof code === "string" && TRANSIENT_SPAWN_CODES.has(code));
    return { ok: false, transient, reason: timedOut ? "`cursor-agent --version` timed out" : result.error.message };
  }
  if (result.signal) {
    const crashed = DETERMINISTIC_CRASH_SIGNALS.has(result.signal);
    return { ok: false, transient: !crashed, reason: `\`cursor-agent --version\` killed by ${result.signal}` };
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
      .join(" ")
      .trim();
    return {
      ok: false,
      transient: false,
      reason: `\`cursor-agent --version\` exited ${result.status}${detail ? `: ${detail}` : ""}`,
    };
  }
  const output = [result.stdout, result.stderr]
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join(" ")
    .trim();
  return { ok: true, output };
}

function readErrnoCode(error: Error): string | undefined {
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorText(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const message = Reflect.get(input, "message");
    if (typeof message === "string") return message;
  }
  return String(input);
}

function readPathValue(env: Record<string, string | undefined>, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env.PATH;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === "path");
  return key ? env[key] : undefined;
}

function cursorExecutableNames(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [...CURSOR_EXECUTABLE_NAMES];
  const pathExt = env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
  const exts = pathExt
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const base of CURSOR_EXECUTABLE_NAMES) {
    for (const variant of [...exts.map((ext) => `${base}${ext.toLowerCase()}`), base]) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      names.push(variant);
    }
  }
  return names;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
