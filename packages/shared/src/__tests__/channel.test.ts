import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ChannelName, getChannelConfig, getServerCliBinding, inferChannelFromVersion } from "../channel/index.js";
import { resetConfig, setConfig } from "../config/singleton.js";

describe("getChannelConfig", () => {
  it("maps prod to the bare bin / package / home / cloud server", () => {
    const c = getChannelConfig("prod");
    expect(c).toEqual({
      channel: "prod",
      binName: "first-tree",
      aliasName: "ft",
      packageName: "first-tree",
      defaultHome: join(homedir(), ".first-tree"),
      defaultServerUrl: "https://cloud.first-tree.ai",
      serviceUnitFile: "first-tree.service",
      launchdLabel: "first-tree",
      launchdPlistFile: "first-tree.plist",
    });
  });

  it("maps staging to the -staging suffixed names + dev cloud URL", () => {
    const c = getChannelConfig("staging");
    expect(c.binName).toBe("first-tree-staging");
    expect(c.aliasName).toBe("fts");
    expect(c.packageName).toBe("first-tree-staging");
    expect(c.defaultHome).toBe(join(homedir(), ".first-tree-staging"));
    expect(c.defaultServerUrl).toBe("https://dev.cloud.first-tree.ai");
    expect(c.serviceUnitFile).toBe("first-tree-staging.service");
    expect(c.launchdLabel).toBe("first-tree-staging");
    expect(c.launchdPlistFile).toBe("first-tree-staging.plist");
  });

  it("maps dev to packageName=null + 127.0.0.1 server", () => {
    const c = getChannelConfig("dev");
    expect(c.packageName).toBeNull();
    expect(c.binName).toBe("first-tree-dev");
    expect(c.aliasName).toBe("ftd");
    expect(c.defaultHome).toBe(join(homedir(), ".first-tree-dev"));
    expect(c.defaultServerUrl).toBe("http://127.0.0.1:8000");
    expect(c.serviceUnitFile).toBe("first-tree-dev.service");
    expect(c.launchdLabel).toBe("first-tree-dev");
  });

  it("never returns the same defaultHome for two distinct channels", () => {
    const channels: ChannelName[] = ["dev", "staging", "prod"];
    const homes = channels.map((c) => getChannelConfig(c).defaultHome);
    expect(new Set(homes).size).toBe(channels.length);
  });
});

describe("getServerCliBinding", () => {
  // Singleton is process-level; restore between cases so a `setConfig` here
  // doesn't leak into the inferChannelFromVersion suite (or vice versa).
  afterEach(() => {
    resetConfig();
  });

  it("returns the channel-resolved binding from the active server config", () => {
    setConfig({ channel: "staging" });
    expect(getServerCliBinding().binName).toBe("first-tree-staging");
    expect(getServerCliBinding().packageName).toBe("first-tree-staging");

    setConfig({ channel: "dev" });
    expect(getServerCliBinding().binName).toBe("first-tree-dev");
    expect(getServerCliBinding().packageName).toBeNull();

    setConfig({ channel: "prod" });
    expect(getServerCliBinding().binName).toBe("first-tree");
    expect(getServerCliBinding().packageName).toBe("first-tree");
  });

  it("throws when called before initConfig — must not silently default to prod", () => {
    // Regression guard for the multi-env footgun: a silent fallback (e.g.
    // `getConfig().channel ?? "prod"`) would have staging servers tell
    // clients to install the prod tarball before config init finishes.
    // Fail-loud is the right default.
    resetConfig();
    expect(() => getServerCliBinding()).toThrow(/Config not initialized/);
  });
});

describe("inferChannelFromVersion", () => {
  it("recognises plain semver as prod", () => {
    expect(inferChannelFromVersion("0.5.1")).toBe("prod");
    expect(inferChannelFromVersion("1.0.0")).toBe("prod");
    expect(inferChannelFromVersion("10.20.30")).toBe("prod");
  });

  it("recognises -staging.<run>.<attempt> as staging", () => {
    expect(inferChannelFromVersion("0.5.2-staging.42.1")).toBe("staging");
    expect(inferChannelFromVersion("1.0.0-staging.123.4")).toBe("staging");
  });

  it("fails closed on legacy alpha", () => {
    expect(inferChannelFromVersion("0.5.2-alpha.42.1")).toBe("unknown");
  });

  it("fails closed on other prereleases", () => {
    expect(inferChannelFromVersion("0.5.2-beta.1")).toBe("unknown");
    expect(inferChannelFromVersion("0.5.2-rc.1")).toBe("unknown");
    expect(inferChannelFromVersion("0.5.2-staging")).toBe("unknown"); // missing .X.Y
    expect(inferChannelFromVersion("latest")).toBe("unknown");
    expect(inferChannelFromVersion("")).toBe("unknown");
  });

  it("fails closed on malformed input", () => {
    expect(inferChannelFromVersion("0.5")).toBe("unknown");
    expect(inferChannelFromVersion("v0.5.1")).toBe("unknown");
    expect(inferChannelFromVersion("0.5.1.2")).toBe("unknown");
  });
});
