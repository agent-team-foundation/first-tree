import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@first-tree/shared";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "../../handlers/claude-executable.js";
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
 * Locate the SDK's bundled `cli.js` — the exact artifact the SDK spawns
 * (`node <sdk-dir>/cli.js`) when `query()` is given no
 * `pathToClaudeCodeExecutable`. Vite SSR (vitest) strips
 * `import.meta.resolve`, so when it is unavailable we walk parent
 * `node_modules` to the same package (realpath'd so pnpm symlinks resolve
 * exactly like Node's own resolution would) — mirrors codex's anchor.
 */
function locateSdkCliJs(): string {
  if (typeof import.meta.resolve === "function") {
    return join(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))), "cli.js");
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("not found in any parent node_modules");
}

/**
 * Launch-verify the SDK's bundled `cli.js` via `node <cli.js> --version`.
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
  let cliJs: string;
  try {
    cliJs = locateSdkCliJs();
  } catch (err) {
    return {
      ok: false,
      error: `@anthropic-ai/claude-agent-sdk bundled cli.js could not be located: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!existsSync(cliJs)) return { ok: false, error: `SDK bundled cli.js missing at ${cliJs}` };
  const res = await runCommand(process.execPath, [cliJs, "--version"], { timeoutMs: 10_000 });
  if (!res.ok) return { ok: false, error: commandFailureDigest("`node cli.js --version`", res) };
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
    for await (const message of q) {
      if (message.type !== "result") continue;
      if (message.subtype === "success" && !message.is_error) {
        return { state: "ok" };
      }
      if (message.subtype === "success") {
        // is_error=true: the CLI forwarded an API error string as the result.
        return classifyClaudeSmokeFailure(message.result);
      }
      const detail = message.errors.length > 0 ? message.errors.join("; ") : message.subtype;
      return classifyClaudeSmokeFailure(detail);
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
 *      resolves — the SDK's bundled `cli.js` (`node cli.js --version`). A
 *      missing/broken bundle fails HERE (`missing`), so it can no longer be
 *      masked by a failing auth precheck downstream.
 *   2. auth precheck — the marker-file/env heuristic is only a NEGATIVE gate:
 *      no credentials → `unauthenticated` without spending a smoke. It no
 *      longer has the authority to declare the machine authenticated.
 *   3. smoke — 1-turn haiku query through the SDK; the only path to `ok`.
 *
 * `sdkVersion` carries the launch-verified CLI's real version (the resolved
 * binary's, or the bundled `cli.js`'s).
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
      // No on-disk binary — the SDK will spawn its bundled `cli.js` via node.
      // Launch-verify that artifact now so a missing/broken bundle resolves to
      // `missing` regardless of auth state (the smoke still exercises the full
      // path, but it only runs after a passing auth precheck).
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
            "no Claude credentials found (ANTHROPIC_API_KEY unset and ~/.claude.json has no OAuth account); run `claude login` on this machine",
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
