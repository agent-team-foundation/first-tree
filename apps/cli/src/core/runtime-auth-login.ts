import {
  BROWSER_LOGIN_TIMEOUT_MS,
  type ClaudeLoginInvocation,
  type CodexBinaryResolution,
  type CursorRuntimeBinaryResolution,
  type LoginOutcome,
  probeClaudeCodeCapability,
  probeClaudeCodeTuiCapability,
  probeCodexCapability,
  probeCursorCapability,
  type RuntimeAuthCommand,
  resolveClaudeLoginInvocation,
  resolveCodexRuntimeBinary,
  resolveCursorRuntimeBinary,
  runClaudeBrowserLogin,
  runCodexBrowserLogin,
  runCursorBrowserLogin,
} from "@first-tree/client";
import {
  type CapabilityEntry,
  isRuntimeProviderEnabled,
  type PendingAuth,
  type RuntimeAuthFailureReason,
} from "@first-tree/shared";

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
  resolveCursorBinary?: () => CursorRuntimeBinaryResolution;
  runCursorBrowser?: typeof runCursorBrowserLogin;
  probeCursor?: () => Promise<CapabilityEntry>;
  now?: () => number;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A terminal login failure to record on the provider entry. */
type AuthFailure = { reason: RuntimeAuthFailureReason; message?: string };

/**
 * Stamp a terminal `lastAuthError` onto a freshly re-probed entry so the web can
 * tell "sign-in failed — retry" from "never attempted".
 *
 * Capability detection is now install-only — it no longer reports an auth state
 * (an installed provider is always `ok` regardless of login). So login
 * progress/outcome rides the entry's `pendingAuth` / `lastAuthError` markers,
 * decoupled from `state`: a failure stamps `lastAuthError` whenever present
 * (success passes `null`, which leaves the re-probed entry marker-free and thus
 * clears any prior failure). The in-chat "needs login" entry point reads these
 * markers, the same way the prior card-side Connect control did.
 */
function attachAuthError(entry: CapabilityEntry, failure: AuthFailure | null, nowMs: number): CapabilityEntry {
  if (!failure) return entry;
  return {
    ...entry,
    lastAuthError: {
      reason: failure.reason,
      ...(failure.message ? { message: failure.message } : {}),
      at: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * The provider's install entry (which login only runs for, so it is `ok`) with
 * an in-flight `pendingAuth` marker layered on. Detection no longer carries an
 * auth state, so we preserve the install entry's fields and only add the marker;
 * if no prior entry exists, fall back to a minimal installed entry.
 */
function pendingEntry(base: CapabilityEntry | undefined, pending: PendingAuth, nowMs: number): CapabilityEntry {
  const baseEntry: CapabilityEntry = base ?? {
    state: "ok",
    available: true,
    detectedAt: new Date(nowMs).toISOString(),
  };
  // A login only starts after the provider binary resolved, so the provider IS
  // installed: force the install fields rather than inheriting a possibly-stale
  // non-`ok` base (which would yield a contradictory `missing` + pendingAuth
  // entry). `authenticated`/`authMethod` are deprecated wire-compat for older
  // servers (see the client-capabilities schema).
  return {
    ...baseEntry,
    state: "ok",
    available: true,
    authenticated: true,
    authMethod: "none",
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
  if (command.provider === "cursor") {
    await runCursorRuntimeAuth(command, deps);
    return;
  }
  deps.log("⚠️", `runtime-auth: provider "${command.provider}" is not supported yet (ref ${command.ref})`);
}

/** cursor: `<cursor-binary> login` (official browser OAuth on the host). */
async function runCursorRuntimeAuth(command: RuntimeAuthCommand, deps: RuntimeAuthLoginDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const resolveBinary = deps.resolveCursorBinary ?? resolveCursorRuntimeBinary;
  const probeCursor = deps.probeCursor ?? probeCursorCapability;
  const runCursorBrowser = deps.runCursorBrowser ?? runCursorBrowserLogin;

  const reflect = async (label: string, failure: AuthFailure | null): Promise<void> => {
    try {
      await deps.setProviderEntry("cursor", attachAuthError(await probeCursor(), failure, now()));
    } catch (err) {
      deps.log("⚠️", `runtime-auth: cursor re-probe ${label} failed: ${message(err)}`);
    }
  };

  deps.log("•", `runtime-auth: starting cursor login (method=browser, ref ${command.ref})`);

  // Login drives the SAME resolved binary the handler spawns (external-only),
  // including its bounded `--version` smoke check — the first real use.
  const resolved = resolveBinary();
  if (!resolved.ok) {
    deps.log("⚠️", `runtime-auth: cursor binary unavailable: ${resolved.error}`);
    await reflect("after unresolved binary", { reason: "spawn-error", message: resolved.error });
    return;
  }

  const setPending = (authUrl?: string): Promise<void> =>
    deps.setProviderEntry("cursor", pendingEntry(deps.currentEntry("cursor"), browserPending(now(), authUrl), now()));
  await setPending();
  deps.log("•", "runtime-auth: cursor browser sign-in opened on this host");

  let outcome: LoginOutcome;
  try {
    outcome = await runCursorBrowser({ binary: resolved.binary, onAuthUrl: (url) => void setPending(url) });
  } catch (err) {
    deps.log("⚠️", `runtime-auth: cursor login threw: ${message(err)}`);
    await reflect("after login threw", { reason: "spawn-error", message: message(err) });
    return;
  }

  await reflect("after login", outcome.ok ? null : { reason: outcome.reason, message: outcome.error });
  logOutcome("cursor", command.ref, outcome, deps);
}

async function runCodexRuntimeAuth(command: RuntimeAuthCommand, deps: RuntimeAuthLoginDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const resolveBinary = deps.resolveCodexBinary ?? resolveCodexRuntimeBinary;
  const probeCodex = deps.probeCodex ?? probeCodexCapability;
  const runBrowserLogin = deps.runBrowserLogin ?? runCodexBrowserLogin;

  // Re-probe the real state and, on a terminal failure, stamp `lastAuthError`
  // onto the entry so the web shows "sign-in failed — retry" instead of silently
  // resetting to a fresh Connect button.
  const reflect = async (label: string, failure: AuthFailure | null): Promise<void> => {
    try {
      await deps.setProviderEntry("codex", attachAuthError(await probeCodex(), failure, now()));
    } catch (err) {
      deps.log("⚠️", `runtime-auth: codex re-probe ${label} failed: ${message(err)}`);
    }
  };

  deps.log("•", `runtime-auth: starting codex login (method=browser, ref ${command.ref})`);

  const resolved = await resolveBinary();
  if (!resolved.ok) {
    deps.log("⚠️", `runtime-auth: codex binary unavailable: ${resolved.error}`);
    await reflect("after unresolved binary", { reason: "spawn-error", message: resolved.error });
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
    await reflect("after login threw", { reason: "spawn-error", message: message(err) });
    return;
  }

  await reflect("after login", outcome.ok ? null : { reason: outcome.reason, message: outcome.error });
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
  // A failure stamps `lastAuthError` on the claude-code entry only (the login
  // target); the shared-keychain tui entry just reflects the re-probed state.
  // While claude-code-tui is disabled (DISABLED_RUNTIME_PROVIDERS), this path
  // honours the same central switch as the capability aggregator: it must not
  // spawn the TUI probe (`claude` / tmux) or write a tui entry — a claude-code
  // login then reflects claude-code only.
  const reflect = async (label: string, failure: AuthFailure | null): Promise<void> => {
    try {
      if (isRuntimeProviderEnabled("claude-code-tui")) {
        const [cc, tui] = await Promise.all([probeClaude(), probeClaudeTui()]);
        await deps.setProviderEntry("claude-code", attachAuthError(cc, failure, now()));
        await deps.setProviderEntry("claude-code-tui", tui);
      } else {
        const cc = await probeClaude();
        await deps.setProviderEntry("claude-code", attachAuthError(cc, failure, now()));
      }
    } catch (err) {
      deps.log("⚠️", `runtime-auth: claude re-probe ${label} failed: ${message(err)}`);
    }
  };

  deps.log("•", `runtime-auth: starting claude auth login (method=browser, ref ${command.ref})`);

  const invocation = resolveLogin();
  if (!invocation.ok) {
    deps.log("⚠️", `runtime-auth: claude CLI unavailable: ${invocation.error}`);
    await reflect("after unresolved CLI", { reason: "spawn-error", message: invocation.error });
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
    deps.log("⚠️", `runtime-auth: claude auth login threw: ${message(err)}`);
    await reflect("after login threw", { reason: "spawn-error", message: message(err) });
    return;
  }

  await reflect("after login", outcome.ok ? null : { reason: outcome.reason, message: outcome.error });
  logOutcome("claude", command.ref, outcome, deps);
}

function logOutcome(provider: string, ref: string, outcome: LoginOutcome, deps: RuntimeAuthLoginDeps): void {
  if (outcome.ok) {
    deps.log("✓", `runtime-auth: ${provider} login complete (ref ${ref})`);
  } else {
    deps.log("⚠️", `runtime-auth: ${provider} login failed (${outcome.reason}): ${outcome.error}`);
  }
}
