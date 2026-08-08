import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  KIMI_NPM_PACKAGE,
  runtimeProviderInstallCommand,
  runtimeProviderInteractiveLoginCue,
} from "@first-tree/shared";
import { automaticCandidateAllowed, getLoginShellPathDirs, wellKnownBinDirs } from "./provider-support/index.js";

/**
 * Official Kimi Code CLI binary resolution for Computer capability detection.
 *
 * First Tree executes Kimi through the bundled `@botiverse/kimi-code-sdk`; the
 * official `kimi` CLI is the required local setup/recovery artifact so the
 * operator can run `/login` on this host. Discovery is existence-only — never
 * launches the binary and never reads credentials.
 */

/** Compatible re-export of the shared catalog npm package constant. */
export const KIMI_CLI_PACKAGE = KIMI_NPM_PACKAGE;

const KIMI_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /kimi (?:code )?cli is missing/i,
  /official `?kimi`? cli/i,
  /kimi.*not (?:found|installed)/i,
];

export function isKimiBinaryMissingError(input: unknown): boolean {
  const text = errorSearchText(input);
  return KIMI_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

export function formatKimiBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Official Kimi CLI is missing on this machine. " +
    "First Tree runs Kimi through its bundled SDK, but Computer availability requires the official `kimi` CLI so you can complete provider-owned login and recovery locally. " +
    `Install it with \`${runtimeProviderInstallCommand("kimi-code")}\`, then ${runtimeProviderInteractiveLoginCue("kimi-code")}.` +
    suffix
  );
}

/**
 * Official installer's default binary directory (`$HOME/.kimi-code/bin` /
 * `%USERPROFILE%\.kimi-code\bin`). The macOS/Linux `install.sh` and Windows
 * `install.ps1` scripts place `kimi` here and append the dir to the user's
 * shell PATH — which a long-lived daemon service PATH does not see until
 * restart, and which Windows never recovers via login-shell PATH probing.
 */
export function kimiOfficialBinDirs(home: string): string[] {
  return [join(home, ".kimi-code", "bin")];
}

/** Injectable seams so probe tests stay hermetic (no real shell spawn / no host install dirs). */
export type FindKimiExecutableDeps = {
  /** Returns the user's interactive-login-shell PATH dirs; defaults to the memoized probe. */
  loginShellPathDirs?: () => string[];
  /** Returns the curated well-known bin dirs; defaults to official + shared host list. */
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/**
 * Resolve the official `kimi` CLI on this host. Existence-only — never launches
 * the binary and never reads credential files under `~/.kimi-code`.
 *
 * Directory order: daemon PATH → curated well-known install dirs (official
 * `$HOME/.kimi-code/bin` first, then npm global / Homebrew / volta / …) →
 * login-shell PATH (may spawn a shell, so consulted last; always empty on
 * Windows). This covers the common case where launchd/systemd freezes a PATH
 * that omits the operator's interactive install location, including a fresh
 * official-script install that has not yet restarted the daemon.
 */
export function findKimiExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindKimiExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const home = resolveHome(env, platform);
  const wellKnownDirs = deps.wellKnownDirs ?? (() => [...kimiOfficialBinDirs(home), ...wellKnownBinDirs(home)]);
  const names = kimiExecutableNames(platform);
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      if (seen.has(base)) continue;
      seen.add(base);
      for (const name of names) {
        const candidate = join(base, name);
        if (isExecutableFile(candidate, platform)) return candidate;
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

function resolveHome(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (env.HOME && env.HOME.length > 0) return env.HOME;
  if (platform === "win32" && env.USERPROFILE && env.USERPROFILE.length > 0) return env.USERPROFILE;
  return homedir();
}

function kimiExecutableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["kimi.exe", "kimi.cmd", "kimi"] : ["kimi"];
}

function readPathValue(env: Record<string, string | undefined>, platform = process.platform): string | undefined {
  if (platform !== "win32") return env.PATH;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === "path");
  return key ? env[key] : undefined;
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

function errorSearchText(input: unknown): string {
  if (input instanceof Error) return `${input.name} ${input.message}`;
  return errorText(input);
}
