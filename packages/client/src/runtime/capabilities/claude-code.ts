import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@first-tree/shared";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "../../handlers/claude-executable.js";
import { detectClaudeAuth } from "./claude-shared.js";
import {
  type AuthPrecheckOutcome,
  type ResolveOutcome,
  runLaunchProbe,
  type SmokeOutcome,
  truncateError,
  verifyLaunchable,
} from "./launch-probe.js";

/** Whole-probe smoke budget. A healthy 1-turn haiku reply takes ~5s. */
export const CLAUDE_SMOKE_TIMEOUT_MS = 60_000;

/** Prompt for the 1-turn smoke — cheapest possible real session. */
export const CLAUDE_SMOKE_PROMPT = "Reply with exactly: OK";

async function readSdkVersion(): Promise<string | null> {
  // The Anthropic SDK does not expose `./package.json` via `exports` and only
  // ships ESM `default` (no CJS `require` condition). Use ESM resolution, then
  // walk up from the entry file to the package root.
  try {
    const entryUrl = await import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    let dir = dirname(fileURLToPath(entryUrl));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "@anthropic-ai/claude-agent-sdk" && typeof pkg.version === "string") return pkg.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return null;
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
async function defaultClaudeSdkSmoke(binary: string | undefined): Promise<SmokeOutcome> {
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
        // Neutral cwd: the daemon's cwd may be anywhere; the smoke must not
        // pick up a repo's .claude/ settings or spawn in a deleted dir.
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
  readSdkVersion?: () => Promise<string | null>;
  resolveExecutable?: (opts?: { env?: NodeJS.ProcessEnv }) => ClaudeExecutableResolution;
  verifyBinary?: (binary: string) => Promise<{ ok: true; version: string | null } | { ok: false; error: string }>;
  detectAuth?: () => { authenticated: boolean; method: "api_key" | "oauth" | "none" };
  runSmoke?: (binary: string | undefined) => Promise<SmokeOutcome>;
};

/**
 * Launch-verified probe for the `claude-code` (SDK) runtime.
 *
 * Stage map:
 *   1. resolve — the SDK package must import, and when a real `claude` binary
 *      resolves (env override / PATH / well-known dirs) it must pass a real
 *      `--version` spawn. No binary resolved is NOT a failure here: the
 *      runtime then uses the SDK's bundled native binary, and the smoke
 *      exercises that path for real (a missing bundle surfaces as the SDK's
 *      own "Native CLI binary not found" → `missing`).
 *   2. auth precheck — the marker-file/env heuristic is only a NEGATIVE gate:
 *      no credentials → `unauthenticated` without spending a smoke. It no
 *      longer has the authority to declare the machine authenticated.
 *   3. smoke — 1-turn haiku query through the SDK; the only path to `ok`.
 *
 * `sdkVersion` carries the resolved CLI's real version when a binary was
 * found, otherwise the SDK package version (the engine the runtime embeds).
 */
export async function probeClaudeCodeCapability(deps: ClaudeCodeProbeDeps = {}): Promise<CapabilityEntry> {
  const importSdk = deps.importSdk ?? (() => import("@anthropic-ai/claude-agent-sdk"));
  const readVersion = deps.readSdkVersion ?? readSdkVersion;
  const resolveExecutable = deps.resolveExecutable ?? resolveClaudeCodeExecutable;
  const verifyBinary = deps.verifyBinary ?? ((binary: string) => verifyLaunchable("claude", binary));
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
      // No on-disk binary — the SDK will use its bundled native binary. The
      // smoke is the real verification of that launch path.
      return { ok: true, version: await readVersion() };
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
