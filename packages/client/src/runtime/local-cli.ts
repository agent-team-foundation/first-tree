import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export type LocalCliAvailability = Readonly<{
  github: boolean;
  gitlab: boolean;
}>;

export type LocalCliProbeOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
  isExecutable?: (filePath: string, platform: NodeJS.Platform) => boolean;
}>;

/** Detect provider CLIs without launching them or checking authentication. */
export function detectLocalCliAvailability(options: LocalCliProbeOptions = {}): LocalCliAvailability {
  return {
    github: isExecutableOnPath("gh", options),
    gitlab: isExecutableOnPath("glab", options),
  };
}

/** Return true when a named executable is present on the supplied PATH. */
export function isExecutableOnPath(name: string, options: LocalCliProbeOptions = {}): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const pathSeparator = options.pathDelimiter ?? pathApi.delimiter;
  const rawPath = readEnvironmentValue(env, "PATH", platform);
  if (rawPath === undefined) return false;
  const pathExt = readEnvironmentValue(env, "PATHEXT", platform);
  const extensions = platform === "win32" ? windowsPathExtensions(pathExt) : [""];
  const isExecutable = options.isExecutable ?? isExecutableFile;

  for (const pathEntry of rawPath.split(pathSeparator)) {
    const directory = normalizePathEntry(pathEntry, platform);
    for (const extension of extensions) {
      if (isExecutable(pathApi.join(directory, `${name}${extension}`), platform)) return true;
    }
  }
  return false;
}

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const keys =
    platform === "win32"
      ? Object.keys(env).filter((candidate) => candidate.toLowerCase() === name.toLowerCase())
      : name === "PATH"
        ? ["PATH", "Path", "path"]
        : [name];
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizePathEntry(value: string, platform: NodeJS.Platform): string {
  if (value.length === 0) return ".";
  if (platform === "win32" && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
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

function windowsPathExtensions(value: string | undefined): string[] {
  const configured = value === undefined ? [".EXE", ".CMD", ".BAT", ".COM"] : value.split(";");
  const extensions: string[] = [];
  const seen = new Set<string>();
  for (const rawExtension of configured) {
    const trimmed = rawExtension.trim();
    if (!trimmed) continue;
    const extension = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    const normalized = extension.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    extensions.push(extension);
  }
  return [...extensions, ""];
}
