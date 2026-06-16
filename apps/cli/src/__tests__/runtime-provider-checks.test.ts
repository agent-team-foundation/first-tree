import type { CapabilityEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { runtimeProviderCheck, runtimeProviderChecks } from "../core/doctor.js";

/**
 * `runtimeProviderCheck(s)` turn launch-verified capability entries into the
 * doctor/`daemon probe` CheckResult rows. `ok` ⟺ the probe reached `ok`; every
 * other state surfaces the provider's own verbatim error.
 */

const entry = (over: Partial<CapabilityEntry>): CapabilityEntry => ({
  state: "ok",
  available: true,
  authenticated: true,
  authMethod: "oauth",
  detectedAt: "2026-06-15T00:00:00.000Z",
  ...over,
});

describe("runtimeProviderCheck", () => {
  it("ok entry → ok:true with auth method, runtime source, version, latency", () => {
    const res = runtimeProviderCheck(
      "codex",
      entry({ authMethod: "auth_json", runtimeSource: "bundled", sdkVersion: "0.134.0", latencyMs: 3400 }),
    );
    expect(res.ok).toBe(true);
    expect(res.label).toBe("codex");
    expect(res.detail).toBe("ok — auth_json, bundled, v0.134.0, 3400ms");
  });

  it("ok + degraded surfaces the degraded marker", () => {
    const res = runtimeProviderCheck("codex", entry({ authMethod: "auth_json", degraded: true }));
    expect(res.detail).toContain("degraded");
  });

  it("missing entry → ok:false with the verbatim provider error", () => {
    const res = runtimeProviderCheck(
      "claude-code-tui",
      entry({ state: "missing", available: false, authenticated: false, authMethod: "none", error: "tmux not found" }),
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("missing — tmux not found");
  });

  it("unauthenticated entry → ok:false carrying the login hint", () => {
    const res = runtimeProviderCheck(
      "claude-code",
      entry({
        state: "unauthenticated",
        authenticated: false,
        authMethod: "none",
        error: "Invalid API key · Please run /login",
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("unauthenticated — Invalid API key · Please run /login");
  });

  it("non-ok with no error falls back to the bare state", () => {
    const res = runtimeProviderCheck("codex", entry({ state: "error", available: false, authenticated: false }));
    expect(res.detail).toBe("error");
  });
});

describe("runtimeProviderChecks", () => {
  it("orders built-ins first, then unknown providers alphabetically", () => {
    const caps: Record<string, CapabilityEntry> = {
      "z-custom": entry({}),
      codex: entry({ authMethod: "auth_json" }),
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
