import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";

/**
 * Pure view-model for the in-product runtime-auth controls on a provider card.
 * Derives what to render from the capability entry alone — the probe-driven
 * snapshot is the single source of truth (the in-flight login rides
 * `entry.pendingAuth`, surfaced by polling capabilities).
 *
 * Kinds:
 *   - "browser-pending": PRIMARY browser OAuth is running on the host; show a
 *     "finish sign-in in the browser that opened on this computer" state.
 *   - "device-code": FALLBACK headless login; show the verification URL + code.
 *   - "connectable": launchable but unauthenticated; show a "Connect" button
 *     (only for providers the daemon can drive in-product).
 *   - "none": nothing to offer here (ok / missing / error → other surfaces).
 */
export type RuntimeAuthView =
  | { kind: "browser-pending"; authUrl?: string }
  | { kind: "device-code"; verificationUrl: string; userCode: string; expiresAt: string }
  | { kind: "connectable" }
  | { kind: "none" };

/** Providers whose login the daemon can drive in-product today. */
export function providerSupportsInProductAuth(provider: RuntimeProvider): boolean {
  // Consistent browser-OAuth Connect: codex (`codex login`) + claude-code
  // (`claude auth login`). `claude-code-tui` shares Claude Code's credentials
  // but isn't a distinct Connect target.
  return provider === "codex" || provider === "claude-code";
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
): RuntimeAuthView {
  if (!entry) return { kind: "none" };

  const pending = entry.pendingAuth;
  if (pending) {
    const expiresMs = Date.parse(pending.expiresAt);
    const live = Number.isNaN(expiresMs) || expiresMs > nowMs;
    if (live) {
      if (pending.method === "browser") return { kind: "browser-pending", authUrl: pending.authUrl };
      if (pending.method === "device-code" && pending.verificationUrl && pending.userCode) {
        return {
          kind: "device-code",
          verificationUrl: pending.verificationUrl,
          userCode: pending.userCode,
          expiresAt: pending.expiresAt,
        };
      }
    }
    // Expired / malformed pending: fall through to offer a fresh Connect.
  }

  if (entry.state === "unauthenticated" && providerSupportsInProductAuth(provider)) {
    return { kind: "connectable" };
  }
  return { kind: "none" };
}

/** True while the card should keep polling capabilities for this provider. */
export function runtimeAuthIsPending(view: RuntimeAuthView): boolean {
  return view.kind === "browser-pending" || view.kind === "device-code";
}
