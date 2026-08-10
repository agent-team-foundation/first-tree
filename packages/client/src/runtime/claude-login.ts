import type { spawn } from "node:child_process";
import { isRuntimeProviderEnabled, RUNTIME_PROVIDERS } from "@first-tree/shared";
import { resolveClaudeCodeExecutable } from "../handlers/claude-executable.js";
import type {
  RuntimeAuthDriver,
  RuntimeAuthLoginResolution,
  RuntimeAuthProbeResult,
} from "../providers/auth-driver.js";
import { BROWSER_LOGIN_TIMEOUT_MS, type LoginOutcome, runBrowserLogin } from "../providers/runtime-login.js";
import { probeClaudeCodeCapability, resolveBundledClaudeBinary } from "./capabilities/claude-code.js";
import { probeClaudeCodeTuiCapability } from "./capabilities/claude-code-tui.js";

/**
 * Claude browser-OAuth login — the cc counterpart of `codex login`, for the
 * consistent in-product Connect experience. `claude auth login` opens the
 * Anthropic sign-in page on the host, redirects to its localhost callback, and
 * writes the keychain entry `Claude Code-credentials` that the Agent SDK reads.
 * First Tree never sees the token.
 *
 * Resolution mirrors the capability probe: prefer a real `claude` resolved on
 * env / PATH / a well-known dir; otherwise run the SDK's bundled Claude binary
 * (legacy `cli.js` via `node`, or a modern per-platform native binary spawned
 * directly) — the same artifact the runtime spawns when no on-disk `claude`
 * resolves.
 */

export type ClaudeLoginInvocation = { ok: true; command: string; baseArgs: string[] } | { ok: false; error: string };

/** Resolve how to invoke the claude CLI for `auth login` on this host. */
export function resolveClaudeLoginInvocation(env: NodeJS.ProcessEnv = process.env): ClaudeLoginInvocation {
  const resolution = resolveClaudeCodeExecutable({ env });
  if (resolution.source !== "default" && resolution.path) {
    return { ok: true, command: resolution.path, baseArgs: [] };
  }
  // No on-disk `claude` — drive the SDK-bundled Claude binary.
  try {
    const bundled = resolveBundledClaudeBinary();
    return bundled.kind === "cli-js"
      ? { ok: true, command: process.execPath, baseArgs: [bundled.path] }
      : { ok: true, command: bundled.path, baseArgs: [] };
  } catch (err) {
    return {
      ok: false,
      error: `no \`claude\` on PATH and the SDK-bundled Claude binary could not be located: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export type ClaudeBrowserLoginOptions = {
  /** Command + base args from {@link resolveClaudeLoginInvocation}. */
  command: string;
  baseArgs: string[];
  env?: NodeJS.ProcessEnv;
  onAuthUrl?: (url: string) => void;
  onRawOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
};

/** PRIMARY: spawn `claude auth login` (browser OAuth → keychain). */
export function runClaudeBrowserLogin(options: ClaudeBrowserLoginOptions): Promise<LoginOutcome> {
  return runBrowserLogin({
    command: options.command,
    args: [...options.baseArgs, "auth", "login"],
    label: "claude auth login",
    env: options.env,
    onAuthUrl: options.onAuthUrl,
    onRawOutput: options.onRawOutput,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS,
    spawnFn: options.spawnFn,
  });
}

/** Test seams; production composition passes nothing. */
export type ClaudeAuthDriverDeps = {
  resolveLogin?: typeof resolveClaudeLoginInvocation;
  runBrowserLogin?: typeof runClaudeBrowserLogin;
  probe?: typeof probeClaudeCodeCapability;
  probeTui?: typeof probeClaudeCodeTuiCapability;
  isProviderEnabled?: typeof isRuntimeProviderEnabled;
};

/**
 * Claude Code's in-product auth driver.
 *
 * Claude auth is a single keychain credential shared by the SDK runtime and the
 * TUI runtime, so one login authenticates both and the driver refreshes both
 * rows - otherwise the TUI row keeps reading as a second, separate Claude login
 * the user still has to perform until the next background poll. While the TUI
 * provider is centrally disabled this path honours that switch exactly like the
 * capability aggregator: it must not spawn the TUI probe (`claude` / tmux) or
 * publish a TUI row.
 */
export function createClaudeAuthDriver(deps: ClaudeAuthDriverDeps = {}): RuntimeAuthDriver {
  const resolveLogin = deps.resolveLogin ?? resolveClaudeLoginInvocation;
  const browserLogin = deps.runBrowserLogin ?? runClaudeBrowserLogin;
  const probe = deps.probe ?? probeClaudeCodeCapability;
  const probeTui = deps.probeTui ?? probeClaudeCodeTuiCapability;
  const isProviderEnabled = deps.isProviderEnabled ?? isRuntimeProviderEnabled;

  // Frozen so this factory's promise ("a fresh, self-contained driver") holds
  // even for a caller that never routes through RUNTIME_AUTH_DRIVERS: nothing
  // downstream of this constructor can repoint resolveLogin/reprobe for the
  // rest of the process.
  return Object.freeze({
    logLabel: "claude",
    loginLabel: "claude auth login",
    // Claude can fall back to the SDK-bundled engine, so the operator-facing
    // gap is "a claude CLI to drive", not a single external binary.
    artifactLabel: "CLI",
    async resolveLogin(): Promise<RuntimeAuthLoginResolution> {
      const invocation = resolveLogin();
      if (!invocation.ok) return { ok: false, error: invocation.error };
      return {
        ok: true,
        login: ({ onAuthUrl }) =>
          browserLogin({ command: invocation.command, baseArgs: invocation.baseArgs, onAuthUrl }),
      };
    },
    async reprobe(): Promise<readonly RuntimeAuthProbeResult[]> {
      if (!isProviderEnabled(RUNTIME_PROVIDERS.CLAUDE_CODE_TUI)) {
        return [{ provider: RUNTIME_PROVIDERS.CLAUDE_CODE, entry: await probe() }];
      }
      const [claudeCode, tui] = await Promise.all([probe(), probeTui()]);
      return [
        { provider: RUNTIME_PROVIDERS.CLAUDE_CODE, entry: claudeCode },
        { provider: RUNTIME_PROVIDERS.CLAUDE_CODE_TUI, entry: tui },
      ];
    },
  });
}
