import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEEPSEEK_INSTALL_NPM_PACKAGE,
  runtimeProviderLoginCommand,
  runtimeProviderPreferredCredentialProse,
} from "@first-tree/shared";

export { DEEPSEEK_INSTALL_NPM_PACKAGE };
export const DEEPSEEK_LOGIN_COMMAND = runtimeProviderLoginCommand("deepseek-harness");

export const DEEPSEEK_CORDIS_ASSET_NAME = "deepseek-harness-cordis.yml";

export function formatDeepseekBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  const preferred =
    runtimeProviderPreferredCredentialProse("deepseek-harness") ??
    "set `DEEPSEEK_API_KEY` on the agent's Runtime → Environment variables and Mark as sensitive";
  return (
    "DeepSeek Harness runtime packages are missing from this First Tree Client. " +
    `After install, ${preferred} (or export it in the host shell). The portable CLI must ship the pinned \`@deepseek-ai/*\` ` +
    "closure (including Cordis plugins). Update or reinstall First Tree, or for a broken local install run " +
    `\`npm install ${DEEPSEEK_INSTALL_NPM_PACKAGE}\`.` +
    suffix
  );
}

export function isDeepseekBinaryMissingError(input: unknown): boolean {
  const text = errorText(input);
  return /deepseek harness runtime packages are missing|dsh-jsonrpc-agent.*not (?:found|installed)|no deepseek harness binary|cordis\.yml template missing/i.test(
    text,
  );
}

export type DeepseekRuntimeBinaryResolution =
  | { ok: true; binary: string; cordisPath: string; moduleBaseUrl: string }
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

/**
 * Resolve the closed-runtime JSON-RPC agent entry (`packaged-bin`) so Cordis
 * bare plugins resolve from the installed `@deepseek-ai/*` closure beside the
 * First Tree Client/CLI, not from the agent workspace.
 */
export function resolveBundledDeepseekJsonRpcAgent(): string {
  const requireFromModule = createRequire(import.meta.url);
  const packageJsonPath = locatePackageJson("@deepseek-ai/dsh-sdk-jsonrpc-demo");
  const packageDir = dirname(packageJsonPath);
  const packagedBin = join(packageDir, "lib", "packaged-bin.js");
  if (isExecutableFile(packagedBin, process.platform)) return packagedBin;

  try {
    return requireFromModule.resolve("@deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin");
  } catch {
    // Fall through to the generic bin (configuration-project plugin ownership).
  }

  const binFromPackage = join(packageDir, "lib", "bin.js");
  if (isExecutableFile(binFromPackage, process.platform)) return binFromPackage;
  return requireFromModule.resolve("@deepseek-ai/dsh-sdk-jsonrpc-demo/bin");
}

/** Package root that owns the installed `@deepseek-ai/*` closure (CLI or client). */
export function resolveDeepseekModuleBaseUrl(binaryPath: string): string {
  return pathToFileURL(binaryPath).href;
}

/**
 * Resolve First Tree–owned cordis from stable runtime-asset locations (and
 * source checkout for tests), matching agent-briefing asset discovery.
 */
export function resolveDeepseekCordisPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "cordis.yml"),
    join(here, "runtime-assets", DEEPSEEK_CORDIS_ASSET_NAME),
    join(here, "..", "runtime-assets", DEEPSEEK_CORDIS_ASSET_NAME),
    join(here, "..", "..", "runtime-assets", DEEPSEEK_CORDIS_ASSET_NAME),
  ];

  let dir = here;
  for (let depth = 0; depth < 10; depth += 1) {
    candidates.push(join(dir, "runtime-assets", DEEPSEEK_CORDIS_ASSET_NAME));
    candidates.push(join(dir, "dist", "runtime-assets", DEEPSEEK_CORDIS_ASSET_NAME));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  throw new Error(`DeepSeek cordis template is missing (expected ${DEEPSEEK_CORDIS_ASSET_NAME} under runtime-assets)`);
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
  const resolveJsonRpcAgent =
    deps.resolveJsonRpcAgent ??
    (() => {
      try {
        return resolveBundledDeepseekJsonRpcAgent();
      } catch {
        return findDeepseekJsonRpcAgentOnPath(env);
      }
    });
  const resolveCordisPath =
    deps.resolveCordisPath ??
    (() => {
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
  return { ok: true, binary, cordisPath, moduleBaseUrl: resolveDeepseekModuleBaseUrl(binary) };
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

/** Stable fingerprint of launch-affecting config (model + payload env). */
export function deepseekLaunchFingerprint(payload: {
  model: string;
  env: ReadonlyArray<{ key: string; value: string }>;
}): string {
  const envEntries = [...payload.env].map((entry) => `${entry.key}=${entry.value}`).sort((a, b) => a.localeCompare(b));
  return JSON.stringify({
    model: resolveDeepseekModel(payload.model),
    env: envEntries,
  });
}
