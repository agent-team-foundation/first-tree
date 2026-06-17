import type { CapabilityEntry, ClientCapabilities } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_REFRESH_BASE_MS,
  CAPABILITY_REFRESH_MAX_MS,
  hasNonOkProvider,
  nextCapabilityRefreshDelayMs,
  REPROBE_MAX_AGE_MS,
  shouldFullReprobe,
} from "../runtime/capabilities/index.js";

/**
 * Reconnect re-probe policy (PR-2b): on a WS reconnect the daemon either runs
 * a full real re-probe of all providers (spends a smoke each) or a per-provider
 * re-validate.
 *   - full       ⟸ empty snapshot OR any entry older than the TTL
 *   - re-validate ⟸ otherwise (incl. a snapshot that merely has a non-ok
 *     provider): each fresh-ok provider re-runs resolve+auth for real but the
 *     smoke is short-circuited to the cached `ok` and its prior entry is kept;
 *     a non-ok provider is fully re-probed so it can recover.
 */

const okEntry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "ok",
  available: true,
  authenticated: true,
  authMethod: "oauth",
  sdkVersion: "1.2.3",
  detectedAt: new Date().toISOString(),
  ...over,
});

describe("shouldFullReprobe", () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");

  it("empty snapshot → full", () => {
    expect(shouldFullReprobe({}, now)).toBe(true);
  });

  it("a non-ok-but-fresh provider does NOT force a full sweep (revalidate handles it per-provider)", () => {
    const fresh = new Date(now - 60_000).toISOString();
    const caps: ClientCapabilities = {
      "claude-code": okEntry({ detectedAt: fresh }),
      codex: okEntry({ state: "missing", available: false, authenticated: false, detectedAt: fresh }),
    };
    expect(shouldFullReprobe(caps, now)).toBe(false);
  });

  it("all-ok but older than the TTL → full (periodic refresh)", () => {
    const stale = new Date(now - REPROBE_MAX_AGE_MS - 1).toISOString();
    expect(shouldFullReprobe({ codex: okEntry({ detectedAt: stale }) }, now)).toBe(true);
  });

  it("all-ok and fresh → re-validate (not full)", () => {
    const fresh = new Date(now - 60_000).toISOString();
    const caps: ClientCapabilities = {
      "claude-code": okEntry({ detectedAt: fresh }),
      codex: okEntry({ detectedAt: fresh }),
    };
    expect(shouldFullReprobe(caps, now)).toBe(false);
  });

  it("unparseable detectedAt → full (treat as unknown age)", () => {
    expect(shouldFullReprobe({ codex: okEntry({ detectedAt: "not-a-date" }) }, now)).toBe(true);
  });
});

describe("hasNonOkProvider", () => {
  it("empty snapshot is degraded (no provider has reached ok yet)", () => {
    expect(hasNonOkProvider({})).toBe(true);
  });

  it("a partial snapshot missing a built-in provider is degraded", () => {
    // claude-code-tui + codex are absent → still degraded.
    expect(hasNonOkProvider({ "claude-code": okEntry() })).toBe(true);
  });

  it("all built-in providers ok → not degraded (stops the poll)", () => {
    expect(
      hasNonOkProvider({
        "claude-code": okEntry(),
        "claude-code-tui": okEntry(),
        codex: okEntry(),
      }),
    ).toBe(false);
  });

  it("any non-ok built-in provider keeps it degraded", () => {
    expect(
      hasNonOkProvider({
        "claude-code": okEntry(),
        "claude-code-tui": okEntry(),
        codex: okEntry({ state: "unauthenticated", authenticated: false }),
      }),
    ).toBe(true);
  });
});

describe("nextCapabilityRefreshDelayMs", () => {
  it("first poll uses the base delay", () => {
    expect(nextCapabilityRefreshDelayMs(0)).toBe(CAPABILITY_REFRESH_BASE_MS);
  });

  it("doubles per attempt", () => {
    expect(nextCapabilityRefreshDelayMs(1)).toBe(CAPABILITY_REFRESH_BASE_MS * 2);
    expect(nextCapabilityRefreshDelayMs(2)).toBe(CAPABILITY_REFRESH_BASE_MS * 4);
  });

  it("clamps to the ceiling and never overflows", () => {
    expect(nextCapabilityRefreshDelayMs(100)).toBe(CAPABILITY_REFRESH_MAX_MS);
    expect(Number.isFinite(nextCapabilityRefreshDelayMs(1000))).toBe(true);
  });

  it("treats negative / non-finite attempts as the first poll", () => {
    expect(nextCapabilityRefreshDelayMs(-5)).toBe(CAPABILITY_REFRESH_BASE_MS);
    expect(nextCapabilityRefreshDelayMs(Number.NaN)).toBe(CAPABILITY_REFRESH_BASE_MS);
  });

  it("honors injected base/max overrides", () => {
    expect(nextCapabilityRefreshDelayMs(3, { baseMs: 1000, maxMs: 4000 })).toBe(4000);
    expect(nextCapabilityRefreshDelayMs(1, { baseMs: 1000, maxMs: 8000 })).toBe(2000);
  });
});

describe("revalidateCapabilities / reprobeOnReconnect (probe modules mocked)", () => {
  afterEach(() => {
    vi.doUnmock("../runtime/capabilities/claude-code.js");
    vi.doUnmock("../runtime/capabilities/claude-code-tui.js");
    vi.doUnmock("../runtime/capabilities/codex.js");
    vi.resetModules();
  });

  /**
   * Mock each provider probe to record the `deps` it was called with and return
   * a configurable entry (default: a generic `ok`). Lets us assert both the
   * injected-smoke wiring and the preserve-vs-downgrade substitution.
   */
  async function loadWithMocks(results: Record<string, CapabilityEntry> = {}) {
    const calls: Record<string, { deps: { runSmoke?: (b?: string) => Promise<unknown> } | undefined }> = {};
    const mk = (provider: string) =>
      vi.fn((deps?: { runSmoke?: (b?: string) => Promise<unknown> }) => {
        calls[provider] = { deps };
        return Promise.resolve(results[provider] ?? okEntry());
      });
    vi.resetModules();
    vi.doMock("../runtime/capabilities/claude-code.js", () => ({ probeClaudeCodeCapability: mk("claude-code") }));
    vi.doMock("../runtime/capabilities/claude-code-tui.js", () => ({
      probeClaudeCodeTuiCapability: mk("claude-code-tui"),
    }));
    vi.doMock("../runtime/capabilities/codex.js", () => ({ probeCodexCapability: mk("codex") }));
    const mod = await import("../runtime/capabilities/index.js");
    return { mod, calls };
  }

  it("injects a no-launch cached smoke for ok providers and fully re-probes non-ok ones", async () => {
    const { mod, calls } = await loadWithMocks();
    const previous: ClientCapabilities = {
      "claude-code": okEntry({ sdkVersion: "2.1.0", authMethod: "oauth" }),
      codex: okEntry({ state: "unauthenticated", available: true, authenticated: false, authMethod: "none" }),
      // claude-code-tui absent from previous → treated as non-ok → full probe.
    };

    await mod.revalidateCapabilities(previous);

    // ok provider → injected runSmoke; it reports ok WITHOUT launching a session
    const claudeSmoke = calls["claude-code"]?.deps?.runSmoke;
    expect(typeof claudeSmoke).toBe("function");
    await expect(claudeSmoke?.()).resolves.toEqual({ state: "ok" });

    // non-ok / absent providers → full probe, no injected smoke
    expect(calls.codex?.deps?.runSmoke).toBeUndefined();
    expect(calls["claude-code-tui"]?.deps?.runSmoke).toBeUndefined();
  });

  it("preserves the prior entry verbatim when an ok provider stays ok (no fabricated fresh launch)", async () => {
    const prevClaude = okEntry({
      sdkVersion: "2.1.0",
      authMethod: "oauth",
      detectedAt: "2026-06-01T00:00:00.000Z",
      probeKind: "launch",
    });
    // The mock returns a DIFFERENT, would-be-fresh ok; the result must still be
    // the PRIOR entry (original detectedAt / version), never the fresh one.
    const { mod } = await loadWithMocks({
      "claude-code": okEntry({ sdkVersion: "9.9.9", detectedAt: new Date().toISOString() }),
    });
    const out = await mod.revalidateCapabilities({ "claude-code": prevClaude });
    expect(out["claude-code"]).toEqual(prevClaude);
  });

  it("downgrades (does NOT preserve) when an ok provider regresses", async () => {
    const prevCodex = okEntry({ detectedAt: "2026-06-01T00:00:00.000Z" });
    const missing: CapabilityEntry = {
      state: "missing",
      available: false,
      authenticated: false,
      authMethod: "none",
      error: "codex binary not found",
      detectedAt: new Date().toISOString(),
    };
    const { mod } = await loadWithMocks({ codex: missing });
    const out = await mod.revalidateCapabilities({ codex: prevCodex });
    expect(out.codex).toEqual(missing);
  });

  it("reprobeOnReconnect dispatches re-validate when fresh, full only when empty/stale", async () => {
    const fresh = new Date().toISOString();
    const allOkFresh: ClientCapabilities = {
      "claude-code": okEntry({ detectedAt: fresh }),
      "claude-code-tui": okEntry({ detectedAt: fresh }),
      codex: okEntry({ detectedAt: fresh }),
    };

    const reval = await loadWithMocks();
    expect((await reval.mod.reprobeOnReconnect(allOkFresh)).mode).toBe("revalidate");
    expect(reval.calls.codex?.deps?.runSmoke).toBeTypeOf("function"); // cached smoke injected

    // Empty snapshot → full.
    const full = await loadWithMocks();
    expect((await full.mod.reprobeOnReconnect({})).mode).toBe("full");

    // Stale (past TTL) → full.
    const stale = await loadWithMocks();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect((await stale.mod.reprobeOnReconnect({ codex: okEntry({ detectedAt: old }) })).mode).toBe("full");
    expect(stale.calls.codex?.deps?.runSmoke).toBeUndefined(); // full probe, no injection
  });

  it("cost control: an optional provider missing does NOT full-smoke the fresh-ok providers on reconnect", async () => {
    const fresh = new Date().toISOString();
    // Common no-tmux box: TUI permanently missing, claude-code + codex ok & fresh.
    const previous: ClientCapabilities = {
      "claude-code": okEntry({ detectedAt: fresh }),
      codex: okEntry({ detectedAt: fresh }),
      "claude-code-tui": okEntry({ state: "missing", available: false, authenticated: false, detectedAt: fresh }),
    };

    const { mod, calls } = await loadWithMocks();
    const { mode } = await mod.reprobeOnReconnect(previous);

    expect(mode).toBe("revalidate");
    // fresh-ok providers re-validated for free (cached smoke injected, no real smoke)
    expect(calls["claude-code"]?.deps?.runSmoke).toBeTypeOf("function");
    expect(calls.codex?.deps?.runSmoke).toBeTypeOf("function");
    // the missing optional provider IS fully re-probed (to catch recovery), no cached smoke
    expect(calls["claude-code-tui"]?.deps?.runSmoke).toBeUndefined();
  });
});
