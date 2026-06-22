import {
  type CodexBinaryResolution,
  type DeviceAuthOutcome,
  type DeviceCodePrompt,
  probeCodexCapability,
  type RuntimeAuthCommand,
  resolveCodexRuntimeBinary,
  runCodexDeviceAuthLogin,
} from "@first-tree/client";
import type { CapabilityEntry, PendingDeviceAuth } from "@first-tree/shared";

/**
 * Daemon-side orchestrator for an in-product runtime-auth login.
 *
 * Triggered by a `runtime-auth:start` reverse command from the server, this
 * drives the provider's official login on the host and surfaces progress by
 * re-PATCHing the capabilities snapshot (via {@link RuntimeAuthLoginDeps}),
 * which the web console already polls — so the verification URL + one-time
 * code reach the operator's screen with no bespoke realtime channel, and the
 * capability probe stays the single source of truth.
 *
 * Codex: `codex login --device-auth` (headless-friendly device code). Other
 * providers are not wired yet (a follow-up adds claude `setup-token`).
 */

/** Fallback expiry when the provider prompt does not state one (codex says 15). */
const DEFAULT_EXPIRY_MINUTES = 15;

export type RuntimeAuthLoginDeps = {
  /** Latest known entry for a provider, to preserve fields while pending. */
  currentEntry: (provider: string) => CapabilityEntry | undefined;
  /** Merge a provider entry into the snapshot and upload it (deduped). */
  setProviderEntry: (provider: string, entry: CapabilityEntry) => Promise<void>;
  /** Status logger (symbol + message). */
  log: (symbol: string, message: string) => void;
  /** Seams for tests — production callers omit these. */
  resolveCodexBinary?: () => Promise<CodexBinaryResolution>;
  runDeviceAuth?: typeof runCodexDeviceAuthLogin;
  probeCodex?: () => Promise<CapabilityEntry>;
  now?: () => number;
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A minimal `unauthenticated` entry that carries a pending device-code. */
function pendingEntry(base: CapabilityEntry | undefined, pending: PendingDeviceAuth, nowMs: number): CapabilityEntry {
  return {
    state: "unauthenticated",
    available: true,
    authenticated: false,
    authMethod: "none",
    sdkVersion: base?.sdkVersion ?? null,
    ...(base?.runtimeSource ? { runtimeSource: base.runtimeSource } : {}),
    ...(base?.runtimePath ? { runtimePath: base.runtimePath } : {}),
    detectedAt: new Date(nowMs).toISOString(),
    pendingDeviceAuth: pending,
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
  const runDeviceAuth = deps.runDeviceAuth ?? runCodexDeviceAuthLogin;
  const probeCodex = deps.probeCodex ?? probeCodexCapability;

  // Re-probe codex and publish the result, clearing any pending device-code.
  // This is the single "reflect the real state" path: used on resolve failure
  // and after the login resolves (success or failure).
  const reflectRealState = async (label: string): Promise<void> => {
    try {
      await deps.setProviderEntry("codex", await probeCodex());
    } catch (err) {
      deps.log("⚠️", `runtime-auth: codex re-probe ${label} failed: ${message(err)}`);
    }
  };

  deps.log("•", `runtime-auth: starting codex device-auth (ref ${command.ref})`);

  const resolved = await resolveBinary();
  if (!resolved.ok) {
    deps.log("⚠️", `runtime-auth: codex binary unavailable: ${resolved.error}`);
    await reflectRealState("after unresolved binary");
    return;
  }

  const publishPending = async (prompt: DeviceCodePrompt): Promise<void> => {
    const minutes = prompt.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES;
    const pending: PendingDeviceAuth = {
      verificationUrl: prompt.verificationUrl,
      userCode: prompt.userCode,
      expiresAt: new Date(now() + minutes * 60_000).toISOString(),
    };
    await deps.setProviderEntry("codex", pendingEntry(deps.currentEntry("codex"), pending, now()));
    deps.log("•", `runtime-auth: codex device code ${prompt.userCode} → ${prompt.verificationUrl}`);
  };

  let outcome: DeviceAuthOutcome;
  try {
    outcome = await runDeviceAuth({
      binary: resolved.binary,
      onDeviceCode: (prompt) => {
        void publishPending(prompt);
      },
    });
  } catch (err) {
    // runCodexDeviceAuthLogin is documented never to throw, but stay defensive.
    deps.log("⚠️", `runtime-auth: codex device-auth threw: ${message(err)}`);
    await reflectRealState("after device-auth threw");
    return;
  }

  await reflectRealState("after login");
  if (outcome.ok) {
    deps.log("✓", `runtime-auth: codex login complete (ref ${command.ref})`);
  } else {
    deps.log("⚠️", `runtime-auth: codex login failed (${outcome.reason}): ${outcome.error}`);
  }
}
