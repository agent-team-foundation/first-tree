import type { CapabilityEntry, CapabilityRuntimeSource } from "@first-tree/shared";

/**
 * Install-only capability detection — the shared contract every provider probe
 * implements.
 *
 * Design principle (replacing the legacy launch-verified resolve→auth→smoke
 * probe): detection answers ONE question — "is the binary the runtime would
 * spawn resolvable on this host?" It never launches the binary, never checks
 * credentials, and never runs a real session. Whether the provider is
 * authenticated or end-to-end usable is discovered at session run time and
 * surfaced as an in-chat credential failure, not here. This removes the
 * false-negative + token/latency cost the mandatory auth-precheck + smoke
 * carried, at the price of detection no longer proving a session would succeed
 * — only that the runtime has something to spawn.
 *
 * A provider resolves to exactly one of:
 *   - `ok`      — installed: the spawnable artifact exists on disk.
 *   - `missing` — no spawnable artifact found (the reason lists what was checked).
 *   - `error`   — detection itself threw (reported verbatim).
 */

/** Cap stored error text — resolver messages can be arbitrarily long. */
export const MAX_ERROR_LENGTH = 500;

export function truncateError(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_ERROR_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_LENGTH)}…`;
}

/** Outcome of a provider's install check. */
export type DetectOutcome =
  | {
      installed: true;
      /** Provider version, when cheaply known without launching. Usually absent. */
      version?: string | null;
      /** Which artifact backs the runtime (bundled binary vs system-PATH). */
      runtimeSource?: CapabilityRuntimeSource;
      /** Absolute path of the resolved binary, when `runtimeSource: "path"`. */
      runtimePath?: string | null;
    }
  | { installed: false; error: string };

function finish(startedAt: number, entry: Omit<CapabilityEntry, "detectedAt" | "latencyMs">): CapabilityEntry {
  return {
    ...entry,
    // Deprecated wire-compat (see client-capabilities schema): install-only
    // detection no longer computes auth, but an OLDER server still REQUIRES
    // these on every entry, so keep emitting derived values until the version
    // floor rises.
    authenticated: entry.state === "ok",
    authMethod: "none",
    detectedAt: new Date(startedAt).toISOString(),
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Run a provider's install check and translate it into a `CapabilityEntry`.
 * Never throws — an unexpected exception becomes a `state: "error"` entry
 * carrying the exception message.
 */
export async function runDetect(detect: () => Promise<DetectOutcome>): Promise<CapabilityEntry> {
  const startedAt = Date.now();
  try {
    const outcome = await detect();
    if (outcome.installed) {
      return finish(startedAt, {
        state: "ok",
        available: true,
        sdkVersion: outcome.version ?? null,
        ...(outcome.runtimeSource ? { runtimeSource: outcome.runtimeSource } : {}),
        ...(outcome.runtimePath !== undefined ? { runtimePath: outcome.runtimePath } : {}),
      });
    }
    return finish(startedAt, {
      state: "missing",
      available: false,
      error: truncateError(outcome.error),
    });
  } catch (err) {
    return finish(startedAt, {
      state: "error",
      available: false,
      error: truncateError(err instanceof Error ? err.message : String(err)),
    });
  }
}
