import type { CapabilityEntry, ClientCapabilities } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPROBE_MAX_AGE_MS, shouldFullReprobe } from "../runtime/capabilities/index.js";

/**
 * Reconnect re-probe policy (PR-2b): on a WS reconnect the daemon either runs
 * a full real re-probe (spends a smoke) or a free resolve+auth re-validate.
 *   - full   ⟸ empty snapshot, any non-ok provider, or older than the TTL
 *   - re-validate ⟸ all-ok and fresh: resolve+auth re-run for real, but the
 *     smoke is short-circuited to the cached `ok`.
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

  it("any non-ok provider → full (it might have recovered)", () => {
    const caps: ClientCapabilities = {
      "claude-code": okEntry({ detectedAt: new Date(now).toISOString() }),
      codex: okEntry({
        state: "missing",
        available: false,
        authenticated: false,
        detectedAt: new Date(now).toISOString(),
      }),
    };
    expect(shouldFullReprobe(caps, now)).toBe(true);
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

  it("reprobeOnReconnect dispatches re-validate when all-ok+fresh, full otherwise", async () => {
    const fresh = new Date().toISOString();
    const allOkFresh: ClientCapabilities = {
      "claude-code": okEntry({ detectedAt: fresh }),
      "claude-code-tui": okEntry({ detectedAt: fresh }),
      codex: okEntry({ detectedAt: fresh }),
    };

    const reval = await loadWithMocks();
    const r1 = await reval.mod.reprobeOnReconnect(allOkFresh);
    expect(r1.mode).toBe("revalidate");
    expect(reval.calls.codex?.deps?.runSmoke).toBeTypeOf("function"); // cached smoke injected

    const full = await loadWithMocks();
    const withMissing: ClientCapabilities = { codex: okEntry({ state: "missing", available: false }) };
    const r2 = await full.mod.reprobeOnReconnect(withMissing);
    expect(r2.mode).toBe("full");
    expect(full.calls.codex?.deps?.runSmoke).toBeUndefined(); // full probe, no injection
  });
});
