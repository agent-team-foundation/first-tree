import type { CapabilityEntry, ClientCapabilities, RuntimeProvider } from "@first-tree/shared";
import { probeClaudeCodeCapability } from "./claude-code.js";
import { probeClaudeCodeTuiCapability } from "./claude-code-tui.js";
import { probeCodexCapability } from "./codex.js";
import type { SmokeOutcome } from "./launch-probe.js";

/** Periodic full re-probe ceiling: an otherwise-ok client still re-runs the
 * real smoke at most this often on reconnect, to catch silent drift. */
export const REPROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  return aggregate([
    ["claude-code", probeClaudeCodeCapability()],
    ["claude-code-tui", probeClaudeCodeTuiCapability()],
    ["codex", probeCodexCapability()],
  ]);
}

/**
 * Decide whether a reconnect should run a full real re-probe (spends a smoke)
 * or a free resolve+auth re-validate. Full when the previous snapshot is
 * empty, has any non-`ok` provider (it might have recovered), or is older than
 * `maxAgeMs` (periodic refresh); otherwise the cheaper re-validate suffices.
 */
export function shouldFullReprobe(
  previous: ClientCapabilities,
  now: number,
  maxAgeMs: number = REPROBE_MAX_AGE_MS,
): boolean {
  const entries = Object.values(previous).filter((e): e is CapabilityEntry => e != null);
  if (entries.length === 0) return true;
  if (entries.some((e) => e.state !== "ok")) return true;
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
  const revalidated = await aggregate([
    ["claude-code", probeClaudeCodeCapability(claude?.state === "ok" ? { runSmoke: cachedOkSmoke() } : {})],
    ["claude-code-tui", probeClaudeCodeTuiCapability(tui?.state === "ok" ? { runSmoke: cachedOkSmoke() } : {})],
    ["codex", probeCodexCapability(codex?.state === "ok" ? { runSmoke: cachedOkSmoke() } : {})],
  ]);

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
