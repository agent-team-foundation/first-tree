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

/** A smoke that returns the previous `ok` outcome without launching anything —
 * the resolve + auth-precheck stages still run for real, so the provider keeps
 * its `ok` only while it remains launchable + authenticated. */
function cachedOkSmoke(entry: CapabilityEntry): () => Promise<SmokeOutcome> {
  return async () => ({
    state: "ok",
    version: entry.sdkVersion ?? null,
    method: entry.authMethod,
    ...(entry.degraded ? { degraded: true } : {}),
  });
}

/**
 * Re-validate capabilities WITHOUT spending a real smoke. Each provider's
 * resolve + auth precheck still run for real; only the smoke is short-circuited
 * to the previous `ok` result. So a provider that is still launchable + logged
 * in keeps its `ok` (and version / method) for free, while one whose binary
 * vanished now resolves to `missing` and one that logged out to
 * `unauthenticated`. Providers whose previous entry was NOT `ok` are fully
 * re-probed (a real smoke) so a recovered provider can flip back to `ok`.
 */
export async function revalidateCapabilities(previous: ClientCapabilities): Promise<ClientCapabilities> {
  const claude = previous["claude-code"];
  const tui = previous["claude-code-tui"];
  const codex = previous.codex;
  return aggregate([
    ["claude-code", probeClaudeCodeCapability(claude?.state === "ok" ? { runSmoke: cachedOkSmoke(claude) } : {})],
    ["claude-code-tui", probeClaudeCodeTuiCapability(tui?.state === "ok" ? { runSmoke: cachedOkSmoke(tui) } : {})],
    ["codex", probeCodexCapability(codex?.state === "ok" ? { runSmoke: cachedOkSmoke(codex) } : {})],
  ]);
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
