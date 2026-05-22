import { describe, expect, it } from "vitest";
import { collectProxyEnv, renderPlist, renderSystemdUnit } from "../core/service-install.js";

describe("collectProxyEnv", () => {
  it("returns empty when no proxy env vars are set", () => {
    expect(collectProxyEnv({})).toEqual({});
  });

  it("picks up lowercase keys", () => {
    expect(
      collectProxyEnv({
        https_proxy: "http://127.0.0.1:6152",
        no_proxy: "localhost,127.0.0.1",
      }),
    ).toEqual({
      https_proxy: "http://127.0.0.1:6152",
      no_proxy: "localhost,127.0.0.1",
    });
  });

  it("picks up uppercase keys", () => {
    expect(collectProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:6152" })).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:6152",
    });
  });

  it("keeps lowercase and uppercase entries side by side (libcurl/JVM prefer different cases — don't merge or guess)", () => {
    expect(
      collectProxyEnv({
        https_proxy: "http://lower:6152",
        HTTPS_PROXY: "http://upper:6152",
      }),
    ).toEqual({
      https_proxy: "http://lower:6152",
      HTTPS_PROXY: "http://upper:6152",
    });
  });

  it("skips empty-string values so a `export https_proxy=` (intentional unset) doesn't pollute the unit", () => {
    expect(
      collectProxyEnv({
        https_proxy: "",
        http_proxy: "http://127.0.0.1:6152",
      }),
    ).toEqual({ http_proxy: "http://127.0.0.1:6152" });
  });

  it("ignores unrelated env vars", () => {
    expect(
      collectProxyEnv({
        PATH: "/usr/bin",
        HOME: "/Users/me",
        FOO_PROXY: "http://foo", // not in the canonical list — ignore
      }),
    ).toEqual({});
  });
});

describe("renderPlist proxy passthrough", () => {
  const inv = { kind: "bin" as const, program: "/usr/local/bin/first-tree" };

  it("omits proxy entries entirely when no proxy env is provided", () => {
    const plist = renderPlist(inv, {});
    expect(plist).not.toMatch(/proxy/i);
  });

  it("writes one <key>/<string> pair per proxy entry inside EnvironmentVariables", () => {
    const plist = renderPlist(inv, {
      https_proxy: "http://127.0.0.1:6152",
      no_proxy: "localhost,127.0.0.1",
    });
    expect(plist).toContain("<key>https_proxy</key>");
    expect(plist).toContain("<string>http://127.0.0.1:6152</string>");
    expect(plist).toContain("<key>no_proxy</key>");
    expect(plist).toContain("<string>localhost,127.0.0.1</string>");
    // Sanity: the proxy keys live inside the EnvironmentVariables dict, not
    // as siblings of it. Cheap check: the closing </dict> for EnvironmentVariables
    // comes after the last proxy entry.
    const envOpenIdx = plist.indexOf("<key>EnvironmentVariables</key>");
    const proxyIdx = plist.indexOf("<key>https_proxy</key>");
    const runAtLoadIdx = plist.indexOf("<key>RunAtLoad</key>");
    expect(envOpenIdx).toBeGreaterThan(-1);
    expect(proxyIdx).toBeGreaterThan(envOpenIdx);
    expect(runAtLoadIdx).toBeGreaterThan(proxyIdx);
  });

  it("escapes XML special characters in proxy values (URL query strings with & must not break the plist)", () => {
    const plist = renderPlist(inv, {
      https_proxy: "http://user:pa&ss@proxy.example:8080/?x=1&y=2",
    });
    // Must produce a plist that plutil would accept — i.e. & is escaped.
    expect(plist).not.toMatch(/pa&ss/);
    expect(plist).toContain("pa&amp;ss");
    expect(plist).toContain("x=1&amp;y=2");
  });
});

describe("renderSystemdUnit proxy passthrough", () => {
  const inv = { kind: "bin" as const, program: "/usr/local/bin/first-tree" };

  it("emits no Environment= lines for proxy when no proxy env is provided", () => {
    const unit = renderSystemdUnit(inv, {});
    // No proxy-related Environment= lines at all
    expect(unit).not.toMatch(/Environment=.*proxy/i);
  });

  it("emits one Environment= line per proxy entry, ordered between PATH/FIRST_TREE_SERVICE_MODE and [Install]", () => {
    const unit = renderSystemdUnit(inv, {
      https_proxy: "http://127.0.0.1:6152",
      no_proxy: "localhost,127.0.0.1",
    });
    // Values that are safe under shellQuote() pass through unquoted.
    expect(unit).toContain("Environment=https_proxy=http://127.0.0.1:6152");
    // Comma is outside shellQuote's safe-char set, so the value is wrapped in
    // double quotes — systemd parses that correctly as one value.
    expect(unit).toContain('Environment=no_proxy="localhost,127.0.0.1"');
    // Order: proxy lines must come before [Install] (otherwise systemd treats
    // them as install-section keys, which fails to parse).
    const proxyIdx = unit.indexOf("Environment=https_proxy=");
    const installIdx = unit.indexOf("[Install]");
    expect(proxyIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(proxyIdx);
  });

  it("shell-quotes proxy values that contain shell-significant characters (otherwise systemd would mis-tokenise)", () => {
    const unit = renderSystemdUnit(inv, {
      https_proxy: "http://user pass@proxy:8080",
    });
    expect(unit).toContain('Environment=https_proxy="http://user pass@proxy:8080"');
  });
});
