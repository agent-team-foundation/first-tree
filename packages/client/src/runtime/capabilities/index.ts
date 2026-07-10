import {
  type CapabilityEntry,
  type ClientCapabilities,
  isRuntimeProviderEnabled,
  type RuntimeProvider,
} from "@first-tree/shared";
import { probeClaudeCodeCapability } from "./claude-code.js";
import { probeClaudeCodeTuiCapability } from "./claude-code-tui.js";
import { probeCodexCapability } from "./codex.js";
import { probeCursorCapability } from "./cursor.js";

/** Periodic full re-probe ceiling: re-detect at most this often on reconnect to
 * catch silent drift (a provider uninstalled while connected). Detection is
 * cheap (no launch), so this is a coarse staleness bound, not a cost guard. */
export const REPROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The runtime providers a built-in probe exists for AND that are not
 * temporarily disabled. Drives whether a daemon's advertised snapshot still has
 * a provider worth re-probing (see {@link hasNonOkProvider}). */
export const PROBED_RUNTIME_PROVIDERS: readonly RuntimeProvider[] = (
  ["claude-code", "claude-code-tui", "codex", "cursor"] as const
).filter((p) => isRuntimeProviderEnabled(p));

/** First delay before the daemon-side degraded-capability re-probe fires. Short
 * enough that a freshly-installed provider is noticed quickly during setup. */
export const CAPABILITY_REFRESH_BASE_MS = 15 * 1000;

/** Upper bound on the backoff between degraded-capability re-probes. */
export const CAPABILITY_REFRESH_MAX_MS = 5 * 60 * 1000;

/**
 * True when the snapshot still has a built-in provider that is not `ok` — i.e.
 * a provider that could still become installed if the operator installs it. An
 * empty or partial snapshot counts as degraded. Drives whether the daemon keeps
 * a background re-probe scheduled while it stays connected.
 */
export function hasNonOkProvider(caps: ClientCapabilities): boolean {
  return PROBED_RUNTIME_PROVIDERS.some((provider) => caps[provider]?.state !== "ok");
}

/**
 * Exponential backoff for the degraded-capability re-probe loop:
 * `base * 2^attempt`, clamped to `max`.
 */
export function nextCapabilityRefreshDelayMs(attempt: number, opts: { baseMs?: number; maxMs?: number } = {}): number {
  const baseMs = opts.baseMs ?? CAPABILITY_REFRESH_BASE_MS;
  const maxMs = opts.maxMs ?? CAPABILITY_REFRESH_MAX_MS;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const exponent = Math.min(safeAttempt, 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

function errorEntry(err: unknown): CapabilityEntry {
  return {
    state: "error",
    available: false,
    // Deprecated wire-compat for older servers (see client-capabilities schema).
    authenticated: false,
    authMethod: "none",
    error: err instanceof Error ? err.message : String(err),
    detectedAt: new Date().toISOString(),
  };
}

async function aggregate(
  probes: Array<readonly [RuntimeProvider, Promise<CapabilityEntry>]>,
): Promise<ClientCapabilities> {
  const out: ClientCapabilities = {};
  await Promise.all(
    probes.map(async ([provider, p]) => {
      try {
        out[provider] = await p;
      } catch (err) {
        out[provider] = errorEntry(err);
      }
    }),
  );
  return out;
}

/**
 * Run every built-in install probe and aggregate the results. Each provider
 * gets its own module under this directory; the orchestrator is intentionally
 * simple. Detection is install-only — no binary is launched.
 */
export async function probeCapabilities(): Promise<ClientCapabilities> {
  // Guard BEFORE invoking each probe — a disabled provider must be skipped here.
  const probes: Array<readonly [RuntimeProvider, Promise<CapabilityEntry>]> = [];
  if (isRuntimeProviderEnabled("claude-code")) probes.push(["claude-code", probeClaudeCodeCapability()]);
  if (isRuntimeProviderEnabled("claude-code-tui")) probes.push(["claude-code-tui", probeClaudeCodeTuiCapability()]);
  if (isRuntimeProviderEnabled("codex")) probes.push(["codex", probeCodexCapability()]);
  if (isRuntimeProviderEnabled("cursor")) probes.push(["cursor", probeCursorCapability()]);
  return aggregate(probes);
}

/**
 * Whether a reconnect should re-detect. Detection is cheap (no launch / no
 * token spend), so a reconnect always re-detects via {@link probeCapabilities}
 * — `revalidateCapabilities` is kept as an alias so the connected-poll caller
 * (`CapabilityRefresher`) keeps a stable surface. `shouldFullReprobe` is
 * retained for callers that log which path ran; an empty or stale snapshot
 * always re-detects.
 */
export function shouldFullReprobe(
  previous: ClientCapabilities,
  now: number,
  maxAgeMs: number = REPROBE_MAX_AGE_MS,
): boolean {
  const entries = Object.values(previous).filter((e): e is CapabilityEntry => e != null);
  if (entries.length === 0) return true;
  return entries.some((e) => {
    const at = Date.parse(e.detectedAt);
    return Number.isNaN(at) || now - at > maxAgeMs;
  });
}

/**
 * Re-detect all providers. With install-only detection there is no expensive
 * smoke to preserve, so a revalidate is simply a fresh detection sweep.
 */
export async function revalidateCapabilities(_previous: ClientCapabilities): Promise<ClientCapabilities> {
  return probeCapabilities();
}

/**
 * Capability refresh for a WS reconnect. Detection is cheap, so this always
 * re-detects; `mode` is reported for log parity with the previous two-path
 * (full vs revalidate) design.
 */
export async function reprobeOnReconnect(
  _previous: ClientCapabilities,
  _opts: { now?: number; maxAgeMs?: number } = {},
): Promise<{ capabilities: ClientCapabilities; mode: "full" | "revalidate" }> {
  return { capabilities: await probeCapabilities(), mode: "full" };
}
