import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";

/**
 * Pure view-model for the in-product runtime-auth controls on a provider card.
 * Derives what to render from the capability entry alone — the probe-driven
 * snapshot is the single source of truth (the device code rides
 * `entry.pendingDeviceAuth`, surfaced by polling capabilities).
 *
 * Kinds:
 *   - "device-code": a login is in flight; show the verification URL + code.
 *   - "connectable": the provider is launchable but unauthenticated; show a
 *     "Connect" button (only for providers the daemon can drive in-product).
 *   - "none": nothing to offer here (ok / missing / error → other surfaces).
 */
export type RuntimeAuthView =
  | { kind: "device-code"; verificationUrl: string; userCode: string; expiresAt: string }
  | { kind: "connectable" }
  | { kind: "none" };

/** Providers whose login the daemon can drive in-product today. */
export function providerSupportsInProductAuth(provider: RuntimeProvider): boolean {
  // codex: `login --device-auth` (headless device code). claude-code's
  // browser `setup-token` path is a documented follow-up.
  return provider === "codex";
}

export function deriveRuntimeAuthView(
  provider: RuntimeProvider,
  entry: CapabilityEntry | null | undefined,
  nowMs: number,
): RuntimeAuthView {
  if (!entry) return { kind: "none" };

  const pending = entry.pendingDeviceAuth;
  if (pending) {
    const expiresMs = Date.parse(pending.expiresAt);
    const live = Number.isNaN(expiresMs) || expiresMs > nowMs;
    if (live) {
      return {
        kind: "device-code",
        verificationUrl: pending.verificationUrl,
        userCode: pending.userCode,
        expiresAt: pending.expiresAt,
      };
    }
    // Expired code: fall through to offer a fresh Connect (if supported).
  }

  if (entry.state === "unauthenticated" && providerSupportsInProductAuth(provider)) {
    return { kind: "connectable" };
  }
  return { kind: "none" };
}

/** True while the card should keep polling capabilities for this provider. */
export function runtimeAuthIsPending(view: RuntimeAuthView): boolean {
  return view.kind === "device-code";
}
