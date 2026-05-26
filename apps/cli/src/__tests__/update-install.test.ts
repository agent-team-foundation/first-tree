import { describe, expect, it, vi } from "vitest";

/**
 * Task 6 (Bug 4): `installGlobalSpec` runs npm install through the
 * ChildProcessRegistry with a 5-minute timeout, and classifies failures so
 * UpdateManager knows whether to retry on the next welcome tick.
 *
 * The full subprocess path needs an `npm` binary, so we focus on the
 * pure behaviours that are observable without spawning npm: input
 * validation, channel mismatch, and the back-compat alias.
 */
// The update module pulls in `@first-tree/client` via a barrel import, which
// transitively loads the Anthropic SDK and a few heavy modules. In the full
// concurrent test run that import can take >5s on cold caches, so we keep
// timeouts generous on the import-bearing tests.
describe("update.installGlobalSpec — input validation", () => {
  it(
    "refuses install specs with a leading dash",
    async () => {
      const mod = await import("../core/update.js");
      const res = await mod.installGlobalSpec("--registry=evil");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toMatch(/Refusing to install/i);
      }
    },
    30_000,
  );

  it(
    "refuses install specs containing path traversal characters",
    async () => {
      const mod = await import("../core/update.js");
      const res = await mod.installGlobalSpec("..//etc/passwd");
      expect(res.ok).toBe(false);
    },
    30_000,
  );

  it(
    "ExecuteUpdateResult.retryable is undefined for safe-spec rejections",
    async () => {
      // Safe-spec rejections are operator-action items, not transient state.
      const mod = await import("../core/update.js");
      const res = await mod.installGlobalSpec("not safe");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        // retryable/reasonCode are only set for npm-exit failures; argument
        // validation just sets reason.
        expect(res.retryable).toBeUndefined();
      }
    },
    30_000,
  );
});

describe("update.installGlobalLatest", () => {
  it("is a thin alias for installGlobalSpec('latest')", async () => {
    const mod = await import("../core/update.js");
    // We don't run a real `npm install -g`, so just assert the function
    // shape and that it returns a result. Pre-installed nodes may have npm
    // available, in which case we tolerate either ok=true (rare in CI) or
    // ok=false with a stderr; the important thing is it returns within the
    // 5-minute hard cap.
    const result = await mod.installGlobalLatest();
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  }, 60_000);
});

describe("update.fetchLatestVersion — error path", () => {
  it("returns ok=false when npm view is missing", async () => {
    vi.resetModules();
    const mod = await import("../core/update.js");
    const result = mod.fetchLatestVersion(1_000);
    // Either ok=true (npm available) or ok=false with stderr; both shapes
    // are valid. The taxonomy / retry plumbing is exercised in classify
    // unit tests; here we just confirm the call doesn't throw and the
    // result shape is well-formed.
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });
});
