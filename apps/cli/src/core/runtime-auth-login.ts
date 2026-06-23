import {
  BROWSER_LOGIN_TIMEOUT_MS,
  type ClaudeLoginInvocation,
  type CodexBinaryResolution,
  type LoginOutcome,
  probeClaudeCodeCapability,
  probeClaudeCodeTuiCapability,
  probeCodexCapability,
  type RuntimeAuthCommand,
  resolveClaudeLoginInvocation,
  resolveCodexRuntimeBinary,
  runClaudeBrowserLogin,
  runCodexBrowserLogin,
} from "@first-tree/client";
import type { CapabilityEntry, PendingAuth } from "@first-tree/shared";

/**
 * Daemon-side orchestrator for an in-product runtime-auth login.
 *
 * Triggered by a `runtime-auth:start` reverse command from the server, this
 * drives the provider's official login on the host and surfaces progress by
 * re-PATCHing the capabilities snapshot (via {@link RuntimeAuthLoginDeps}),
 * which the web console already polls — so progress reaches the operator's
 * screen with no bespoke realtime channel, and the capability probe stays the
 * single source of truth. The OAuth token never transits First Tree.
 *
 * Browser OAuth across both providers:
 *   - codex: bare `codex login` → writes `~/.codex/auth.json`.
 *   - claude-code: `claude auth login` → writes keychain `Claude Code-credentials`.
 */

export type RuntimeAuthLoginDeps = {
  /** Latest known entry for a provider, to preserve fields while pending. */
  currentEntry: (provider: string) => CapabilityEntry | undefined;
  /** Merge a provider entry into the snapshot and upload it (deduped). */
  setProviderEntry: (provider: string, entry: CapabilityEntry) => Promise<void>;
  /** Status logger (symbol + message). */
  log: (symbol: string, message: string) => void;
  /** Seams for tests — production callers omit these. */
  resolveCodexBinary?: () => Promise<CodexBinaryResolution>;
  runBrowserLogin?: typeof runCodexBrowserLogin;
  probeCodex?: () => Promise<CapabilityEntry>;
  resolveClaudeLogin?: () => ClaudeLoginInvocation;
  runClaudeBrowser?: typeof runClaudeBrowserLogin;
  probeClaude?: () => Promise<CapabilityEntry>;
  probeClaudeTui?: () => Promise<CapabilityEntry>;
  now?: () => number;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A minimal `unauthenticated` entry carrying an in-flight pending-auth marker. */
function pendingEntry(base: CapabilityEntry | undefined, pending: PendingAuth, nowMs: number): CapabilityEntry {
  return {
    state: "unauthenticated",
    available: true,
    authenticated: false,
    authMethod: "none",
    sdkVersion: base?.sdkVersion ?? null,
    ...(base?.runtimeSource ? { runtimeSource: base.runtimeSource } : {}),
    ...(base?.runtimePath ? { runtimePath: base.runtimePath } : {}),
    detectedAt: new Date(nowMs).toISOString(),
    pendingAuth: pending,
  };
}

/**
 * A `browser` pending marker so the web shows "finish sign-in in your browser".
 * `authUrl` (the provider's sign-in URL, once the login process prints it) lets
 * the web offer a "didn't open? open sign-in" link when the host browser does
 * not auto-launch.
 */
function browserPending(nowMs: number, authUrl?: string): PendingAuth {
  return {
    method: "browser",
    expiresAt: new Date(nowMs + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
    ...(authUrl ? { authUrl } : {}),
  };
}

/** Dispatch on provider. Never throws — failures are logged + reflected in caps. */
export async function runRuntimeAuthLogin(command: RuntimeAuthCommand, deps: RuntimeAuthLoginDeps): Promise<void> {
  if (command.provider === "codex") {
    await runCodexRuntimeAuth(command, deps);
    return;
  }
  if (command.provider === "claude-code") {
    await runClaudeRuntimeAuth(command, deps);
    return;
  }
  deps.log("⚠️", `runtime-auth: provider "${command.provider}" is not supported yet (ref ${command.ref})`);
}

async function runCodexRuntimeAuth(command: RuntimeAuthCommand, deps: RuntimeAuthLoginDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const resolveBinary = deps.resolveCodexBinary ?? resolveCodexRuntimeBinary;
  const probeCodex = deps.probeCodex ?? probeCodexCapability;
  const runBrowserLogin = deps.runBrowserLogin ?? runCodexBrowserLogin;

  const reflectRealState = async (label: string): Promise<void> => {
    try {
      await deps.setProviderEntry("codex", await probeCodex());
    } catch (err) {
      deps.log("⚠️", `runtime-auth: codex re-probe ${label} failed: ${message(err)}`);
    }
  };

  deps.log("•", `runtime-auth: starting codex login (method=browser, ref ${command.ref})`);

  const resolved = await resolveBinary();
  if (!resolved.ok) {
    deps.log("⚠️", `runtime-auth: codex binary unavailable: ${resolved.error}`);
    await reflectRealState("after unresolved binary");
    return;
  }

  const setPending = (authUrl?: string): Promise<void> =>
    deps.setProviderEntry("codex", pendingEntry(deps.currentEntry("codex"), browserPending(now(), authUrl), now()));
  await setPending();
  deps.log("•", "runtime-auth: codex browser sign-in opened on this host");

  let outcome: LoginOutcome;
  try {
    // Surface the sign-in URL into the pending marker once codex prints it, so
    // the web can offer a fallback link when the host browser does not auto-open.
    outcome = await runBrowserLogin({ binary: resolved.binary, onAuthUrl: (url) => void setPending(url) });
  } catch (err) {
    deps.log("⚠️", `runtime-auth: codex login threw: ${message(err)}`);
    await reflectRealState("after login threw");
    return;
  }

  await reflectRealState("after login");
  logOutcome("codex", command.ref, outcome, deps);
}

/** claude-code: `claude auth login` (browser OAuth → keychain). */
async function runClaudeRuntimeAuth(command: RuntimeAuthCommand, deps: RuntimeAuthLoginDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const resolveLogin = deps.resolveClaudeLogin ?? resolveClaudeLoginInvocation;
  const runClaudeBrowser = deps.runClaudeBrowser ?? runClaudeBrowserLogin;
  const probeClaude = deps.probeClaude ?? probeClaudeCodeCapability;
  const probeClaudeTui = deps.probeClaudeTui ?? probeClaudeCodeTuiCapability;

  // Claude auth is a single keychain credential shared by the SDK (claude-code)
  // AND the TUI runtime (claude-code-tui). So a Claude login authenticates both;
  // re-probe both here, otherwise the TUI row stays a stale "needs login" until
  // the next background poll (the QA finding) and reads as a second, separate
  // Claude login the user must do — it isn't.
  const reflectRealState = async (label: string): Promise<void> => {
    try {
      const [cc, tui] = await Promise.all([probeClaude(), probeClaudeTui()]);
      await deps.setProviderEntry("claude-code", cc);
      await deps.setProviderEntry("claude-code-tui", tui);
    } catch (err) {
      deps.log("⚠️", `runtime-auth: claude re-probe ${label} failed: ${message(err)}`);
    }
  };

  deps.log("•", `runtime-auth: starting claude login (method=browser, ref ${command.ref})`);

  const invocation = resolveLogin();
  if (!invocation.ok) {
    deps.log("⚠️", `runtime-auth: claude CLI unavailable: ${invocation.error}`);
    await reflectRealState("after unresolved CLI");
    return;
  }

  const setPending = (authUrl?: string): Promise<void> =>
    deps.setProviderEntry(
      "claude-code",
      pendingEntry(deps.currentEntry("claude-code"), browserPending(now(), authUrl), now()),
    );
  await setPending();
  deps.log("•", "runtime-auth: claude browser sign-in opened on this host");

  let outcome: LoginOutcome;
  try {
    outcome = await runClaudeBrowser({
      command: invocation.command,
      baseArgs: invocation.baseArgs,
      onAuthUrl: (url) => void setPending(url),
    });
  } catch (err) {
    deps.log("⚠️", `runtime-auth: claude login threw: ${message(err)}`);
    await reflectRealState("after login threw");
    return;
  }

  await reflectRealState("after login");
  logOutcome("claude", command.ref, outcome, deps);
}

function logOutcome(provider: string, ref: string, outcome: LoginOutcome, deps: RuntimeAuthLoginDeps): void {
  if (outcome.ok) {
    deps.log("✓", `runtime-auth: ${provider} login complete (ref ${ref})`);
  } else {
    deps.log("⚠️", `runtime-auth: ${provider} login failed (${outcome.reason}): ${outcome.error}`);
  }
}
