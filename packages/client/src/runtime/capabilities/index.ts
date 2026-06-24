import {
  type CapabilityEntry,
  type ClientCapabilities,
  isRuntimeProviderEnabled,
  type RuntimeProvider,
} from "@first-tree/shared";
import { probeClaudeCodeCapability } from "./claude-code.js";
import { probeClaudeCodeTuiCapability } from "./claude-code-tui.js";
import { probeCodexCapability } from "./codex.js";
import type { SmokeOutcome } from "./launch-probe.js";

/** Periodic full re-probe ceiling: an otherwise-ok client still re-runs the
 * real smoke at most this often on reconnect, to catch silent drift. */
export const REPROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The runtime providers a built-in probe exists for AND that are not
 * temporarily disabled. Used by {@link hasNonOkProvider} to decide whether a
 * daemon's advertised capability snapshot still has a provider worth re-probing
 * for. A disabled provider (see `DISABLED_RUNTIME_PROVIDERS`) is dropped here so
 * the degraded-capability re-probe loop never schedules itself just for it. */
export const PROBED_RUNTIME_PROVIDERS: readonly RuntimeProvider[] = (
  ["claude-code", "claude-code-tui", "codex"] as const
).filter((p) => isRuntimeProviderEnabled(p));

/** First delay before the daemon-side degraded-capability re-probe fires. Short
 * enough that a freshly-installed provider is noticed quickly during setup. */
export const CAPABILITY_REFRESH_BASE_MS = 15 * 1000;

/** Upper bound on the backoff between degraded-capability re-probes. Once the
 * interval reaches this ceiling it stays there, so a permanently-missing
 * provider (e.g. `claude-code-tui` on a no-tmux box) settles into a cheap,
 * low-frequency poll rather than hammering the host. */
export const CAPABILITY_REFRESH_MAX_MS = 5 * 60 * 1000;

/**
 * True when the snapshot still has a built-in provider that is not `ok` — i.e.
 * a provider that could still become usable if the operator installs / logs in.
 * An empty or partial snapshot counts as degraded (a provider that was never
 * probed is not yet `ok`). Drives whether the daemon keeps a background
 * re-probe scheduled while it stays connected.
 */
export function hasNonOkProvider(caps: ClientCapabilities): boolean {
  return PROBED_RUNTIME_PROVIDERS.some((provider) => caps[provider]?.state !== "ok");
}

/**
 * Exponential backoff for the degraded-capability re-probe loop:
 * `base * 2^attempt`, clamped to `max`. `attempt` is 0 for the first poll after
 * a state change and increments while nothing changes, so an actively-setting-up
 * machine is polled quickly and an idle degraded machine slows to the ceiling.
 */
export function nextCapabilityRefreshDelayMs(attempt: number, opts: { baseMs?: number; maxMs?: number } = {}): number {
  const baseMs = opts.baseMs ?? CAPABILITY_REFRESH_BASE_MS;
  const maxMs = opts.maxMs ?? CAPABILITY_REFRESH_MAX_MS;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // Cap the exponent so `2 ** attempt` cannot overflow to Infinity before the
  // Math.min clamp runs.
  const exponent = Math.min(safeAttempt, 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

function errorEntry(err: unknown): CapabilityEntry {
  return {
    state: "error",
    available: false,
    authenticated: false,
    sdkVersion: null,
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
 * Run every built-in capability probe and aggregate the results.
 *
 * Each provider gets its own module under this directory; the orchestrator
 * is intentionally simple — adding a new provider means importing the new
 * probe here and registering its key. The probe modules themselves are
 * deliberately not part of the `HandlerFactory` interface so capability
 * detection stays decoupled from runtime instantiation (so we can probe
 * whether a runtime is usable before spawning anything).
 */
export async function probeCapabilities(): Promise<ClientCapabilities> {
  // Guard BEFORE invoking each probe — calling the fn eagerly would spawn the
  // provider's binary, so a disabled provider must be skipped here, not filtered
  // out of the results afterwards.
  const probes: Array<readonly [RuntimeProvider, Promise<CapabilityEntry>]> = [];
  if (isRuntimeProviderEnabled("claude-code")) probes.push(["claude-code", probeClaudeCodeCapability()]);
  if (isRuntimeProviderEnabled("claude-code-tui")) probes.push(["claude-code-tui", probeClaudeCodeTuiCapability()]);
  if (isRuntimeProviderEnabled("codex")) probes.push(["codex", probeCodexCapability()]);
  return aggregate(probes);
}

/**
 * Decide whether a reconnect should run a full real re-probe of ALL providers
 * (`probeCapabilities`, a real smoke each) or the cheaper per-provider
 * `revalidateCapabilities`. Full only when the snapshot is empty or any entry
 * is older than `maxAgeMs` (a periodic real re-verification).
 *
 * A snapshot that merely contains a non-`ok` provider does NOT force a full
 * sweep: `revalidateCapabilities` already re-probes the non-ok providers in
 * full (to catch recovery) while keeping the fresh-`ok` ones on the free cached
 * path. So a common no-tmux machine — where `claude-code-tui` is permanently
 * `missing` — does not re-smoke `claude-code` + `codex` on every reconnect.
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
 * A smoke that reports `ok` WITHOUT launching a session. The resolve and
 * auth-precheck stages still run for real (those DO spawn the binary), so a
 * provider only re-validates to `ok` while it stays launchable + authenticated.
 * This `ok` is a signal, not a fresh verdict: `revalidateCapabilities`
 * preserves the prior REAL entry on `ok` rather than minting a new
 * launch-verified `ok` that never ran a smoke — so the launch-verified contract
 * is never faked.
 */
function cachedOkSmoke(): () => Promise<SmokeOutcome> {
  return async () => ({ state: "ok" });
}

/**
 * Re-validate capabilities WITHOUT spending a real smoke. Each provider's
 * resolve + auth precheck still run for real; only the session smoke is
 * skipped. The launch-verified contract is preserved by NOT fabricating a
 * fresh `ok`:
 *
 *   - a previously-`ok` provider that still passes resolve+auth keeps its
 *     PRIOR entry verbatim (its `detectedAt` / `probeKind` reflect the last
 *     real smoke — nothing about this reconnect is presented as a fresh launch);
 *   - a previously-`ok` provider whose binary vanished downgrades to a fresh
 *     `missing`, or to `unauthenticated` if it logged out (real, this cycle);
 *   - a previously-non-`ok` provider is fully re-probed (a real smoke) so a
 *     recovered provider can flip back to a genuine launch-verified `ok`.
 */
export async function revalidateCapabilities(previous: ClientCapabilities): Promise<ClientCapabilities> {
  const claude = previous["claude-code"];
  const tui = previous["claude-code-tui"];
  const codex = previous.codex;
  // Same guard as `probeCapabilities`: a disabled provider must not have its
  // probe invoked (it would re-run resolve/auth against the binary), so skip it
  // rather than filter the result.
  const probes: Array<readonly [RuntimeProvider, Promise<CapabilityEntry>]> = [];
  if (isRuntimeProviderEnabled("claude-code"))
    probes.push([
      "claude-code",
      probeClaudeCodeCapability(claude?.state === "ok" ? { runSmoke: cachedOkSmoke() } : {}),
    ]);
  if (isRuntimeProviderEnabled("claude-code-tui"))
    probes.push([
      "claude-code-tui",
      probeClaudeCodeTuiCapability(tui?.state === "ok" ? { runSmoke: cachedOkSmoke() } : {}),
    ]);
  if (isRuntimeProviderEnabled("codex"))
    probes.push(["codex", probeCodexCapability(codex?.state === "ok" ? { runSmoke: cachedOkSmoke() } : {})]);
  const revalidated = await aggregate(probes);

  // Preserve the prior real launch-verified entry wherever the provider stayed
  // `ok` (resolve+auth still pass, smoke skipped); only regressions keep the
  // freshly-probed entry. This is what keeps a re-validate from claiming a
  // launch that did not happen.
  const out: ClientCapabilities = { ...revalidated };
  for (const [provider, prev] of Object.entries(previous)) {
    if (prev?.state === "ok" && out[provider]?.state === "ok") {
      out[provider] = prev;
    }
  }
  return out;
}

/**
 * Capability refresh for a WS reconnect: a full real re-probe when
 * `shouldFullReprobe` says so, otherwise a free resolve+auth re-validate. The
 * `mode` lets the caller log which path ran.
 */
export async function reprobeOnReconnect(
  previous: ClientCapabilities,
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<{ capabilities: ClientCapabilities; mode: "full" | "revalidate" }> {
  const now = opts.now ?? Date.now();
  if (shouldFullReprobe(previous, now, opts.maxAgeMs)) {
    return { capabilities: await probeCapabilities(), mode: "full" };
  }
  return { capabilities: await revalidateCapabilities(previous), mode: "revalidate" };
}
