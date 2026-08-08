import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { GROK_INSTALL_COMMAND, runtimeProviderLoginCommand } from "@first-tree/shared";
import { automaticCandidateAllowed, getLoginShellPathDirs, wellKnownBinDirs } from "./provider-support/index.js";

/**
 * Grok Build CLI binary resolution. Grok Build is EXTERNAL-ONLY: First Tree
 * never bundles the Grok engine, never downloads it, and never reads Grok
 * internals (`~/.grok/auth.json` included) — the runtime resolves the
 * operator-installed CLI and spawns it with `shell: false`. The official
 * installer (`curl -fsSL https://x.ai/cli/install.sh | bash`) drops the
 * binary at `~/.grok/bin/grok` and commonly links it into `~/.local/bin/grok`;
 * it is NOT an npm package, so no node_modules resolution is attempted.
 */

/** Official install command — shared catalog constant (compatible re-export). */
export { GROK_INSTALL_COMMAND };

/**
 * Supported Grok Build CLI range for this integration. Verified against
 * `grok 0.2.117 (f1c06093089f)`; a resolved binary outside the range is a
 * deterministic configuration failure, never a transient one.
 */
export const GROK_MIN_SUPPORTED_VERSION = "0.2.117";
export const GROK_MAX_EXCLUSIVE_VERSION = "0.3.0";

/**
 * `grok --version` smoke-check ceiling. Mirrors the cursor bound: a cold
 * binary or a loaded machine can take seconds to respond, and a tight bound
 * would turn a present, working binary into a spurious failure.
 */
const GROK_VERSION_VERIFY_TIMEOUT_MS = 10_000;

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

export type GrokExecutableVerification =
  | { ok: true; output?: string; version: string | null }
  | { ok: false; reason: string; transient: boolean };

/**
 * A resolved grok binary that EXISTS but whose `--version` smoke check did
 * not complete for a transient reason (timeout / host pressure). Carries a
 * distinct `name` the error taxonomy maps to `transient`, so a flaky check
 * reschedules bring-up instead of surfacing as a permanent missing-binary
 * terminal failure.
 */
export class GrokBinaryVerifyTransientError extends Error {
  constructor(reason: string) {
    super(`grok --version smoke check did not complete (transient host condition); will retry. Detail: ${reason}`);
    this.name = "GrokBinaryVerifyTransientError";
  }
}

/** Single-owner match rules live in provider-support; re-export for call sites. */
export { isGrokBinaryMissingError } from "./provider-support/index.js";

export function formatGrokBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Grok Build CLI is missing on this machine. " +
    "First Tree does not bundle or install the Grok engine — it resolves the operator-installed `grok` from PATH, well-known install directories, or the login-shell PATH. " +
    `Install it with the official installer (\`${GROK_INSTALL_COMMAND}\`), then sign in with \`${runtimeProviderLoginCommand("grok")}\` and re-run capability detection.` +
    suffix
  );
}

/** Injectable seams so probe tests stay hermetic (no real shell spawn / no host install dirs). */
export type FindGrokExecutableDeps = {
  /** Returns the user's interactive-login-shell PATH dirs; defaults to the memoized probe. */
  loginShellPathDirs?: () => string[];
  /** Returns the curated well-known bin dirs; defaults to the real host list. */
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/**
 * Resolve the Grok Build CLI the runtime would spawn. Existence-only — never
 * launches the binary; `verifyGrokExecutable` owns the spawn-time smoke check.
 *
 * Directory order mirrors the other external providers — daemon PATH →
 * curated well-known install dirs (the official installer targets
 * `~/.grok/bin` and commonly links into `~/.local/bin`) → login-shell PATH
 * (may spawn a shell, so consulted last).
 */
export function findGrokExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindGrokExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  const wellKnownDirs = deps.wellKnownDirs ?? (() => [join(home, ".grok", "bin"), ...wellKnownBinDirs(home)]);
  const name = grokExecutableName(platform);
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      if (seen.has(base)) continue;
      seen.add(base);
      const candidate = join(base, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
    return null;
  };

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  return search(pathDirs) ?? search(wellKnownDirs()) ?? search(loginShellPathDirs());
}

/**
 * Parse the semver out of `grok --version` output, e.g.
 * `grok 0.2.117 (f1c06093089f)` → `0.2.117`. Returns null when the output
 * does not carry the canonical `grok <semver>` token.
 */
export function parseGrokVersion(output: string): string | null {
  const match = output.match(/grok (\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

/** Compare two `x.y.z` versions: negative / zero / positive. */
function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `version` falls inside the supported `>=min <maxExclusive` range. */
export function isGrokVersionSupported(version: string): boolean {
  return (
    compareSemver(version, GROK_MIN_SUPPORTED_VERSION) >= 0 && compareSemver(version, GROK_MAX_EXCLUSIVE_VERSION) < 0
  );
}

/**
 * Bounded `--version` smoke check run at first REAL use of the binary
 * (handler spawn / login) — never by the install-only capability probe.
 * Timeout / spawn-pressure outcomes are transient; a clean non-zero exit, a
 * deterministic crash signal, an unparseable version, or a version outside
 * the supported range is a genuine broken / unsupported-binary verdict.
 */
export function verifyGrokExecutable(
  path: string,
  env: Record<string, string | undefined> = process.env,
): GrokExecutableVerification {
  const result = spawnSync(path, ["--version"], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
    shell: false,
    timeout: GROK_VERSION_VERIFY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const timedOut = code === "ETIMEDOUT";
    const transient = timedOut || (typeof code === "string" && TRANSIENT_SPAWN_CODES.has(code));
    return { ok: false, transient, reason: timedOut ? "`grok --version` timed out" : result.error.message };
  }
  if (result.signal) {
    const crashed = DETERMINISTIC_CRASH_SIGNALS.has(result.signal);
    return { ok: false, transient: !crashed, reason: `\`grok --version\` killed by ${result.signal}` };
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
      .join(" ")
      .trim();
    return {
      ok: false,
      transient: false,
      reason: `\`grok --version\` exited ${result.status}${detail ? `: ${detail}` : ""}`,
    };
  }
  const output = [result.stdout, result.stderr]
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
    .join(" ")
    .trim();
  const version = parseGrokVersion(output);
  if (!version) {
    return {
      ok: false,
      transient: false,
      reason: `\`grok --version\` did not report a parseable version (output: ${output.slice(0, 200)})`,
    };
  }
  if (!isGrokVersionSupported(version)) {
    return {
      ok: false,
      transient: false,
      reason:
        `grok ${version} is outside the supported range ` +
        `>=${GROK_MIN_SUPPORTED_VERSION} <${GROK_MAX_EXCLUSIVE_VERSION}; upgrade with \`${GROK_INSTALL_COMMAND}\``,
    };
  }
  return { ok: true, output, version };
}

export type GrokRuntimeBinaryResolution =
  | { ok: true; binary: string; version: string | null }
  | { ok: false; error: string; transient: boolean };

/** Injectable seams for `resolveGrokRuntimeBinary` (tests only). */
export type GrokRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  verifyPath?: (path: string, env?: Record<string, string | undefined>) => GrokExecutableVerification;
  /** Test-only platform override; production reads `process.platform`. */
  platform?: NodeJS.Platform;
};

/**
 * Successful smoke-check verdicts, keyed by binary path. `verifyGrokExecutable`
 * is a BLOCKING spawnSync on the daemon main thread; without this cache every
 * session start/resume of every grok agent would stall the event loop for
 * the `--version` round-trip. Only successes are cached — a transient flake
 * must stay retryable, and a broken binary should re-report its reason. A
 * binary that later disappears is caught by the spawn-time ENOENT path.
 */
const verifiedGrokBinaries = new Map<string, string | null>();

/**
 * Resolve + launch-verify the grok binary the handler / login is about to
 * spawn. The capability probe does NOT use this (it is install-only); both
 * share `findGrokExecutableOnPath`, so the probe's existence verdict is a
 * strict subset of this resolution.
 */
export function resolveGrokRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: GrokRuntimeResolveDeps = {},
): GrokRuntimeBinaryResolution {
  // Central fail-closed platform gate: EVERY spawn entry point (turn
  // transport, model discovery, runtime auth) resolves through here, so one
  // refusal covers them all. Short-circuits before any filesystem consult.
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    return {
      ok: false,
      error:
        "Grok Build provider is not supported on Windows in V1 (macOS/Linux only); " +
        "First Tree fails closed and will not resolve or spawn `grok` on this platform.",
      transient: false,
    };
  }
  const findOnPath = deps.findOnPath ?? findGrokExecutableOnPath;
  const verifyPath = deps.verifyPath ?? verifyGrokExecutable;

  const binary = findOnPath(env);
  if (!binary) {
    return {
      ok: false,
      error: formatGrokBinaryMissingMessage("no grok binary resolved"),
      transient: false,
    };
  }
  if (verifiedGrokBinaries.has(binary)) {
    return { ok: true, binary, version: verifiedGrokBinaries.get(binary) ?? null };
  }
  const verification = verifyPath(binary, env);
  if (!verification.ok) {
    if (verification.transient) {
      // A present binary that only flaked its smoke check is NOT missing.
      return {
        ok: false,
        error: `grok resolved at ${binary} but \`--version\` did not complete (transient host condition): ${verification.reason}`,
        transient: true,
      };
    }
    return {
      ok: false,
      // A resolved-but-UNSUPPORTED binary (out of range / failed verification)
      // is NOT "missing": the message must not match the missing-binary
      // patterns, and the retry policy maps it to the deterministic
      // `grok_binary_unsupported` capability stop.
      error:
        `Grok Build CLI at ${binary} is not a supported Grok Build version: ${verification.reason} ` +
        `(supported range >=${GROK_MIN_SUPPORTED_VERSION} <${GROK_MAX_EXCLUSIVE_VERSION}). ` +
        `Upgrade with the official installer (\`${GROK_INSTALL_COMMAND}\`).`,
      transient: false,
    };
  }
  verifiedGrokBinaries.set(binary, verification.version);
  return { ok: true, binary, version: verification.version };
}

function grokExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "grok.exe" : "grok";
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  // Every automatic source funnels through here, so this is the one place a
  // candidate can be vetted before `stat` / `access` follows it into a
  // TCC-protected folder. See `automaticCandidateAllowed`.
  if (!automaticCandidateAllowed(filePath)) return false;
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
