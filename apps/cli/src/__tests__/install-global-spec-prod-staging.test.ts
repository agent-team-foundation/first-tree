import { describe, expect, it, vi } from "vitest";

/**
 * §9 channel-mismatch guard — prod and staging coverage.
 *
 * `install-global-spec-channel.test.ts` exercises the source tree, where
 * `channelConfig.channel === "dev"` and `packageName === null` — so it
 * only proves the dev bailout. The actual cross-channel guard
 * (refusing a `-staging.X.Y` target on a prod CLI, refusing a stable
 * `X.Y.Z` target on a staging CLI) runs only when packageName is non-null.
 *
 * `vi.doMock("../core/channel.js")` flips `channelConfig` to the target
 * channel before each test's dynamic import, so the same guard code path
 * is exercised under prod / staging identity without rebuilding.
 *
 * Why only the refusal cases are tested here: the guard short-circuits
 * to `{ ok: false }` before `npm install` is touched, which keeps the
 * sandbox hermetic. The matching-channel "accept" path would fall
 * through to `npm install -g <pkg>@<ver>` and hang in CI (no npm
 * registry reachable). Spec-validation acceptance for matching channels
 * is covered indirectly via `install-global-spec.test.ts` (regex layer)
 * and `channel.test.ts` (inferChannelFromVersion).
 */
const PROD_MOCK = {
  channelConfig: {
    channel: "prod" as const,
    binName: "first-tree",
    aliasName: "ft",
    packageName: "first-tree",
    defaultHome: "/tmp/fake-home/.first-tree",
    defaultServerUrl: "https://cloud.first-tree.ai",
    serviceUnitFile: "first-tree.service",
    launchdLabel: "first-tree",
    launchdPlistFile: "first-tree.plist",
  },
};

const STAGING_MOCK = {
  channelConfig: {
    channel: "staging" as const,
    binName: "first-tree-staging",
    aliasName: "fts",
    packageName: "first-tree-staging",
    defaultHome: "/tmp/fake-home/.first-tree-staging",
    defaultServerUrl: "https://dev.cloud.first-tree.ai",
    serviceUnitFile: "first-tree-staging.service",
    launchdLabel: "first-tree-staging",
    launchdPlistFile: "first-tree-staging.plist",
  },
};

describe("§9 channel-mismatch guard — prod CLI", () => {
  it("refuses a staging-shaped version", async () => {
    vi.resetModules();
    vi.doMock("../core/channel.js", () => PROD_MOCK);
    const { installGlobalSpec } = await import("../core/update.js");
    const result = await installGlobalSpec("0.5.2-staging.42.1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/target channel "staging" does not match my channel "prod"/i);
    }
  }, 30_000);

  it("refuses unknown prerelease formats (fail-closed)", async () => {
    vi.resetModules();
    vi.doMock("../core/channel.js", () => PROD_MOCK);
    const { installGlobalSpec } = await import("../core/update.js");
    for (const spec of ["0.5.2-beta.1", "0.5.2-rc.1", "0.5.2-alpha.42.1"]) {
      const result = await installGlobalSpec(spec);
      expect(result.ok, `expected refusal for ${spec}`).toBe(false);
      if (!result.ok) {
        expect(result.reason, `reason for ${spec}`).toMatch(/target channel "unknown"/i);
      }
    }
  }, 30_000);
});

describe("§9 channel-mismatch guard — staging CLI", () => {
  it("refuses a stable prod version", async () => {
    vi.resetModules();
    vi.doMock("../core/channel.js", () => STAGING_MOCK);
    const { installGlobalSpec } = await import("../core/update.js");
    const result = await installGlobalSpec("0.5.1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/target channel "prod" does not match my channel "staging"/i);
    }
  }, 30_000);

  it("refuses an unknown-channel prerelease", async () => {
    vi.resetModules();
    vi.doMock("../core/channel.js", () => STAGING_MOCK);
    const { installGlobalSpec } = await import("../core/update.js");
    const result = await installGlobalSpec("0.5.2-rc.1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/target channel "unknown" does not match my channel "staging"/i);
    }
  }, 30_000);
});
