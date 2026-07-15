import type { CapabilityEntry, RuntimeAuthLastError, RuntimeProvider } from "@first-tree/shared";

/**
 * Pure view-model for the in-product runtime-auth controls. Derives what to
 * render from the capability entry alone — the probe-driven snapshot is the
 * single source of truth (the in-flight login rides `entry.pendingAuth`,
 * surfaced by polling capabilities).
 *
 * Detection is now install-only — capability `state` no longer carries an
 * "unauthenticated" signal, so this view-model can no longer derive a
 * "Connect because logged-out" affordance from `state`. The computer cards
 * have stopped using it; the kinds + exports are kept so a later in-chat auth
 * entry point can revive them. The only live signal here is an in-flight
 * `pendingAuth` (a login the daemon is already driving).
 *
 * Kinds:
 *   - "browser-pending": browser OAuth is running on the host; show a
 *     "finish sign-in in the browser that opened on this computer" state.
 *   - "connectable": launchable; show a "Connect" button (only for providers
 *     the daemon can drive in-product). Carries `lastError` when the previous
 *     in-product login terminally failed. No longer derived from capability
 *     `state` — reserved for the future in-chat auth entry point.
 *   - "none": nothing to offer here.
 */
export type RuntimeAuthView =
  | { kind: "browser-pending"; authUrl?: string }
  | { kind: "connectable"; lastError?: RuntimeAuthLastError }
  | { kind: "none" };

/** Providers whose login the daemon can drive in-product today. */
export function providerSupportsInProductAuth(provider: RuntimeProvider): boolean {
  // Consistent browser-OAuth Connect: codex (`codex login`), claude-code
  // (`claude auth login`), and cursor (`cursor-agent login`). `claude-code-tui`
  // shares Claude Code's credentials but isn't a distinct Connect target.
  return provider === "codex" || provider === "claude-code" || provider === "cursor";
}

/**
 * Normalize a failing runtime's provider to the provider whose in-product login
 * actually authenticates it. `claude-code-tui` shares the SAME Claude keychain
 * as the Claude Code SDK — it has no distinct Connect target and the server's
 * runtime-auth schema rejects it — so a `claude-code-tui` credential failure
 * maps to the `claude-code` login target (used for `startRuntimeAuth`, the
 * capability-entry lookup, and `deriveRuntimeAuthView`). Every other provider
 * maps to itself.
 */
export function loginTargetProvider(provider: RuntimeProvider): RuntimeProvider {
  return provider === "claude-code-tui" ? "claude-code" : provider;
}

/**
 * Providers whose credentials are obtained in-product — either directly via
 * Connect, OR shared: `claude-code-tui` uses the SAME Claude keychain as the
 * Claude Code SDK, so a Claude Code login authenticates it too. The card must
 * NOT show a manual "Run `<cli> login`" hint for any of these — there is no
 * separate CLI login to run.
 */
export function providerAuthHandledInProduct(provider: RuntimeProvider): boolean {
  return providerSupportsInProductAuth(provider) || provider === "claude-code-tui";
}

export function deriveRuntimeAuthView(
  provider: RuntimeProvider,
  entry: CapabilityEntry | null | undefined,
  nowMs: number,
  /**
   * Force the "connectable" affordance even when no capability `state` keys it.
   * The in-chat "needs login" entry point sets this when a session credential
   * failure has already proven the provider is logged out — the chat, not the
   * install-only probe, is the trigger. Only honoured for providers the daemon
   * can actually drive in-product.
   */
  forceConnectable = false,
): RuntimeAuthView {
  const pending = entry?.pendingAuth;
  if (pending) {
    const expiresMs = Date.parse(pending.expiresAt);
    const live = Number.isNaN(expiresMs) || expiresMs > nowMs;
    if (live && pending.method === "browser") return { kind: "browser-pending", authUrl: pending.authUrl };
    // Expired / malformed pending: fall through.
  }

  // Detection is install-only — there is no logged-out capability state to key a
  // "Connect" affordance off anymore. The in-chat entry point revives the
  // connectable path explicitly via `forceConnectable` once a session credential
  // failure has surfaced, but only for providers the daemon can drive.
  if (forceConnectable && providerSupportsInProductAuth(provider)) {
    // A credential failure is a runtime auth error on an INSTALLED runtime, so
    // the keying capability `state` is `ok` (or absent — not yet probed). The
    // daemon's `attachAuthError` also stamps `lastAuthError` when the binary is
    // gone (`state: "missing"`) or the probe errored (`state: "error"`); a
    // Connect there only re-fails forever, so withhold the affordance — there is
    // nothing to log into until the runtime is installed.
    if (entry?.state === "missing" || entry?.state === "error") return { kind: "none" };
    return { kind: "connectable", lastError: entry?.lastAuthError ?? undefined };
  }
  return { kind: "none" };
}

/** True while the card should keep polling capabilities for this provider. */
export function runtimeAuthIsPending(view: RuntimeAuthView): boolean {
  return view.kind === "browser-pending";
}
