import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contextIntegrationMarketplaceSourcePath,
  planContextIntegrationInstall,
} from "../core/context-integration/installer.js";
import {
  contextIntegrationInstallManifestPath,
  writeContextIntegrationInstallManifest,
} from "../core/context-integration/manifest.js";
import { materializeContextPluginPayload } from "../core/context-integration/payload-integrity.js";
import type {
  ContextIntegrationProviderDriver,
  ProviderPluginProbe,
} from "../core/context-integration/provider-driver.js";
import { resolveContextIntegrationRelease } from "../core/context-integration/release.js";
import { inspectContextIntegrationRuntime } from "../core/context-integration/runtime-health.js";
import { COMMAND_VERSION } from "../core/version.js";

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalPath = process.env.PATH;
const materializedProgram = "/opt/first-tree/bin/first-tree-dev";
const materializedInvocation = `'${materializedProgram}'`;

afterEach(() => {
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

function buildRelease(): string {
  const root = mkdtempSync(join(tmpdir(), "first-tree-context-health-release-"));
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
      "--out-dir",
      root,
      "--version",
      COMMAND_VERSION,
      "--channel",
      "dev",
    ],
    { stdio: "pipe" },
  );
  return root;
}

function providerProbe(overrides: Partial<ProviderPluginProbe> = {}): ProviderPluginProbe {
  return {
    provider: "codex",
    binaryAvailable: true,
    version: "0.145.0",
    compatible: true,
    installed: true,
    enabled: true,
    installedPath: "/provider/cache/first-tree-context",
    issues: [],
    ...overrides,
  };
}

function driver(probe: ProviderPluginProbe): ContextIntegrationProviderDriver {
  return {
    provider: "codex",
    executable: "codex",
    minimumVersion: "0.144.0",
    probe: () => probe,
    inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
    validateMarketplace: () => undefined,
    install: () => probe,
    uninstall: () => undefined,
  };
}

function writeMatchingInstall(releaseRoot: string): void {
  const release = resolveContextIntegrationRelease(releaseRoot);
  writeContextIntegrationInstallManifest({
    schemaVersion: 1,
    channel: "dev",
    provider: "codex",
    firstTreeVersion: COMMAND_VERSION,
    bundleVersion: release.manifest.version,
    adapterVersion: release.manifest.providers.codex.adapterVersion,
    loaderProtocolVersion: 1,
    bundleDigest: release.manifest.bundleDigest,
    policyDigest: release.manifest.policyDigest,
    adapterDigest: release.manifest.providers.codex.adapterDigest,
    marketplaceName: "first-tree-dev",
    pluginName: "first-tree-context",
    materializedInvocation,
    installedAt: "2026-07-28T00:00:00.000Z",
  });
}

function prepareHealthyPayload(releaseRoot: string): string {
  const release = resolveContextIntegrationRelease(releaseRoot);
  const stableRoot = contextIntegrationMarketplaceSourcePath("codex");
  const stablePlugin = join(stableRoot, "plugins", "first-tree-context");
  const installedPlugin = join(process.env.FIRST_TREE_HOME ?? "", "provider-cache", "first-tree-context");
  mkdirSync(dirname(stableRoot), { recursive: true });
  cpSync(join(releaseRoot, "codex"), stableRoot, { recursive: true });
  materializeContextPluginPayload(stablePlugin, release.manifest.providers.codex.adapterDigest, {
    kind: "bin",
    program: materializedProgram,
  });
  cpSync(stablePlugin, installedPlugin, { recursive: true });
  return installedPlugin;
}

describe("Context integration runtime health", () => {
  it("keeps the Plugin unchanged when only Core release identity advances", () => {
    process.env.FIRST_TREE_HOME = mkdtempSync(join(tmpdir(), "first-tree-context-health-home-"));
    const releaseRoot = buildRelease();
    writeMatchingInstall(releaseRoot);
    const installedPath = prepareHealthyPayload(releaseRoot);
    const installPath = contextIntegrationInstallManifestPath("codex");
    const stale = JSON.parse(readFileSync(installPath, "utf8"));
    stale.firstTreeVersion = "0.5.17";
    stale.bundleVersion = "0.5.17";
    stale.bundleDigest = `sha256:${"9".repeat(64)}`;
    stale.policyDigest = `sha256:${"8".repeat(64)}`;
    writeFileSync(installPath, `${JSON.stringify(stale)}\n`);

    const value = driver(providerProbe({ installedPath }));
    const health = inspectContextIntegrationRuntime(value, { releaseRoot });
    expect(health.healthy).toBe(true);
    expect(health.issues).toEqual([]);
    expect(planContextIntegrationInstall(value, { releaseRoot }).operation).toBe("unchanged");
  });

  it("rejects a provider downgrade below the release minimum", () => {
    process.env.FIRST_TREE_HOME = mkdtempSync(join(tmpdir(), "first-tree-context-health-home-"));
    const releaseRoot = buildRelease();
    writeMatchingInstall(releaseRoot);

    const health = inspectContextIntegrationRuntime(driver(providerProbe({ version: "0.100.0", compatible: false })), {
      releaseRoot,
    });
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("must be upgraded");
  });

  it("fails closed on a damaged installed manifest", () => {
    process.env.FIRST_TREE_HOME = mkdtempSync(join(tmpdir(), "first-tree-context-health-home-"));
    const releaseRoot = buildRelease();
    const path = contextIntegrationInstallManifestPath("codex");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{broken");

    const health = inspectContextIntegrationRuntime(driver(providerProbe()), { releaseRoot });
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("Installed Context manifest is invalid");
  });

  it("keeps a healthy materialized Plugin valid when the Hook PATH differs from install time", () => {
    process.env.FIRST_TREE_HOME = mkdtempSync(join(tmpdir(), "first-tree-context-health-home-"));
    const releaseRoot = buildRelease();
    writeMatchingInstall(releaseRoot);
    const installedPath = prepareHealthyPayload(releaseRoot);
    const restrictedPath = mkdtempSync(join(tmpdir(), "first-tree-context-hook-path-"));
    process.env.PATH = restrictedPath;
    const value = driver(providerProbe({ installedPath }));

    const health = inspectContextIntegrationRuntime(value, { releaseRoot });
    expect(health.healthy).toBe(true);
    expect(health.issues).toEqual([]);
    expect(planContextIntegrationInstall(value, { releaseRoot }).operation).toBe("unchanged");
  });

  it("requires one repair to record the materialized invocation for an older install manifest", () => {
    process.env.FIRST_TREE_HOME = mkdtempSync(join(tmpdir(), "first-tree-context-health-home-"));
    const releaseRoot = buildRelease();
    writeMatchingInstall(releaseRoot);
    const installPath = contextIntegrationInstallManifestPath("codex");
    const previous = JSON.parse(readFileSync(installPath, "utf8"));
    delete previous.materializedInvocation;
    writeFileSync(installPath, `${JSON.stringify(previous)}\n`);
    const installedPath = prepareHealthyPayload(releaseRoot);
    const value = driver(providerProbe({ installedPath }));

    const health = inspectContextIntegrationRuntime(value, { releaseRoot });
    expect(health.healthy).toBe(false);
    expect(health.issues).toContain(
      "The Context Plugin install manifest does not record its materialized CLI invocation.",
    );
    expect(planContextIntegrationInstall(value, { releaseRoot }).operation).toBe("repair");
  });

  it.each([
    ["missing Read Skill", (root: string) => rmSync(join(root, "skills", "first-tree-read", "SKILL.md"))],
    ["old Write Skill", (root: string) => writeFileSync(join(root, "skills", "first-tree-write", "SKILL.md"), "old")],
    ["hook drift", (root: string) => writeFileSync(join(root, "hooks", "hooks.json"), "{}")],
    ["launcher execute-bit drift", (root: string) => chmodSync(join(root, "bin", "context-session-start"), 0o600)],
  ])("fails closed and plans repair for provider-cache %s", (_label, damage) => {
    process.env.FIRST_TREE_HOME = mkdtempSync(join(tmpdir(), "first-tree-context-health-home-"));
    const releaseRoot = buildRelease();
    writeMatchingInstall(releaseRoot);
    const installedPath = prepareHealthyPayload(releaseRoot);
    damage(installedPath);
    const value = driver(providerProbe({ installedPath }));

    const health = inspectContextIntegrationRuntime(value, { releaseRoot });
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toMatch(
      /provider-installed Context Plugin payload|Context Plugin launcher is not an executable regular file/u,
    );
    expect(planContextIntegrationInstall(value, { releaseRoot }).operation).toBe("repair");
  });

  it("fails closed and repairs stable adapter marketplace drift", () => {
    process.env.FIRST_TREE_HOME = mkdtempSync(join(tmpdir(), "first-tree-context-health-home-"));
    const releaseRoot = buildRelease();
    writeMatchingInstall(releaseRoot);
    const installedPath = prepareHealthyPayload(releaseRoot);
    writeFileSync(
      join(contextIntegrationMarketplaceSourcePath("codex"), ".agents", "plugins", "marketplace.json"),
      "{}\n",
    );
    const value = driver(providerProbe({ installedPath }));

    const health = inspectContextIntegrationRuntime(value, { releaseRoot });
    expect(health.healthy).toBe(false);
    expect(health.issues.join(" ")).toContain("stable Context adapter marketplace differs");
    expect(planContextIntegrationInstall(value, { releaseRoot }).operation).toBe("repair");
  });
});
