import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertContextAdapterReadyForRouting,
  beginContextAdapterNextSessionObligation,
  consumeContextAdapterNextSessionObligation,
  inspectContextAdapterNextSessionObligation,
} from "../core/context-integration/adapter-observation.js";
import { writeContextIntegrationInstallManifest } from "../core/context-integration/manifest.js";
import { contextPluginTreeDigest } from "../core/context-integration/payload-integrity.js";
import type { ContextIntegrationProviderDriver } from "../core/context-integration/provider-driver.js";
import { resolveContextIntegrationRelease } from "../core/context-integration/release.js";
import { COMMAND_VERSION } from "../core/version.js";

const roots: string[] = [];
const originalHome = process.env.FIRST_TREE_HOME;
let home = "";
let coreRoot = "";
let releaseRoot = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "first-tree-observation-home-"));
  coreRoot = mkdtempSync(join(tmpdir(), "first-tree-observation-core-"));
  releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-observation-release-"));
  roots.push(home, coreRoot, releaseRoot);
  process.env.FIRST_TREE_HOME = home;
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
  prepareCoreRoot(coreRoot);
  buildRelease(releaseRoot, coreRoot);
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

describe("Claude next-session adapter adoption", () => {
  it("blocks manual routing until a current SessionStart consumes the repair marker", () => {
    const release = installCurrentAdapter();
    const target = release.manifest.providers["claude-code"];
    beginContextAdapterNextSessionObligation(release.manifest, "standalone_repair");

    expect(inspectContextAdapterNextSessionObligation()).toBe("standalone_repair");
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "Start a new session",
    );
    expect(
      consumeContextAdapterNextSessionObligation(
        {
          provider: "claude-code",
          adapterDigest: `sha256:${"0".repeat(64)}`,
          sessionStartSource: "startup",
        },
        { releaseRoot, coreRoot },
      ),
    ).toBeNull();
    expect(inspectContextAdapterNextSessionObligation()).toBe("standalone_repair");

    expect(
      consumeContextAdapterNextSessionObligation(
        { provider: "claude-code", adapterDigest: target.adapterDigest, sessionStartSource: "startup" },
        { releaseRoot, coreRoot },
      ),
    ).toBe("standalone_repair");
    expect(inspectContextAdapterNextSessionObligation()).toBeNull();
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).not.toThrow();
  });

  it.each([
    "resume",
    "clear",
    "compact",
    undefined,
  ])("does not consume the repair marker for an existing-session lifecycle source (%s)", (sessionStartSource) => {
    const release = installCurrentAdapter();
    const target = release.manifest.providers["claude-code"];
    beginContextAdapterNextSessionObligation(release.manifest, "standalone_repair");

    expect(
      consumeContextAdapterNextSessionObligation(
        { provider: "claude-code", adapterDigest: target.adapterDigest, sessionStartSource },
        { releaseRoot, coreRoot },
      ),
    ).toBeNull();
    expect(inspectContextAdapterNextSessionObligation()).toBe("standalone_repair");
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "Start a new session",
    );
  });

  it("restores the previous marker if provider installation fails", () => {
    const release = installCurrentAdapter();
    const rollback = beginContextAdapterNextSessionObligation(release.manifest, "setup");
    expect(inspectContextAdapterNextSessionObligation()).toBe("setup");
    rollback();
    expect(inspectContextAdapterNextSessionObligation()).toBeNull();
  });

  it("fails closed for malformed next-session state", () => {
    installCurrentAdapter();
    const marker = join(home, "state", "context", "providers", "claude-code", "next-session-required.json");
    mkdirSync(join(marker, ".."), { recursive: true });
    writeFileSync(marker, "not-json\n");
    expect(() => inspectContextAdapterNextSessionObligation()).toThrow("next-session state is unreadable or invalid");
  });

  it("still rejects drift in stable or provider-owned Plugin bytes", () => {
    installCurrentAdapter();
    const stableSkill = join(
      home,
      "state",
      "context",
      "providers",
      "claude-code",
      "marketplace",
      "plugins",
      "first-tree-context",
      "skills",
      "first-tree-read",
      "SKILL.md",
    );
    writeFileSync(stableSkill, "tampered stable stub\n");
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "payload has drifted",
    );

    installCurrentAdapter();
    const providerSkill = join(home, "provider-cache", "first-tree-context", "skills", "first-tree-read", "SKILL.md");
    writeFileSync(providerSkill, "tampered provider stub\n");
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "payload has drifted",
    );
  });
});

function installCurrentAdapter() {
  const release = resolveContextIntegrationRelease(releaseRoot, { coreRoot });
  const adapter = release.manifest.providers["claude-code"];
  const stableMarketplace = join(home, "state", "context", "providers", "claude-code", "marketplace");
  const stablePlugin = join(stableMarketplace, "plugins", "first-tree-context");
  const providerPlugin = join(home, "provider-cache", "first-tree-context");
  rmSync(stableMarketplace, { recursive: true, force: true });
  rmSync(providerPlugin, { recursive: true, force: true });
  mkdirSync(join(stablePlugin, "bin"), { recursive: true });
  mkdirSync(join(stablePlugin, "skills", "first-tree-read"), { recursive: true });
  writeFileSync(join(stableMarketplace, "marketplace.json"), "{}\n");
  const launcher = join(stablePlugin, "bin", "context-session-start");
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o700);
  writeFileSync(join(stablePlugin, "skills", "first-tree-read", "SKILL.md"), "---\nname: first-tree-read\n---\n");
  cpSync(stablePlugin, providerPlugin, { recursive: true });
  writeContextIntegrationInstallManifest({
    schemaVersion: 1,
    accountClientId: "client_1234abcd",
    channel: "dev",
    provider: "claude-code",
    firstTreeVersion: COMMAND_VERSION,
    bundleVersion: release.manifest.version,
    adapterVersion: adapter.adapterVersion,
    loaderProtocolVersion: 1,
    bundleDigest: release.manifest.bundleDigest,
    policyDigest: release.manifest.policyDigest,
    adapterDigest: adapter.adapterDigest,
    marketplaceName: "first-tree-dev",
    pluginName: "first-tree-context",
    materializedPayloadDigest: contextPluginTreeDigest(stablePlugin),
    materializedMarketplaceDigest: contextPluginTreeDigest(stableMarketplace),
    installedAt: new Date().toISOString(),
  });
  return release;
}

function observationOptions() {
  return { releaseRoot, coreRoot, driver: testDriver() };
}

function testDriver(): ContextIntegrationProviderDriver {
  return {
    provider: "claude-code",
    executable: "claude",
    minimumVersion: "1.0.0",
    probe: () => ({
      provider: "claude-code",
      binaryAvailable: true,
      version: "1.0.0",
      compatible: true,
      installed: true,
      enabled: true,
      installedPath: join(home, "provider-cache", "first-tree-context"),
      issues: [],
    }),
    inspectHook: async () => ({ trust: "provider_managed", enabled: true, source: "provider_managed", issues: [] }),
    validateMarketplace: () => undefined,
    install: () => {
      throw new Error("not used");
    },
    uninstall: () => undefined,
  };
}

function prepareCoreRoot(target: string): void {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  cpSync(join(repoRoot, "skills"), join(target, "skills"), { recursive: true });
  const policy = join(target, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md");
  mkdirSync(join(policy, ".."), { recursive: true });
  cpSync(join(repoRoot, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md"), policy);
}

function buildRelease(target: string, source: string): void {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  execFileSync(process.execPath, [
    join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
    "--out-dir",
    target,
    "--version",
    COMMAND_VERSION,
    "--channel",
    "dev",
    "--core-root",
    source,
  ]);
}
