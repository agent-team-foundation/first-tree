import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import type { ContextIntegrationProject, ContextIntegrationProvider } from "@first-tree/shared";
import { loadCredentials } from "../bootstrap.js";
import { channelConfig } from "../channel.js";

const CODEX_PROJECTLESS_CLASSIFIER_VERSION = 1;
const SESSION_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;

export type ContextProjectResolution =
  | {
      kind: "path";
      project: Extract<ContextIntegrationProject, { kind: "path" }>;
      source: "claude_project_dir" | "codex_cwd_best_effort" | "explicit_path";
    }
  | {
      kind: "pathless";
      project: Extract<ContextIntegrationProject, { kind: "pathless" }>;
      source: "codex_documents_v1" | "explicit_pathless";
    }
  | {
      kind: "unknown";
      source: "claude_project_dir_missing" | "cwd_missing" | "path_unreadable";
      message: string;
    };

export type ContextSessionHookInput = {
  sessionId?: string;
  cwd?: string;
};

export type ContextSetupLocation = {
  project: ContextIntegrationProject;
  directory: string | null;
  directoryAvailable: boolean;
  temporaryDirectory: boolean;
  warning: string | null;
};

/**
 * Setup must show the real provider directory before the member chooses an
 * activation scope. In particular, Codex Documents scratch directories are
 * not collapsed to `pathless` at this boundary.
 */
export function inspectContextSetupLocation(
  provider: ContextIntegrationProvider,
  input: {
    cwd?: string;
    projectRoot?: string;
    pathless?: boolean;
    env?: NodeJS.ProcessEnv;
    classifierOptions?: Parameters<typeof classifyCodexProjectlessPath>[2];
  } = {},
): ContextSetupLocation {
  assertSignedIn();
  if (input.pathless) {
    return pathlessSetupLocation();
  }
  const env = input.env ?? process.env;
  const candidate =
    input.projectRoot ?? (provider === "claude-code" ? env.CLAUDE_PROJECT_DIR : (input.cwd ?? process.cwd()));
  if (!candidate) {
    return pathlessSetupLocation();
  }
  const projectResolution = resolvePathProject(
    candidate,
    input.projectRoot ? "explicit_path" : provider === "claude-code" ? "claude_project_dir" : "codex_cwd_best_effort",
  );
  if (projectResolution.kind === "unknown" && provider === "claude-code" && !input.projectRoot) {
    return pathlessSetupLocation();
  }
  const resolved = requireKnownProject(projectResolution);
  if (resolved.project.kind !== "path") {
    throw new ContextClientPreflightError(
      contextClientPreflightErrorCode.projectUnknown,
      "Setup location unexpectedly resolved without a directory.",
      "Pass an existing directory with --project-root.",
    );
  }
  const temporaryDirectory =
    provider === "codex" &&
    (classifyCodexProjectlessPath(resolved.project.root, env, input.classifierOptions) ||
      classifyCodexManagedWorktreePath(resolved.project.root, env, input.classifierOptions));
  return {
    project: resolved.project,
    directory: resolved.project.root,
    directoryAvailable: !temporaryDirectory,
    temporaryDirectory,
    warning: temporaryDirectory
      ? "This looks like a Codex temporary directory. Directory activation is unavailable because future sessions may use a different path."
      : null,
  };
}

function pathlessSetupLocation(): ContextSetupLocation {
  return {
    project: { kind: "pathless" },
    directory: null,
    directoryAvailable: false,
    temporaryDirectory: false,
    warning: "This provider session did not expose a usable directory. Directory activation is unavailable.",
  };
}

export const contextClientPreflightErrorCode = {
  notSignedIn: "not_signed_in",
  projectUnreadable: "project_unreadable",
  projectUnknown: "project_unknown",
} as const;

export type ContextClientPreflightErrorCode =
  (typeof contextClientPreflightErrorCode)[keyof typeof contextClientPreflightErrorCode];

export class ContextClientPreflightError extends Error {
  constructor(
    readonly code: ContextClientPreflightErrorCode,
    message: string,
    readonly nextAction: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContextClientPreflightError";
  }
}

export function inspectContextClientPreflight(
  provider: ContextIntegrationProvider,
  input: {
    cwd?: string;
    projectRoot?: string;
    pathless?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): ContextProjectResolution & { kind: "path" | "pathless" } {
  assertSignedIn();
  if (input.pathless === true && input.projectRoot) {
    throw new ContextClientPreflightError(
      contextClientPreflightErrorCode.projectUnknown,
      "`--pathless` and `--project-root` cannot be used together.",
      "Choose the pathless project or one attached project path.",
    );
  }
  if (input.pathless === true) {
    return { kind: "pathless", project: { kind: "pathless" }, source: "explicit_pathless" };
  }
  if (input.projectRoot) {
    return requireKnownProject(resolvePathProject(input.projectRoot, "explicit_path"));
  }
  return requireKnownProject(
    resolveProviderProject(provider, { cwd: input.cwd ?? process.cwd() }, input.env ?? process.env),
  );
}

export function resolveSessionContextProject(
  provider: ContextIntegrationProvider,
  input: ContextSessionHookInput,
  env: NodeJS.ProcessEnv = process.env,
  classifierOptions: Parameters<typeof resolveProviderProject>[3] = {},
): ContextProjectResolution {
  const sessionId = validSessionId(input.sessionId) ? input.sessionId : undefined;
  if (sessionId) {
    const cached = readCachedSessionProject(sessionId, env);
    if (cached) return cached;
  }
  const resolution = resolveProviderProject(provider, input, env, classifierOptions);
  if (sessionId && resolution.kind !== "unknown") writeCachedSessionProject(sessionId, resolution, env);
  return resolution;
}

export function resolveProviderProject(
  provider: ContextIntegrationProvider,
  input: Pick<ContextSessionHookInput, "cwd">,
  env: NodeJS.ProcessEnv = process.env,
  classifierOptions: {
    platform?: NodeJS.Platform;
    home?: string;
    realpath?: typeof realpathSync;
    stat?: typeof statSync;
  } = {},
): ContextProjectResolution {
  if (provider === "claude-code") {
    const projectRoot = env.CLAUDE_PROJECT_DIR;
    if (!projectRoot) {
      return {
        kind: "unknown",
        source: "claude_project_dir_missing",
        message: "Claude Code did not provide CLAUDE_PROJECT_DIR for this session.",
      };
    }
    return resolvePathProject(projectRoot, "claude_project_dir", classifierOptions);
  }
  if (!input.cwd) {
    return {
      kind: "unknown",
      source: "cwd_missing",
      message: "Codex did not provide a working directory for project classification.",
    };
  }
  const canonical = resolvePathProject(input.cwd, "codex_cwd_best_effort", classifierOptions);
  if (canonical.kind !== "path") return canonical;
  const pathless = classifyCodexProjectlessPath(canonical.project.root, env, classifierOptions);
  if (pathless) return { kind: "pathless", project: { kind: "pathless" }, source: "codex_documents_v1" };
  return canonical;
}

export function classifyCodexProjectlessPath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; home?: string; realpath?: typeof realpathSync } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE : homedir());
  const bases = new Set<string>();
  if (home) bases.add(pathApi.join(home, "Documents", "Codex"));
  if (platform === "win32") {
    for (const root of [env.OneDrive, env.OneDriveConsumer]) {
      if (root) bases.add(pathApi.join(root, "Documents", "Codex"));
    }
  }
  const normalizedCwd = normalizeForComparison(cwd, platform);
  const comparableBases = new Set(bases);
  for (const base of bases) {
    try {
      comparableBases.add((options.realpath ?? realpathSync)(base));
    } catch {
      // Synthetic platform tests and not-yet-created scratch roots still use
      // the logical candidate. Existing redirected roots add their canonical
      // target so cwd and base are compared in the same namespace.
    }
  }
  for (const base of comparableBases) {
    const relativePath = pathApi.relative(normalizeForComparison(base, platform), normalizedCwd);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relativePath)
    ) {
      continue;
    }
    const [date, slug] = relativePath.split(pathApi.sep);
    if (date && slug && validIsoDate(date)) return true;
  }
  return false;
}

export function classifyCodexManagedWorktreePath(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; home?: string; realpath?: typeof realpathSync } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const home = options.home ?? (platform === "win32" ? env.USERPROFILE : homedir());
  const codexHome = env.CODEX_HOME || (home ? pathApi.join(home, ".codex") : null);
  if (!codexHome) return false;

  const worktreesRoot = pathApi.join(codexHome, "worktrees");
  const comparableRoots = new Set([worktreesRoot]);
  try {
    comparableRoots.add((options.realpath ?? realpathSync)(worktreesRoot));
  } catch {
    // The logical root is sufficient for synthetic platform tests and for a
    // configured root that has not been created yet. Existing symlinked roots
    // add their canonical target so both paths use the same namespace.
  }

  const normalizedCwd = normalizeForComparison(cwd, platform);
  for (const root of comparableRoots) {
    const relativePath = pathApi.relative(normalizeForComparison(root, platform), normalizedCwd);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relativePath)
    ) {
      continue;
    }
    const [worktreeId, repository] = relativePath.split(pathApi.sep);
    if (worktreeId && repository) return true;
  }
  return false;
}

function assertSignedIn(): void {
  if (!loadCredentials()) {
    throw new ContextClientPreflightError(
      contextClientPreflightErrorCode.notSignedIn,
      "First Tree is not signed in.",
      `Run \`${channelConfig.binName} login <code>\`, then rerun this command.`,
    );
  }
}

function requireKnownProject(
  resolution: ContextProjectResolution,
): ContextProjectResolution & { kind: "path" | "pathless" } {
  if (resolution.kind !== "unknown") return resolution;
  const unreadable = resolution.source === "path_unreadable";
  throw new ContextClientPreflightError(
    unreadable ? contextClientPreflightErrorCode.projectUnreadable : contextClientPreflightErrorCode.projectUnknown,
    resolution.message,
    unreadable
      ? "Choose an existing readable project directory and rerun the command."
      : "Pass `--pathless` for a pathless session or `--project-root <path>` for an attached project.",
  );
}

function resolvePathProject(
  path: string,
  source: Extract<ContextProjectResolution, { kind: "path" }>["source"],
  dependencies: {
    realpath?: typeof realpathSync;
    stat?: typeof statSync;
  } = {},
): ContextProjectResolution {
  try {
    const root = (dependencies.realpath ?? realpathSync)(resolve(path));
    const stat = (dependencies.stat ?? statSync)(root);
    if (!stat.isDirectory()) throw new Error("project root is not a directory");
    return { kind: "path", project: { kind: "path", root }, source };
  } catch {
    return {
      kind: "unknown",
      source: "path_unreadable",
      message: `The project path is not readable: ${path}`,
    };
  }
}

function normalizeForComparison(path: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalized = pathApi.normalize(path);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(value);
}

type CachedSessionProject = {
  schemaVersion: 1;
  classifierVersion: number;
  updatedAt: string;
  resolution: Extract<ContextProjectResolution, { kind: "path" | "pathless" }>;
};

function sessionCachePath(sessionId: string, env: NodeJS.ProcessEnv): string | null {
  const pluginData = env.PLUGIN_DATA ?? env.CLAUDE_PLUGIN_DATA;
  return pluginData ? join(pluginData, "context-sessions", `${sessionId}.json`) : null;
}

function readCachedSessionProject(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): CachedSessionProject["resolution"] | null {
  const path = sessionCachePath(sessionId, env);
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedSessionProject>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.classifierVersion !== CODEX_PROJECTLESS_CLASSIFIER_VERSION ||
      typeof parsed.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      Date.now() - Date.parse(parsed.updatedAt) > SESSION_CACHE_TTL_MS ||
      !validCachedResolution(parsed.resolution)
    ) {
      return null;
    }
    return parsed.resolution;
  } catch {
    return null;
  }
}

function writeCachedSessionProject(
  sessionId: string,
  resolution: CachedSessionProject["resolution"],
  env: NodeJS.ProcessEnv,
): void {
  const path = sessionCachePath(sessionId, env);
  if (!path) return;
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const value: CachedSessionProject = {
      schemaVersion: 1,
      classifierVersion: CODEX_PROJECTLESS_CLASSIFIER_VERSION,
      updatedAt: new Date().toISOString(),
      resolution,
    };
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function validCachedResolution(value: unknown): value is CachedSessionProject["resolution"] {
  if (typeof value !== "object" || value === null) return false;
  const kind = Reflect.get(value, "kind");
  const project = Reflect.get(value, "project");
  const source = Reflect.get(value, "source");
  if (kind === "pathless") {
    return (
      typeof project === "object" &&
      project !== null &&
      Reflect.get(project, "kind") === "pathless" &&
      (source === "codex_documents_v1" || source === "explicit_pathless")
    );
  }
  return (
    kind === "path" &&
    typeof project === "object" &&
    project !== null &&
    Reflect.get(project, "kind") === "path" &&
    typeof Reflect.get(project, "root") === "string" &&
    ["claude_project_dir", "codex_cwd_best_effort", "explicit_path"].includes(String(source))
  );
}

function validSessionId(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._-]+$/u.test(value);
}
