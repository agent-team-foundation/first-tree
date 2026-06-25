import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@first-tree/shared";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "../../handlers/claude-executable.js";
import {
  type ClaudeProviderFailure,
  claudeFailureFromAssistantMessage,
  claudeFailureFromSdkResult,
} from "../../handlers/claude-provider-error.js";
import { classifyProviderFailure } from "../provider-retry-policy.js";
import { detectClaudeAuth } from "./claude-shared.js";
import {
  type AuthPrecheckOutcome,
  commandFailureDigest,
  type ResolveOutcome,
  runCommand,
  runLaunchProbe,
  type SmokeOutcome,
  truncateError,
  verifyLaunchable,
} from "./launch-probe.js";

/** Whole-probe smoke budget. A healthy 1-turn haiku reply takes ~5s. */
export const CLAUDE_SMOKE_TIMEOUT_MS = 60_000;

/** Prompt for the 1-turn smoke — cheapest possible real session. */
export const CLAUDE_SMOKE_PROMPT = "Reply with exactly: OK";

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

/** How the SDK's bundled Claude CLI is launched on this host. */
export type BundledClaudeBinary =
  /** Legacy layout (older SDKs): `node <sdk-dir>/cli.js`. */
  | { kind: "cli-js"; path: string }
  /** Modern layout (SDK 0.2.x+): spawn the per-platform native binary directly. */
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
 *     `@anthropic-ai/claude-agent-sdk-<platform>` package, spawned directly.
 * Throws when neither resolves — exactly when the SDK itself would throw
 * "Native CLI binary for <platform>-<arch> not found".
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
    `no installed Claude native binary for ${target} (checked ${candidates.join(", ")}); is @anthropic-ai/claude-agent-sdk installed with its optional per-platform dependency?`,
  );
}

/**
 * Launch-verify the SDK's bundled Claude CLI via `<artifact> --version`.
 *
 * This is the resolve-stage proof for the no-on-disk-binary path: when no
 * real `claude` resolves, the runtime spawns this bundled artifact, so a
 * missing/broken bundle must resolve to `missing` HERE — before the auth
 * precheck can short-circuit to `unauthenticated`/`available: true` (the
 * bind-gate false positive this probe exists to remove). `--version` is
 * fast (~0.25s), needs no credentials, and yields the real Claude CLI
 * version (e.g. `2.1.84`), which is more useful than the SDK package version.
 */
export async function verifyBundledClaudeArtifact(): Promise<
  { ok: true; version: string | null } | { ok: false; error: string }
> {
  let bundled: BundledClaudeBinary;
  try {
    bundled = resolveBundledClaudeBinary();
  } catch (err) {
    return {
      ok: false,
      error:
        "Claude runtime binary is missing on this machine. First Tree does not bundle the native Claude engine by default — it resolves a system `claude` (env override / PATH / well-known install dirs). " +
        "Install it with the daemon's one-click `daemon install-claude` (or `npm install -g @anthropic-ai/claude-code`), then run `claude /login` and retry. " +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const [command, args, label] =
    bundled.kind === "cli-js"
      ? [process.execPath, [bundled.path, "--version"], "`node cli.js --version`"]
      : [bundled.path, ["--version"], "`claude --version`"];
  const res = await runCommand(command, args, { timeoutMs: 10_000 });
  if (!res.ok) return { ok: false, error: commandFailureDigest(label, res) };
  const match = res.stdout.match(/\d+\.\d+(?:\.\d+)?/);
  return { ok: true, version: match ? match[0] : null };
}

/**
 * Classify a failure message from the SDK smoke into a probe state.
 *
 * Auth signatures verified on a real machine: `claude -p` with an invalid
 * ANTHROPIC_API_KEY exits 1 and prints "Invalid API key · Please run /login"
 * on STDOUT; the SDK forwards equivalent text (or the typed
 * `authentication_failed` code) through its result/error surface. The
 * missing-binary signature is the SDK's own "Native CLI binary for
 * <platform>-<arch> not found" throw when the optional per-platform dep is
 * absent.
 */
export function classifyClaudeSmokeFailure(message: string): SmokeOutcome {
  const text = message.trim();
  if (/invalid api key|please run \/login|authentication_failed|not logged in|oauth.*(expired|revoked)/i.test(text)) {
    return { state: "unauthenticated", error: text };
  }
  if (/native cli binary.*not found|ENOENT/i.test(text)) {
    return { state: "missing", error: text };
  }
  return { state: "error", error: text.length > 0 ? text : "smoke failed without output" };
}

export function classifyClaudeSmokeProviderFailure(failure: ClaudeProviderFailure): SmokeOutcome {
  const classification = classifyProviderFailure(failure.signal.error, {
    provider: "claude-code",
    scope: "session_start",
    source: "sdk",
  });
  if (classification.category === "credential") {
    return { state: "unauthenticated", error: failure.messagePreview };
  }
  return {
    state: "error",
    error: failure.messagePreview.trim().length > 0 ? failure.messagePreview : "smoke failed without output",
  };
}

/**
 * Real launch smoke through the exact code path the runtime uses: the SDK's
 * `query()` (which spawns the resolved binary, or its bundled native binary
 * when none resolved). A successful 1-turn reply is the only way this probe
 * reports `ok` — exactly the "session would actually work" claim the web UI
 * makes when it shows a green check.
 */
export async function defaultClaudeSdkSmoke(binary: string | undefined): Promise<SmokeOutcome> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_SMOKE_TIMEOUT_MS);
  try {
    const q = sdk.query({
      prompt: CLAUDE_SMOKE_PROMPT,
      options: {
        model: "haiku",
        maxTurns: 1,
        abortController: controller,
        // Match the real handler's launch contract: `createClaudeCodeHandler`
        // runs the SDK with `settingSources: ["user", "project"]`, so the smoke
        // must load the same settings sources — otherwise a machine whose
        // Claude runtime depends on `~/.claude/settings.json` (provider
        // endpoint / proxy / model alias / hooks / plugins) would be probed
        // under a different config than it actually runs with.
        settingSources: ["user", "project"],
        // Neutral cwd: the daemon's cwd may be anywhere; the smoke must not
        // pick up a repo's .claude/ project settings or spawn in a deleted dir
        // (a tmp dir has no `project` settings, so this stays equivalent to the
        // handler's source contract without inheriting an arbitrary repo).
        cwd: tmpdir(),
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      },
    });
    let pendingAssistantProviderFailure: ClaudeProviderFailure | null = null;
    for await (const message of q) {
      const assistantFailure = claudeFailureFromAssistantMessage(message);
      if (assistantFailure) pendingAssistantProviderFailure = assistantFailure;
      if (message.type !== "result") continue;
      const providerFailure = claudeFailureFromSdkResult(message) ?? pendingAssistantProviderFailure;
      pendingAssistantProviderFailure = null;
      if (providerFailure) return classifyClaudeSmokeProviderFailure(providerFailure);
      if (message.subtype === "success" && !message.is_error) {
        return { state: "ok" };
      }
    }
    return { state: "error", error: "SDK smoke ended without a result message" };
  } catch (err) {
    if (controller.signal.aborted) {
      return { state: "error", error: `SDK smoke timed out after ${CLAUDE_SMOKE_TIMEOUT_MS}ms` };
    }
    return classifyClaudeSmokeFailure(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Injectable seams so unit tests stay hermetic (no real spawn, no network,
 * no token spend). Production callers pass nothing.
 */
export type ClaudeCodeProbeDeps = {
  importSdk?: () => Promise<unknown>;
  resolveExecutable?: (opts?: { env?: NodeJS.ProcessEnv }) => ClaudeExecutableResolution;
  verifyBinary?: (binary: string) => Promise<{ ok: true; version: string | null } | { ok: false; error: string }>;
  verifyBundledArtifact?: () => Promise<{ ok: true; version: string | null } | { ok: false; error: string }>;
  detectAuth?: () => { authenticated: boolean; method: "api_key" | "oauth" | "none" };
  runSmoke?: (binary: string | undefined) => Promise<SmokeOutcome>;
};

/**
 * Launch-verified probe for the `claude-code` (SDK) runtime.
 *
 * Stage map:
 *   1. resolve — the SDK package must import, AND the artifact the runtime
 *      would spawn must pass a real `--version` launch: a resolved on-disk
 *      `claude` (env override / PATH / well-known dirs), or — when none
 *      resolves — the SDK's bundled Claude binary (`<artifact> --version`,
 *      where the artifact is a legacy `cli.js` or a modern per-platform native
 *      binary). A missing/broken bundle fails HERE (`missing`), so it can no
 *      longer be masked by a failing auth precheck downstream.
 *   2. auth precheck — the marker-file/env heuristic is only a NEGATIVE gate:
 *      no credentials → `unauthenticated` without spending a smoke. It no
 *      longer has the authority to declare the machine authenticated.
 *   3. smoke — 1-turn haiku query through the SDK; the only path to `ok`.
 *
 * `sdkVersion` carries the launch-verified CLI's real version (the resolved
 * binary's, or the bundled artifact's).
 */
export async function probeClaudeCodeCapability(deps: ClaudeCodeProbeDeps = {}): Promise<CapabilityEntry> {
  const importSdk = deps.importSdk ?? (() => import("@anthropic-ai/claude-agent-sdk"));
  const resolveExecutable = deps.resolveExecutable ?? resolveClaudeCodeExecutable;
  const verifyBinary = deps.verifyBinary ?? ((binary: string) => verifyLaunchable("claude", binary));
  const verifyBundledArtifact = deps.verifyBundledArtifact ?? verifyBundledClaudeArtifact;
  const detectAuth = deps.detectAuth ?? detectClaudeAuth;
  const runSmoke = deps.runSmoke ?? defaultClaudeSdkSmoke;

  let resolvedBinary: string | undefined;

  return runLaunchProbe({
    resolve: async (): Promise<ResolveOutcome> => {
      try {
        await importSdk();
      } catch (err) {
        return {
          ok: false,
          error: `@anthropic-ai/claude-agent-sdk failed to load: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const resolution = resolveExecutable();
      if (resolution.source !== "default" && resolution.path) {
        const verified = await verifyBinary(resolution.path);
        if (!verified.ok) return { ok: false, error: verified.error };
        resolvedBinary = resolution.path;
        return { ok: true, binary: resolution.path, version: verified.version };
      }
      // No on-disk binary — the SDK will spawn its bundled Claude binary
      // (legacy cli.js, or a modern per-platform native binary). Launch-verify
      // that artifact now so a missing/broken bundle resolves to `missing`
      // regardless of auth state (the smoke still exercises the full path, but
      // it only runs after a passing auth precheck).
      const verified = await verifyBundledArtifact();
      if (!verified.ok) return { ok: false, error: verified.error };
      return { ok: true, version: verified.version };
    },
    authPrecheck: async (): Promise<AuthPrecheckOutcome> => {
      const auth = detectAuth();
      if (!auth.authenticated) {
        return {
          ok: false,
          error:
            "no Claude credentials found (ANTHROPIC_API_KEY unset and ~/.claude.json has no OAuth account); run `claude auth login` on this machine",
        };
      }
      return { ok: true, method: auth.method };
    },
    smoke: async (): Promise<SmokeOutcome> => {
      const outcome = await runSmoke(resolvedBinary);
      if (outcome.error) return { ...outcome, error: truncateError(outcome.error) };
      return outcome;
    },
  });
}
