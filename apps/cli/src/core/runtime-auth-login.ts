import {
  BROWSER_LOGIN_TIMEOUT_MS,
  type CodexBinaryResolution,
  type DeviceAuthOutcome,
  type DeviceCodePrompt,
  probeCodexCapability,
  type RuntimeAuthCommand,
  resolveCodexRuntimeBinary,
  runCodexBrowserLogin,
  runCodexDeviceAuthLogin,
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
 * Codex methods:
 *   - PRIMARY `browser` (default): bare `codex login` — opens the auth page on
 *     the host, redirects to codex's localhost callback, codex writes auth.json.
 *   - FALLBACK `device-auth`: `codex login --device-auth` for a headless host;
 *     surfaces a device code the user enters on another device.
 *
 * Other providers (claude-code) are a follow-up (browser `setup-token`).
 */

/** Fallback expiry when the device-code prompt does not state one (codex says 15). */
const DEFAULT_DEVICE_CODE_MINUTES = 15;

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
  runDeviceAuth?: typeof runCodexDeviceAuthLogin;
  probeCodex?: () => Promise<CapabilityEntry>;
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

/** Dispatch on provider. Never throws — failures are logged + reflected in caps. */
export async function runRuntimeAuthLogin(command: RuntimeAuthCommand, deps: RuntimeAuthLoginDeps): Promise<void> {
  if (command.provider === "codex") {
    await runCodexRuntimeAuth(command, deps);
    return;
  }
  deps.log("⚠️", `runtime-auth: provider "${command.provider}" is not supported yet (ref ${command.ref})`);
}

async function runCodexRuntimeAuth(command: RuntimeAuthCommand, deps: RuntimeAuthLoginDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const resolveBinary = deps.resolveCodexBinary ?? resolveCodexRuntimeBinary;
  const probeCodex = deps.probeCodex ?? probeCodexCapability;
  // Browser OAuth is the primary, consistent experience; device-auth is the
  // explicit headless fallback (only when the host has no usable browser).
  const method = command.method === "device-auth" ? "device-auth" : "browser";

  // Re-probe codex and publish the result, clearing any pending marker. The
  // single "reflect the real state" path: used on resolve failure and after the
  // login resolves (success or failure).
  const reflectRealState = async (label: string): Promise<void> => {
    try {
      await deps.setProviderEntry("codex", await probeCodex());
    } catch (err) {
      deps.log("⚠️", `runtime-auth: codex re-probe ${label} failed: ${message(err)}`);
    }
  };

  deps.log("•", `runtime-auth: starting codex login (method=${method}, ref ${command.ref})`);

  const resolved = await resolveBinary();
  if (!resolved.ok) {
    deps.log("⚠️", `runtime-auth: codex binary unavailable: ${resolved.error}`);
    await reflectRealState("after unresolved binary");
    return;
  }

  let outcome: DeviceAuthOutcome;
  try {
    outcome =
      method === "device-auth"
        ? await runDeviceAuthFlow(resolved.binary, deps, now)
        : await runBrowserFlow(resolved.binary, deps, now);
  } catch (err) {
    // The runners are documented never to throw, but stay defensive.
    deps.log("⚠️", `runtime-auth: codex login threw: ${message(err)}`);
    await reflectRealState("after login threw");
    return;
  }

  await reflectRealState("after login");
  if (outcome.ok) {
    deps.log("✓", `runtime-auth: codex login complete (ref ${command.ref})`);
  } else {
    deps.log("⚠️", `runtime-auth: codex login failed (${outcome.reason}): ${outcome.error}`);
  }
}

/**
 * PRIMARY: browser OAuth. Mark a `browser` pending so the web shows the "finish
 * sign-in in the browser on this host" state, then run `codex login`.
 */
async function runBrowserFlow(
  binary: string,
  deps: RuntimeAuthLoginDeps,
  now: () => number,
): Promise<DeviceAuthOutcome> {
  const runBrowserLogin = deps.runBrowserLogin ?? runCodexBrowserLogin;
  const pending: PendingAuth = {
    method: "browser",
    expiresAt: new Date(now() + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
  };
  await deps.setProviderEntry("codex", pendingEntry(deps.currentEntry("codex"), pending, now()));
  deps.log("•", "runtime-auth: codex browser sign-in opened on this host");
  return runBrowserLogin({ binary });
}

/** FALLBACK: device code. Surface the verification URL + code as pending-auth. */
async function runDeviceAuthFlow(
  binary: string,
  deps: RuntimeAuthLoginDeps,
  now: () => number,
): Promise<DeviceAuthOutcome> {
  const runDeviceAuth = deps.runDeviceAuth ?? runCodexDeviceAuthLogin;
  const publishPending = async (prompt: DeviceCodePrompt): Promise<void> => {
    const minutes = prompt.expiresInMinutes ?? DEFAULT_DEVICE_CODE_MINUTES;
    const pending: PendingAuth = {
      method: "device-code",
      verificationUrl: prompt.verificationUrl,
      userCode: prompt.userCode,
      expiresAt: new Date(now() + minutes * 60_000).toISOString(),
    };
    await deps.setProviderEntry("codex", pendingEntry(deps.currentEntry("codex"), pending, now()));
    deps.log("•", `runtime-auth: codex device code ${prompt.userCode} → ${prompt.verificationUrl}`);
  };
  return runDeviceAuth({
    binary,
    onDeviceCode: (prompt) => {
      void publishPending(prompt);
    },
  });
}
