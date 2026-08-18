import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { AMP_INSTALL_COMMAND, runtimeProviderLoginCommand } from "@first-tree/shared";
import {
  automaticCandidateAllowed,
  getLoginShellPathDirs,
  wellKnownBinDirs,
} from "../../runtime/provider-support/index.js";

export { AMP_INSTALL_COMMAND };
export const AMP_LOGIN_COMMAND = runtimeProviderLoginCommand("amp");

export function formatAmpBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Amp CLI is missing on this machine. " +
    "First Tree does not bundle or install Amp and never reads its credentials. " +
    `Install it with \`${AMP_INSTALL_COMMAND}\`, then complete provider-owned setup with ` +
    `\`${AMP_LOGIN_COMMAND}\` and retry.` +
    suffix
  );
}

export function isAmpBinaryMissingError(input: unknown): boolean {
  const text = errorText(input);
  return /amp cli is missing|amp.*not (?:found|installed)|no amp binary/i.test(text);
}

export type FindAmpExecutableDeps = {
  loginShellPathDirs?: () => string[];
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/** Existence-only resolver shared by capability detection and the handler. */
export function findAmpExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindAmpExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const configuredHome = env.HOME || env.USERPROFILE;
  const home = configuredHome && configuredHome.length > 0 ? configuredHome : homedir();
  const wellKnownDirs = deps.wellKnownDirs ?? (() => wellKnownBinDirs(home));
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      if (seen.has(base)) continue;
      seen.add(base);
      for (const candidate of ampExecutableCandidates(base, platform)) {
        if (isExecutableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  };

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  const providerInstallDirs = [
    join(home, ".local", "bin"),
    join(home, ".amp", "bin"),
    ...(platform === "win32"
      ? [...(env.APPDATA ? [join(env.APPDATA, "npm")] : []), join(home, "AppData", "Roaming", "npm")]
      : []),
  ];
  return search(pathDirs) ?? search(providerInstallDirs) ?? search(wellKnownDirs()) ?? search(loginShellPathDirs());
}

export type AmpRuntimeBinaryResolution = { ok: true; binary: string } | { ok: false; error: string; transient: false };

export type AmpRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
};

/**
 * Resolve only. Every Amp invocation is launched later through the provider
 * process supervisor so Windows never executes an unadmitted runtime process.
 */
export function resolveAmpRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: AmpRuntimeResolveDeps = {},
): AmpRuntimeBinaryResolution {
  const findOnPath = deps.findOnPath ?? findAmpExecutableOnPath;
  const binary = findOnPath(env);
  if (!binary) {
    return {
      ok: false,
      error: formatAmpBinaryMissingMessage("no amp binary resolved"),
      transient: false,
    };
  }
  return { ok: true, binary };
}

function ampExecutableCandidates(base: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [join(base, "amp")];
  const candidates = [join(base, "amp.exe"), join(base, "node_modules", "@sourcegraph", "amp", "bin", "amp.exe")];
  if (basename(base).toLowerCase() === ".bin") {
    candidates.push(join(dirname(base), "@sourcegraph", "amp", "bin", "amp.exe"));
  }
  return candidates;
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
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
  if (input instanceof Error) return `${input.name} ${input.message}`;
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "message" in input) {
    const message = (input as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(input);
}
