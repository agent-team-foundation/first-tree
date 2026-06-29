import type { CapabilityEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { runtimeProviderCheck, runtimeProviderChecks } from "../core/doctor.js";

/**
 * `runtimeProviderCheck(s)` turn install-only capability entries into the
 * doctor/`daemon probe` CheckResult rows. `ok` ⟺ the binary is installed; every
 * other state surfaces the resolver's own verbatim error.
 */

const entry = (over: Partial<CapabilityEntry>): CapabilityEntry => ({
  state: "ok",
  available: true,
  detectedAt: "2026-06-15T00:00:00.000Z",
  ...over,
});

describe("runtimeProviderCheck", () => {
  it("ok entry → ok:true with installed marker, runtime source, version, latency", () => {
    const res = runtimeProviderCheck(
      "codex",
      entry({ runtimeSource: "bundled", sdkVersion: "0.134.0", latencyMs: 3400 }),
    );
    expect(res.ok).toBe(true);
    expect(res.label).toBe("codex");
    expect(res.detail).toBe("ok — installed, bundled, v0.134.0, 3400ms");
  });

  // Removed: the `degraded` marker no longer exists — detection is install-only
  // and reports no auth/usability degradation.

  it("missing entry → ok:false with the verbatim provider error", () => {
    const res = runtimeProviderCheck(
      "claude-code-tui",
      entry({ state: "missing", available: false, error: "tmux not found" }),
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("missing — tmux not found");
  });

  // Removed: the `unauthenticated` state no longer exists — an installed
  // provider is `ok` regardless of login, and auth is discovered at run time.

  it("non-ok with no error falls back to the bare state", () => {
    const res = runtimeProviderCheck("codex", entry({ state: "error", available: false }));
    expect(res.detail).toBe("error");
  });
});

describe("runtimeProviderChecks", () => {
  it("orders built-ins first, then unknown providers alphabetically", () => {
    const caps: Record<string, CapabilityEntry> = {
      "z-custom": entry({}),
      codex: entry({ runtimeSource: "bundled" }),
      "a-custom": entry({}),
      "claude-code": entry({}),
    };
    expect(runtimeProviderChecks(caps).map((r) => r.label)).toEqual(["claude-code", "codex", "a-custom", "z-custom"]);
  });

  it("empty snapshot → a single not-ok placeholder row", () => {
    expect(runtimeProviderChecks({})).toEqual([
      { label: "Runtime providers", ok: false, detail: "no providers probed" },
    ]);
  });

  it("skips undefined entries", () => {
    const caps: Record<string, CapabilityEntry | undefined> = { codex: entry({}), missing: undefined };
    const out = runtimeProviderChecks(caps);
    expect(out.map((r) => r.label)).toEqual(["codex"]);
  });
});
