import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@first-tree/shared";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "../../handlers/claude-executable.js";
import { type DetectOutcome, runDetect } from "./detect.js";

/**
 * Per-platform native package the SDK ships its bundled `claude` binary in,
 * keyed by `<process.platform>-<process.arch>`. Linux lists both the glibc and
 * the musl variant: only the one matching the host's libc is installed (npm
 * gates on the package's `libc` field), so we try both and use whichever
 * actually resolved. Mirrors `@anthropic-ai/claude-agent-sdk`'s own
 * `optionalDependencies`.
 */
const CLAUDE_PLATFORM_PACKAGES: Record<string, readonly string[]> = {
  "darwin-x64": ["@anthropic-ai/claude-agent-sdk-darwin-x64"],
  "darwin-arm64": ["@anthropic-ai/claude-agent-sdk-darwin-arm64"],
  "linux-x64": ["@anthropic-ai/claude-agent-sdk-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64-musl"],
  "linux-arm64": ["@anthropic-ai/claude-agent-sdk-linux-arm64", "@anthropic-ai/claude-agent-sdk-linux-arm64-musl"],
  "win32-x64": ["@anthropic-ai/claude-agent-sdk-win32-x64"],
  "win32-arm64": ["@anthropic-ai/claude-agent-sdk-win32-arm64"],
};

/**
 * Locate the `@anthropic-ai/claude-agent-sdk` package directory. Vite SSR
 * (vitest) strips `import.meta.resolve`, so when it is unavailable we walk
 * parent `node_modules` to the package (realpath'd so pnpm symlinks resolve
 * exactly like Node's own resolution would) — mirrors codex's anchor.
 */
function locateSdkDir(): string {
  if (typeof import.meta.resolve === "function") {
    return dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")));
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("@anthropic-ai/claude-agent-sdk not found in any parent node_modules");
}

/** How the SDK's bundled Claude CLI is laid out on this host. */
export type BundledClaudeBinary =
  /** Legacy layout (older SDKs): `node <sdk-dir>/cli.js`. */
  | { kind: "cli-js"; path: string }
  /** Modern layout (SDK 0.2.x+): the per-platform native binary. */
  | { kind: "native"; path: string };

/** Injectable seams for {@link resolveBundledClaudeBinary} (tests only). */
export type ResolveBundledClaudeDeps = {
  /** Locate the `@anthropic-ai/claude-agent-sdk` package directory. */
  locateSdkDir?: () => string;
  /** Resolve a platform package's install root by name, or null when not installed. */
  resolvePlatformPackageRoot?: (pkg: string) => string | null;
};

/** Default platform-package resolver: the SDK's own `require`, null when a variant is absent. */
function platformPackageRootResolver(sdkDir: string): (pkg: string) => string | null {
  const sdkRequire = createRequire(join(sdkDir, "package.json"));
  return (pkg) => {
    try {
      return dirname(sdkRequire.resolve(`${pkg}/package.json`));
    } catch {
      // Optional platform package not installed for this libc variant.
      return null;
    }
  };
}

/**
 * Resolve the bundled Claude CLI the SDK would spawn when `query()` is given no
 * `pathToClaudeCodeExecutable`. Two layouts are supported because the SDK
 * changed how it ships the CLI:
 *   - legacy: a `cli.js` inside the SDK package, run via `node cli.js`.
 *   - modern (0.2.x+): a per-platform native binary (`claude`) in an optional
 *     `@anthropic-ai/claude-agent-sdk-<platform>` package.
 * Throws when neither resolves — exactly when the SDK itself would throw
 * "Native CLI binary for <platform>-<arch> not found". Existence-only: this
 * never launches the artifact (install detection, not usability).
 *
 * Since the native engine is externalized by default (it is pruned on a global
 * install, mirroring codex), this bundle is usually absent — detection then
 * relies on a system `claude` resolved by `resolveClaudeCodeExecutable`.
 */
export function resolveBundledClaudeBinary(deps: ResolveBundledClaudeDeps = {}): BundledClaudeBinary {
  const sdkDir = (deps.locateSdkDir ?? locateSdkDir)();
  // Legacy layout first — preserves behaviour for SDK builds that still ship cli.js.
  const cliJs = join(sdkDir, "cli.js");
  if (existsSync(cliJs)) return { kind: "cli-js", path: realpathSync(cliJs) };

  const target = `${process.platform}-${process.arch}`;
  const candidates = CLAUDE_PLATFORM_PACKAGES[target] ?? [];
  if (candidates.length === 0) {
    throw new Error(`no bundled Claude binary for ${target} (no cli.js and no known platform package)`);
  }
  const resolvePlatformPackageRoot = deps.resolvePlatformPackageRoot ?? platformPackageRootResolver(sdkDir);
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  for (const pkg of candidates) {
    const pkgRoot = resolvePlatformPackageRoot(pkg);
    if (!pkgRoot) continue;
    const binary = join(pkgRoot, binaryName);
    if (existsSync(binary)) return { kind: "native", path: realpathSync(binary) };
  }
  throw new Error(
    `no installed Claude native binary for ${target} (checked ${candidates.join(", ")}); the native engine is external by default — install a system claude`,
  );
}

/**
 * Remediation message shown when no `claude` resolves and the SDK-bundled
 * native binary is also absent (the externalized-engine `missing` case). The
 * login command MUST stay `claude auth login` — the repo-canonical command the
 * runtime-auth orchestrator actually runs and every other user-facing hint
 * names (see `runClaudeBrowserLogin` and the runtime-auth messages) — so a user
 * who installs the engine then logs in follows one consistent command.
 */
export function formatClaudeBinaryMissingMessage(originalError: string): string {
  return (
    "Claude runtime binary is missing on this machine. First Tree does not bundle the native Claude engine by default — it resolves a system `claude` (env override / PATH / well-known install dirs). " +
    "Install it with the daemon's one-click `daemon install-claude` (or `npm install -g @anthropic-ai/claude-code`), then run `claude auth login` and retry. " +
    `Original error: ${originalError}`
  );
}

/**
 * Injectable seams so unit tests stay hermetic (no real filesystem / PATH).
 * Production callers pass nothing.
 */
export type ClaudeCodeProbeDeps = {
  resolveExecutable?: (opts?: { env?: NodeJS.ProcessEnv }) => ClaudeExecutableResolution;
  resolveBundled?: () => BundledClaudeBinary;
  exists?: (path: string) => boolean;
};

/**
 * Install-only probe for the `claude-code` (SDK) runtime.
 *
 * Installed when the artifact the runtime would actually spawn exists on disk:
 *   1. a resolved on-disk `claude` (env override / PATH / well-known dirs), OR
 *   2. when none resolves, the SDK's bundled Claude binary (legacy `cli.js` or
 *      a modern per-platform native binary) — usually absent now that the
 *      native engine is externalized by default.
 * Otherwise `missing`. No `--version` launch, no auth check, no smoke — those
 * are exactly the usability/credential checks this rewrite removed.
 */
export async function probeClaudeCodeCapability(deps: ClaudeCodeProbeDeps = {}): Promise<CapabilityEntry> {
  const resolveExecutable = deps.resolveExecutable ?? resolveClaudeCodeExecutable;
  const resolveBundled = deps.resolveBundled ?? resolveBundledClaudeBinary;
  const exists = deps.exists ?? existsSync;

  return runDetect(async (): Promise<DetectOutcome> => {
    const resolution = resolveExecutable();
    // A real on-disk `claude` resolved (env / PATH / well-known dir).
    if (resolution.source !== "default" && resolution.path && exists(resolution.path)) {
      return { installed: true, runtimeSource: "path", runtimePath: resolution.path };
    }
    // A set-but-unusable CLAUDE_CODE_EXECUTABLE only surfaces here, when nothing
    // resolved — prepend it so the operator sees the precise cause, not just the
    // generic "no claude found" text.
    const overridePrefix = resolution.overrideError ? `${resolution.overrideError}. ` : "";
    // No on-disk binary — the SDK would spawn its bundled Claude binary (absent
    // by default since the native engine is externalized).
    try {
      const bundled = resolveBundled();
      if (exists(bundled.path)) return { installed: true, runtimeSource: "bundled", runtimePath: null };
      return {
        installed: false,
        error:
          overridePrefix +
          formatClaudeBinaryMissingMessage(
            `the SDK-bundled Claude binary is declared at ${bundled.path} but does not exist`,
          ),
      };
    } catch (err) {
      return {
        installed: false,
        error: overridePrefix + formatClaudeBinaryMissingMessage(err instanceof Error ? err.message : String(err)),
      };
    }
  });
}
