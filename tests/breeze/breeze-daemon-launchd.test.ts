import { describe, expect, it } from "vitest";

import {
  escapeXml,
  launchdLabel,
  launchdPlistPath,
  renderLaunchdPlist,
} from "../../src/products/breeze/engine/daemon/launchd.js";

describe("launchdLabel", () => {
  it("sanitizes login and profile into a dotted reverse-dns label", () => {
    expect(launchdLabel("bingran-you", "default")).toBe(
      "com.breeze.runner.bingran-you.default",
    );
  });

  it("replaces filesystem-unsafe characters", () => {
    expect(launchdLabel("alice@home", "prof/test")).toBe(
      "com.breeze.runner.alice_home.prof_test",
    );
  });
});

describe("launchdPlistPath", () => {
  it("lives under <runnerHome>/launchd/<label>.plist", () => {
    const label = launchdLabel("alice", "default");
    expect(launchdPlistPath("/var/home/runner", label)).toBe(
      `/var/home/runner/launchd/${label}.plist`,
    );
  });
});

describe("escapeXml", () => {
  it("escapes the five predefined XML entities", () => {
    expect(escapeXml(`a&b<c>d"e'`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;");
  });
});

describe("renderLaunchdPlist", () => {
  it("produces a well-formed plist with KeepAlive and RunAtLoad", () => {
    const xml = renderLaunchdPlist({
      login: "alice",
      profile: "default",
      executable: "/usr/local/bin/first-tree",
      arguments: ["breeze", "daemon", "--backend=ts"],
      logPath: "/tmp/breeze.log",
      env: { PATH: "/opt/bin", HOME: "/Users/alice" },
    });
    expect(xml).toContain("<string>com.breeze.runner.alice.default</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain(
      "<string>/usr/local/bin/first-tree</string>",
    );
    expect(xml).toContain("<string>breeze</string>");
    expect(xml).toContain("<string>--backend=ts</string>");
    expect(xml).toContain("<string>/tmp/breeze.log</string>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>/opt/bin</string>");
    expect(xml).toContain("<key>HOME</key>");
    expect(xml).toContain("<string>/Users/alice</string>");
  });

  it("escapes special characters inside arguments and env values", () => {
    const xml = renderLaunchdPlist({
      login: "alice",
      profile: "default",
      executable: "/usr/local/bin/first-tree",
      arguments: ["--note", "hello <world> & 'friends'"],
      logPath: "/tmp/x",
      env: { PATH: "/a", HOME: "/b" },
    });
    expect(xml).toContain("hello &lt;world&gt; &amp; &apos;friends&apos;");
  });
});
