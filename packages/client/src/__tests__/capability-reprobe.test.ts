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
   * Mock each provider probe to record the `deps` it was called with and echo
   * back an entry. The key assertion: an `ok`-previous provider is re-validated
   * with an injected `runSmoke` (so no real smoke runs), while a non-ok one is
   * fully re-probed (no injected smoke).
   */
  async function loadWithMocks() {
    const calls: Record<string, { deps: { runSmoke?: (b?: string) => Promise<unknown> } | undefined }> = {};
    const mk = (provider: string) =>
      vi.fn((deps?: { runSmoke?: (b?: string) => Promise<unknown> }) => {
        calls[provider] = { deps };
        return Promise.resolve(okEntry());
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

  it("re-validate injects a cached smoke for ok providers and fully re-probes non-ok ones", async () => {
    const { mod, calls } = await loadWithMocks();
    const previous: ClientCapabilities = {
      "claude-code": okEntry({ sdkVersion: "2.1.0", authMethod: "oauth" }),
      codex: okEntry({ state: "unauthenticated", available: true, authenticated: false, authMethod: "none" }),
      // claude-code-tui absent from previous → treated as non-ok → full probe.
    };

    await mod.revalidateCapabilities(previous);

    // ok provider → injected runSmoke that returns the cached ok (no real smoke)
    const claudeSmoke = calls["claude-code"]?.deps?.runSmoke;
    expect(typeof claudeSmoke).toBe("function");
    await expect(claudeSmoke?.()).resolves.toMatchObject({ state: "ok", version: "2.1.0", method: "oauth" });

    // non-ok / absent providers → full probe, no injected smoke
    expect(calls.codex?.deps?.runSmoke).toBeUndefined();
    expect(calls["claude-code-tui"]?.deps?.runSmoke).toBeUndefined();
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
