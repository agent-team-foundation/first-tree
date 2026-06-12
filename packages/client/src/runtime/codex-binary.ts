import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

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
  log?: (message: string) => void;
};

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
    "First Tree could not find the SDK-bundled @openai/codex binary or a `codex` executable on PATH. " +
    "Install or repair the local Codex CLI with `npm install -g @openai/codex`, then run `codex login` and retry." +
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

export function findCodexExecutableOnPath(env: Record<string, string | undefined> = process.env): string | null {
  const pathValue = readPathValue(env);
  if (!pathValue) return null;

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const base = isAbsolute(dir) ? dir : resolve(dir);
    for (const name of codexExecutableNames(env)) {
      const candidate = join(base, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
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
