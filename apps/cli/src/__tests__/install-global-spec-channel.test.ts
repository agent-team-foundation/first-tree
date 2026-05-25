import { describe, expect, it } from "vitest";
import { channelConfig } from "../core/channel.js";
import { installGlobalSpec } from "../core/update.js";

/**
 * Multi-env channel-mismatch guard: `installGlobalSpec` refuses to install
 * a concrete version whose inferred channel does not match this binary's
 * channel. Source-tree `CHANNEL = "dev"` means `PACKAGE_NAME === null`,
 * so the early dev-bailout fires before the guard. These tests exercise
 * the bailout — channel matrix coverage of the guard itself lives in
 * `packages/shared/src/__tests__/channel.test.ts`
 * (`inferChannelFromVersion`).
 */
describe("installGlobalSpec — channel guard (dev source tree)", () => {
  it("refuses any install on dev channel with the 'not published' reason", async () => {
    expect(channelConfig.channel).toBe("dev");
    expect(channelConfig.packageName).toBeNull();
    const result = await installGlobalSpec("0.5.1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mode).toBe("global");
      expect(result.reason).toMatch(/self-update disabled/i);
    }
  });

  it("refuses staging-shaped version on dev channel", async () => {
    const result = await installGlobalSpec("0.5.2-staging.42.1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/self-update disabled/i);
    }
  });

  it("still rejects malformed specs before reaching the dev bailout", async () => {
    const result = await installGlobalSpec("0.5.1;rm");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid npm spec/i);
    }
  });
});
