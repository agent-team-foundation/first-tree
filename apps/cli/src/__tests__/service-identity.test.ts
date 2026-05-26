import { getChannelConfig } from "@first-tree/shared/channel";
import { describe, expect, it } from "vitest";

/**
 * Multi-env contract: every channel owns its own service unit + launchd
 * label, and those identifiers are derived purely from `getChannelConfig`.
 * If service-install.ts's identifiers ever drift from this table, two
 * channels can collide on a single `first-tree-client.service` again.
 */
describe("channel → service identity", () => {
  it("prod uses bare names", () => {
    const c = getChannelConfig("prod");
    expect(c.serviceUnitFile).toBe("first-tree.service");
    expect(c.launchdLabel).toBe("first-tree");
    expect(c.launchdPlistFile).toBe("first-tree.plist");
  });

  it("staging uses -staging suffixed names", () => {
    const c = getChannelConfig("staging");
    expect(c.serviceUnitFile).toBe("first-tree-staging.service");
    expect(c.launchdLabel).toBe("first-tree-staging");
    expect(c.launchdPlistFile).toBe("first-tree-staging.plist");
  });

  it("dev uses -dev suffixed names", () => {
    const c = getChannelConfig("dev");
    expect(c.serviceUnitFile).toBe("first-tree-dev.service");
    expect(c.launchdLabel).toBe("first-tree-dev");
    expect(c.launchdPlistFile).toBe("first-tree-dev.plist");
  });

  it("three channels never collide on the same service unit", () => {
    const units = (["dev", "staging", "prod"] as const).map((ch) => getChannelConfig(ch).serviceUnitFile);
    expect(new Set(units).size).toBe(units.length);
  });
});
