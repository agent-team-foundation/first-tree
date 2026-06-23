import type { spawn } from "node:child_process";
import { resolveClaudeCodeExecutable } from "../handlers/claude-executable.js";
import { resolveBundledClaudeBinary } from "./capabilities/claude-code.js";
import { BROWSER_LOGIN_TIMEOUT_MS, type LoginOutcome, runBrowserLogin } from "./runtime-login.js";

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
