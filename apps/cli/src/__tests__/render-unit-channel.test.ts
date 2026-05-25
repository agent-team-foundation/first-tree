import { defaultHome } from "@first-tree/shared/config";
import { describe, expect, it } from "vitest";
import { channelConfig } from "../core/channel.js";
import { renderPlist, renderSystemdUnit } from "../core/service-install.js";

/**
 * Lock the channel → unit-file contract at the unit-template layer.
 *
 * Today's source tree is `CHANNEL=dev`, so the rendered unit / plist
 * must reference `first-tree-dev.service` / `first-tree-dev` and embed
 * the dev channel's home as `FIRST_TREE_HOME`. CI publishes for prod /
 * staging rewrite `build-info.ts`, so this test couples assertions to
 * whatever `channelConfig` currently reports — that way the same test
 * file pins behaviour across all three channels (CI runs publish
 * pipelines against the rewritten source; the published tarball's
 * assertions match the rewritten channel).
 *
 * Why this exists: prior to the multi-env refactor, `SYSTEMD_UNIT` and
 * `LAUNCHD_LABEL` derived from `deriveServiceSuffix(basename(HOME))` —
 * if a future PR replaces the `channelConfig.serviceUnitFile` /
 * `launchdLabel` references with hardcoded strings (or reintroduces a
 * home-basename derivation), this test catches it.
 */
const FAKE_BIN_INVOCATION = { kind: "bin", program: "/usr/local/bin/first-tree-dev" } as const;

describe("renderSystemdUnit — channel identity baked into unit text", () => {
  const unit = renderSystemdUnit(FAKE_BIN_INVOCATION, {});

  it("uses the channel's syslog identifier (bare name, no .service)", () => {
    expect(unit).toMatch(new RegExp(`SyslogIdentifier=${channelConfig.launchdLabel}\\b`));
  });

  it("embeds FIRST_TREE_HOME pointed at the resolved home", () => {
    // The unit embeds whatever `defaultHome()` resolves to at render
    // time (channel default unless the operator's FIRST_TREE_HOME env
    // overrides — see service-install.ts docblock about respecting
    // ad-hoc overrides). Assert the literal env line is present with
    // a path matching the current process's resolved home.
    expect(unit).toContain(`Environment=FIRST_TREE_HOME=${defaultHome()}`);
  });

  it("does NOT reference the pre-multi-env hardcoded `first-tree-client` identifier", () => {
    // Sanity guard: the old `first-tree-client.service` name must not
    // re-appear via copy-paste regression.
    expect(unit).not.toContain("first-tree-client");
  });

  it("embeds the CLI program path in ExecStart", () => {
    expect(unit).toMatch(/ExecStart=\/usr\/local\/bin\/first-tree-dev daemon start --no-interactive/);
  });
});

describe("renderPlist — channel identity baked into plist text", () => {
  const plist = renderPlist(FAKE_BIN_INVOCATION, {});

  it("uses the channel's launchd label", () => {
    // Label tag — exact match in the <key>Label</key><string>…</string> pair.
    expect(plist).toContain(`<string>${channelConfig.launchdLabel}</string>`);
  });

  it("embeds FIRST_TREE_HOME pointed at the resolved home", () => {
    // Same rationale as the systemd unit test: the plist embeds the
    // value `defaultHome()` resolves to at render time (which respects
    // any ad-hoc FIRST_TREE_HOME override). XML escape is a no-op for
    // typical home paths.
    expect(plist).toContain("<key>FIRST_TREE_HOME</key>");
    expect(plist).toContain(`<string>${defaultHome()}</string>`);
  });

  it("does NOT reference the pre-multi-env hardcoded `dev.first-tree.client` label", () => {
    expect(plist).not.toContain("dev.first-tree.client");
  });

  it("embeds the CLI program path in ProgramArguments", () => {
    expect(plist).toContain("<string>/usr/local/bin/first-tree-dev</string>");
  });
});
