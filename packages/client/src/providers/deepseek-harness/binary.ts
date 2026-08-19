import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEEPSEEK_INSTALL_NPM_PACKAGE,
  runtimeProviderLoginCommand,
} from "@first-tree/shared";

export { DEEPSEEK_INSTALL_NPM_PACKAGE };
export const DEEPSEEK_LOGIN_COMMAND = runtimeProviderLoginCommand("deepseek-harness");

export function formatDeepseekBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "DeepSeek Harness runtime packages are missing on this machine. " +
    "First Tree bundles the JSON-RPC runtime via npm; install the pinned packages with " +
    `\`npm install ${DEEPSEEK_INSTALL_NPM_PACKAGE}\`, set \`DEEPSEEK_API_KEY\`, and retry.` +
    suffix
  );
}

export function isDeepseekBinaryMissingError(input: unknown): boolean {
  const text = errorText(input);
  return /deepseek harness runtime packages are missing|dsh-jsonrpc-agent.*not (?:found|installed)|no deepseek harness binary/i.test(
    text,
  );
}

export type DeepseekRuntimeBinaryResolution =
  | { ok: true; binary: string; cordisPath: string }
  | { ok: false; error: string; transient: false };

export type DeepseekRuntimeResolveDeps = {
  resolveJsonRpcAgent?: (env?: NodeJS.ProcessEnv) => string | null;
  resolveCordisPath?: () => string | null;
};

function locatePackageJson(packageName: string): string {
  if (typeof import.meta.resolve === "function") {
    return fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, "node_modules", ...packageName.split("/"), "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${packageName} was not found in any parent node_modules`);
}

/** Resolve the bundled `dsh-jsonrpc-agent` entry from First Tree's npm dependency graph. */
export function resolveBundledDeepseekJsonRpcAgent(): string {
  const requireFromModule = createRequire(import.meta.url);
  const packageJsonPath = locatePackageJson("@deepseek-ai/dsh-sdk-jsonrpc-demo");
  const packageDir = dirname(packageJsonPath);
  const binFromPackage = join(packageDir, "lib", "bin.js");
  if (isExecutableFile(binFromPackage, process.platform)) return binFromPackage;

  const binLink = join(dirname(packageDir), ".bin", "dsh-jsonrpc-agent");
  if (existsSync(binLink)) {
    try {
      const target = realpathSync(binLink);
      if (isExecutableFile(target, process.platform)) return target;
    } catch {
      // Fall through to require.resolve below.
    }
  }

  return requireFromModule.resolve("@deepseek-ai/dsh-sdk-jsonrpc-demo/bin");
}

/** Resolve the First Tree–owned cordis template shipped beside this provider module. */
export function resolveDeepseekCordisPath(): string {
  const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "cordis.yml");
  if (existsSync(sourcePath) && statSync(sourcePath).isFile()) return sourcePath;

  const distPath = join(dirname(fileURLToPath(import.meta.url)), "cordis.yml");
  if (existsSync(distPath) && statSync(distPath).isFile()) return distPath;

  throw new Error("DeepSeek cordis.yml template is missing beside the provider module");
}

function findDeepseekJsonRpcAgentOnPath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const names =
    platform === "win32"
      ? ["dsh-jsonrpc-agent.exe", "dsh-jsonrpc-agent.cmd", "dsh-jsonrpc-agent"]
      : ["dsh-jsonrpc-agent"];
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

export function resolveDeepseekRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: DeepseekRuntimeResolveDeps = {},
): DeepseekRuntimeBinaryResolution {
  const resolveJsonRpcAgent = deps.resolveJsonRpcAgent ?? (() => {
    try {
      return resolveBundledDeepseekJsonRpcAgent();
    } catch {
      return findDeepseekJsonRpcAgentOnPath(env);
    }
  });
  const resolveCordisPath = deps.resolveCordisPath ?? (() => {
    try {
      return resolveDeepseekCordisPath();
    } catch {
      return null;
    }
  });

  const binary = resolveJsonRpcAgent(env);
  const cordisPath = resolveCordisPath();
  if (!binary) {
    return {
      ok: false,
      error: formatDeepseekBinaryMissingMessage("no dsh-jsonrpc-agent resolved"),
      transient: false,
    };
  }
  if (!cordisPath) {
    return {
      ok: false,
      error: formatDeepseekBinaryMissingMessage("cordis.yml template missing"),
      transient: false,
    };
  }
  return { ok: true, binary, cordisPath };
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
  if (input instanceof Error) return `${input.name} ${input.message}`;
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "message" in input) {
    const message = (input as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(input);
}

/** Default model when operator config leaves `model` empty. */
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash";

export function resolveDeepseekModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : DEEPSEEK_DEFAULT_MODEL;
}

export function deepseekSessionRoot(workspaceCwd: string): string {
  return isAbsolute(join(workspaceCwd, ".first-tree", "deepseek-harness-sessions"))
    ? join(workspaceCwd, ".first-tree", "deepseek-harness-sessions")
    : resolve(workspaceCwd, ".first-tree", "deepseek-harness-sessions");
}
