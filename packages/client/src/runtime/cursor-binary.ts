import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { wellKnownBinDirs } from "./install-locations.js";
import { getLoginShellPathDirs } from "./login-shell-path.js";

/**
 * Cursor Agent CLI binary resolution. Cursor is EXTERNAL-ONLY: First Tree never
 * bundles the Cursor engine, never downloads it, and never reads Cursor IDE
 * internals — the runtime resolves the operator-installed CLI and spawns it
 * with `shell: false`. The official installer
 * (`curl https://cursor.com/install -fsS | bash`) links both `cursor-agent`
 * and the primary `agent` command at the same versioned binary; we prefer the
 * unambiguous `cursor-agent` name first and accept `agent` as the official
 * main-command fallback.
 */

/** Official install command surfaced in missing-binary copy and setup UI. */
export const CURSOR_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";

/**
 * `cursor-agent --version` smoke-check ceiling. Mirrors the codex bound: a cold
 * binary or a loaded machine can take seconds to respond, and a tight bound
 * would turn a present, working binary into a spurious failure.
 */
const CURSOR_VERSION_VERIFY_TIMEOUT_MS = 10_000;

/**
 * Spawn errnos that mean "the machine couldn't run the check right now", NOT
 * "the binary is broken/absent". These map to a transient verification failure
 * (→ retry), never to a missing-binary verdict.
 */
const TRANSIENT_SPAWN_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "EAGAIN", "ENOMEM", "ETXTBSY"]);

/**
 * Kill signals that mean "the binary crashed deterministically" — a broken /
 * incompatible install that will fault the same way on every retry. Any OTHER
 * signal (the timeout's SIGTERM/SIGKILL, an OOM kill) is a host condition and
 * stays transient.
 */
const DETERMINISTIC_CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set([
  "SIGSEGV",
  "SIGABRT",
  "SIGILL",
  "SIGBUS",
  "SIGFPE",
]);

export type CursorExecutableVerification =
  | { ok: true; output?: string }
  | { ok: false; reason: string; transient: boolean };

/**
 * A resolved cursor binary that EXISTS but whose `--version` smoke check did
 * not complete for a transient reason (timeout / host pressure). Carries a
 * distinct `name` the error taxonomy maps to `transient`, so a flaky check
 * reschedules bring-up instead of surfacing as a permanent missing-binary
 * terminal failure.
 */
export class CursorBinaryVerifyTransientError extends Error {
  constructor(reason: string) {
    super(
      `cursor-agent --version smoke check did not complete (transient host condition); will retry. Detail: ${reason}`,
    );
    this.name = "CursorBinaryVerifyTransientError";
  }
}

const CURSOR_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /cursor agent cli is missing/i,
  /cursor-agent.*not (?:found|installed)/i,
];

export function isCursorBinaryMissingError(input: unknown): boolean {
  const text = errorSearchText(input);
  return CURSOR_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

export function formatCursorBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Cursor Agent CLI is missing on this machine. " +
    "First Tree does not bundle or install the Cursor engine — it resolves the operator-installed `cursor-agent` (or `agent`) from PATH, well-known install directories, or the login-shell PATH. " +
    `Install it with the official installer (\`${CURSOR_INSTALL_COMMAND}\`), then sign in with \`cursor-agent login\` and re-run capability detection.` +
    suffix
  );
}

/** Injectable seams so probe tests stay hermetic (no real shell spawn / no host install dirs). */
export type FindCursorExecutableDeps = {
  /** Returns the user's interactive-login-shell PATH dirs; defaults to the memoized probe. */
  loginShellPathDirs?: () => string[];
  /** Returns the curated well-known bin dirs; defaults to the real host list. */
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/**
 * Resolve the Cursor Agent CLI the runtime would spawn. Existence-only — never
 * launches the binary; `verifyCursorExecutable` owns the spawn-time smoke check.
 *
 * Name order: `cursor-agent` first (unambiguous), then the official main
 * command `agent`. Both official symlinks point at the same versioned binary,
 * so when both exist the behavior is identical; preferring `cursor-agent`
 * avoids adopting an unrelated tool that happens to be called `agent` when a
 * real Cursor install is present.
 *
 * Directory order mirrors the other external providers — daemon PATH →
 * curated well-known install dirs (the official installer targets
 * `~/.local/bin`) → login-shell PATH (may spawn a shell, so consulted last).
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
  const names = cursorExecutableNames(platform);
  const seen = new Set<string>();

  const search = (dirs: readonly string[], name: string): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      const key = `${name}\0${base}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = join(base, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
    return null;
  };

  // Complete each NAME across every directory source before falling back to
  // the next name: a `cursor-agent` anywhere beats an `agent` anywhere, so a
  // machine with an unrelated `agent` early on PATH still resolves the real
  // Cursor CLI from `~/.local/bin`.
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  for (const name of names) {
    const found = search(pathDirs, name) ?? search(wellKnownDirs(), name) ?? search(loginShellPathDirs(), name);
    if (found) return found;
  }
  return null;
}

/**
 * Bounded `--version` smoke check run at first REAL use of the binary
 * (handler spawn / login) — never by the install-only capability probe.
 * Timeout / spawn-pressure outcomes are transient; a clean non-zero exit or a
 * deterministic crash signal is a genuine broken-binary verdict.
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
    const code = (result.error as NodeJS.ErrnoException).code;
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

export type CursorRuntimeBinaryResolution =
  | { ok: true; binary: string; version: string | null }
  | { ok: false; error: string; transient: boolean };

/** Injectable seams for `resolveCursorRuntimeBinary` (tests only). */
export type CursorRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  verifyPath?: (path: string, env?: Record<string, string | undefined>) => CursorExecutableVerification;
};

/**
 * Successful smoke-check verdicts, keyed by binary path. `verifyCursorExecutable`
 * is a BLOCKING spawnSync on the daemon main thread; without this cache every
 * session start/resume of every cursor agent would stall the event loop for
 * the `--version` round-trip. Only successes are cached — a transient flake
 * must stay retryable, and a broken binary should re-report its reason. A
 * binary that later disappears is caught by the spawn-time ENOENT path.
 */
const verifiedCursorBinaries = new Map<string, string | null>();

/**
 * Resolve + launch-verify the cursor binary the handler / login is about to
 * spawn. The capability probe does NOT use this (it is install-only); both
 * share `findCursorExecutableOnPath`, so the probe's existence verdict is a
 * strict subset of this resolution.
 */
export function resolveCursorRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: CursorRuntimeResolveDeps = {},
): CursorRuntimeBinaryResolution {
  const findOnPath = deps.findOnPath ?? findCursorExecutableOnPath;
  const verifyPath = deps.verifyPath ?? verifyCursorExecutable;

  const binary = findOnPath(env);
  if (!binary) {
    return {
      ok: false,
      error: formatCursorBinaryMissingMessage("no cursor-agent or agent binary resolved"),
      transient: false,
    };
  }
  if (verifiedCursorBinaries.has(binary)) {
    return { ok: true, binary, version: verifiedCursorBinaries.get(binary) ?? null };
  }
  const verification = verifyPath(binary, env);
  if (!verification.ok) {
    if (verification.transient) {
      // A present binary that only flaked its smoke check is NOT missing.
      return {
        ok: false,
        error: `cursor-agent resolved at ${binary} but \`--version\` did not complete (transient host condition): ${verification.reason}`,
        transient: true,
      };
    }
    return {
      ok: false,
      error: formatCursorBinaryMissingMessage(`resolved cursor-agent failed validation: ${verification.reason}`),
      transient: false,
    };
  }
  const match = (verification.output ?? "").match(/\d{4}\.\d{2}\.\d{2}[-\w]*|\d+\.\d+(?:\.\d+)?/);
  const version = match ? match[0] : null;
  verifiedCursorBinaries.set(binary, version);
  return { ok: true, binary, version };
}

function cursorExecutableNames(platform: NodeJS.Platform): string[] {
  const suffix = platform === "win32" ? ".exe" : "";
  return [`cursor-agent${suffix}`, `agent${suffix}`];
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
  if (input instanceof Error) return `${input.name} ${input.message}`;
  return errorText(input);
}
