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
 * Reconnect re-probe policy (install-only): detection is cheap (no launch / no
 * token spend), so a reconnect ALWAYS re-detects.
 *   - `revalidateCapabilities` / `reprobeOnReconnect` just run a fresh detection
 *     sweep; `reprobeOnReconnect` always reports `mode: "full"`.
 *   - `shouldFullReprobe` is retained for log parity: empty snapshot OR any
 *     entry older than the TTL.
 *   - `hasNonOkProvider` is true when any enabled built-in provider is not `ok`.
 */

const okEntry = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "ok",
  available: true,
  sdkVersion: "1.2.3",
  detectedAt: new Date().toISOString(),
  ...over,
});

describe("shouldFullReprobe", () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");

  it("empty snapshot → full", () => {
    expect(shouldFullReprobe({}, now)).toBe(true);
  });

  it("a non-ok-but-fresh provider does NOT force a full sweep (age, not state, decides)", () => {
    const fresh = new Date(now - 60_000).toISOString();
    const caps: ClientCapabilities = {
      "claude-code": okEntry({ detectedAt: fresh }),
      codex: okEntry({ state: "missing", available: false, detectedAt: fresh }),
    };
    expect(shouldFullReprobe(caps, now)).toBe(false);
  });

  it("all-ok but older than the TTL → full (periodic refresh)", () => {
    const stale = new Date(now - REPROBE_MAX_AGE_MS - 1).toISOString();
    expect(shouldFullReprobe({ codex: okEntry({ detectedAt: stale }) }, now)).toBe(true);
  });

  it("all-ok and fresh → not full", () => {
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

  it("a partial snapshot missing an enabled provider is degraded", () => {
    // codex is absent → still degraded (claude-code-tui is disabled, so ignored).
    expect(hasNonOkProvider({ "claude-code": okEntry() })).toBe(true);
  });

  it("all enabled built-in providers ok → not degraded (stops the poll)", () => {
    // claude-code-tui is disabled, so claude-code + codex + cursor must be ok.
    expect(
      hasNonOkProvider({
        "claude-code": okEntry(),
        codex: okEntry(),
        cursor: okEntry(),
      }),
    ).toBe(false);
  });

  it("any non-ok enabled provider keeps it degraded", () => {
    expect(
      hasNonOkProvider({
        "claude-code": okEntry(),
        codex: okEntry({ state: "missing", available: false }),
      }),
    ).toBe(true);
  });

  it("an `error` enabled provider keeps it degraded", () => {
    expect(
      hasNonOkProvider({
        "claude-code": okEntry(),
        codex: okEntry({ state: "error", available: false, error: "boom" }),
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
   * Mock each provider probe to RECORD that it was invoked and return a
   * configurable entry (default: a generic `ok`). Install-only detection re-runs
   * every probe unconditionally — there is no deps injection or preserve logic
   * to assert anymore, so the tests just verify a fresh sweep ran.
   */
  async function loadWithMocks(results: Record<string, CapabilityEntry> = {}) {
    const calls: Record<string, number> = {};
    const mk = (provider: string) =>
      vi.fn(() => {
        calls[provider] = (calls[provider] ?? 0) + 1;
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

  it("revalidateCapabilities re-detects every enabled provider", async () => {
    const { mod, calls } = await loadWithMocks();

    const out = await mod.revalidateCapabilities({
      "claude-code": okEntry({ sdkVersion: "2.1.0" }),
      codex: okEntry({ state: "missing", available: false }),
    });

    // Fresh detection sweep ran for both enabled providers; result reflects the
    // fresh probe output, not the previous snapshot.
    expect(calls["claude-code"]).toBe(1);
    expect(calls.codex).toBe(1);
    expect(out["claude-code"]?.state).toBe("ok");
    expect(out.codex?.state).toBe("ok");
    // claude-code-tui is disabled → never probed, no entry.
    expect(calls["claude-code-tui"]).toBeUndefined();
    expect(out["claude-code-tui"]).toBeUndefined();
  });

  it("revalidateCapabilities returns the fresh entry even when a provider regresses", async () => {
    const missing: CapabilityEntry = {
      state: "missing",
      available: false,
      error: "codex binary not found",
      detectedAt: new Date().toISOString(),
    };
    const { mod } = await loadWithMocks({ codex: missing });
    const out = await mod.revalidateCapabilities({ codex: okEntry() });
    expect(out.codex).toEqual(missing);
  });

  it("reprobeOnReconnect always re-detects and reports mode=full", async () => {
    const fresh = new Date().toISOString();
    const allOkFresh: ClientCapabilities = {
      "claude-code": okEntry({ detectedAt: fresh }),
      codex: okEntry({ detectedAt: fresh }),
    };

    const reval = await loadWithMocks();
    const res = await reval.mod.reprobeOnReconnect(allOkFresh);
    expect(res.mode).toBe("full");
    expect(reval.calls["claude-code"]).toBe(1);
    expect(reval.calls.codex).toBe(1);

    // Empty snapshot → still re-detects, mode=full.
    const empty = await loadWithMocks();
    expect((await empty.mod.reprobeOnReconnect({})).mode).toBe("full");
    expect(empty.calls.codex).toBe(1);
  });
});
