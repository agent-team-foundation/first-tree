import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contextIntegrationReleaseManifestSchema } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contextIntegrationMarketplaceSourcePath,
  installContextIntegration,
  planContextIntegrationInstall,
  uninstallContextIntegration,
} from "../core/context-integration/installer.js";
import {
  readContextIntegrationInstallManifest,
  writeContextIntegrationInstallManifest,
} from "../core/context-integration/manifest.js";
import type {
  ContextIntegrationProviderDriver,
  ProviderPluginProbe,
} from "../core/context-integration/provider-driver.js";

const roots: string[] = [];
const originalFirstTreeHome = process.env.FIRST_TREE_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
});

describe("context integration bundle", () => {
  it("projects provider-guarded Read/Write Skills and byte-identical policy into both providers", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-context-bundle-"));
    roots.push(root);
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        root,
        "--version",
        "1.2.3",
        "--channel",
        "staging",
      ],
      { stdio: "pipe" },
    );

    const manifest = contextIntegrationReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")),
    );
    const canonicalPolicy = readFileSync(
      join(repoRoot, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md"),
    );
    const expectedPolicyDigest = `sha256:${createHash("sha256").update(canonicalPolicy).digest("hex")}`;
    expect(manifest.policyDigest).toBe(expectedPolicyDigest);

    const policyPath = "skills/first-tree-read/references/context-tree-policy.md";
    const claudePolicy = readFileSync(join(root, "claude-code", "plugins", "first-tree-context", policyPath));
    const codexPolicy = readFileSync(join(root, "codex", "plugins", "first-tree-context", policyPath));
    expect(claudePolicy.equals(codexPolicy)).toBe(true);
    const projectedSkills = new Map<string, { read: string; write: string }>();
    for (const provider of ["claude-code", "codex"]) {
      const pluginRoot = join(root, provider, "plugins", "first-tree-context");
      const hook = readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8");
      const readSkill = readFileSync(join(pluginRoot, "skills", "first-tree-read", "SKILL.md"), "utf8");
      const writeSkill = readFileSync(join(pluginRoot, "skills", "first-tree-write", "SKILL.md"), "utf8");
      projectedSkills.set(provider, { read: readSkill, write: writeSkill });
      expect(hook).toContain('"timeout": 5');
      expect(hook).not.toContain('"timeout": 3');
      expect(hook).toContain('"matcher": "startup|resume|clear|compact"');
      expect(readSkill).toContain(`context read --provider ${provider}`);
      expect(writeSkill).toContain(`context write --provider ${provider}`);
      expect(readSkill).toContain("read\n`references/context-tree-policy.md` completely");
      expect(writeSkill).toContain("read\n`references/context-tree-policy.md` completely");
      expect(readSkill).toContain('first_tree_source_checkout="$(git rev-parse --show-toplevel)"');
      expect(writeSkill).toContain('cd "<original-source-checkout>"');
      expect(readSkill).not.toMatch(/tree read --team/u);
      expect(writeSkill).not.toMatch(/tree write --team/u);
      expect(readSkill).not.toContain("Resolve the managed workspace");
      expect(writeSkill).not.toContain("**Managed:**");
      expect(readSkill).not.toMatch(/request (?:an explicit |it from the user|the )?Team id/iu);
      expect(writeSkill).not.toMatch(/request (?:an explicit |it from the user|the )?Team id/iu);
    }
    const claudeSkills = projectedSkills.get("claude-code");
    const codexSkills = projectedSkills.get("codex");
    expect(claudeSkills?.read.replaceAll("claude-code", "<provider>")).toBe(
      codexSkills?.read.replaceAll("codex", "<provider>"),
    );
    expect(claudeSkills?.write.replaceAll("claude-code", "<provider>")).toBe(
      codexSkills?.write.replaceAll("codex", "<provider>"),
    );
    expect(readdirSync(join(root, "codex", "plugins", "first-tree-context", "skills"))).not.toContain(
      "first-tree-seed",
    );
  });

  it("changes the Codex hook definition when the release digest changes", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-context-bundle-"));
    roots.push(root);
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        root,
        "--version",
        "1.2.3",
        "--channel",
        "prod",
      ],
      { stdio: "pipe" },
    );
    const hook = readFileSync(join(root, "codex", "plugins", "first-tree-context", "hooks", "hooks.json"), "utf8");
    expect(hook).toContain("__RELEASE_DIGEST__");
    const launcher = readFileSync(
      join(root, "codex", "plugins", "first-tree-context", "bin", "context-session-start"),
      "utf8",
    );
    expect(launcher).toContain("__FIRST_TREE_INVOCATION__");
  });

  it("restores the previous provider cache when an update fails", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    const installedPath = join(home, "provider-cache", "first-tree-context");
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "old-release.txt"), "previous\n");
    mkdirSync(join(installedPath, "bin"), { recursive: true });
    writeFileSync(join(installedPath, "bin", "context-session-start"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        "0.5.17",
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    writeContextIntegrationInstallManifest({
      schemaVersion: 1,
      channel: "dev",
      provider: "codex",
      firstTreeVersion: "0.5.16",
      bundleVersion: "0.5.16",
      bundleDigest: `sha256:${"1".repeat(64)}`,
      policyDigest: `sha256:${"2".repeat(64)}`,
      adapterDigest: `sha256:${"3".repeat(64)}`,
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
      installedAt: "2026-07-28T00:00:00.000Z",
    });

    const probe: ProviderPluginProbe = {
      provider: "codex",
      binaryAvailable: true,
      version: "0.144.1",
      compatible: true,
      installed: true,
      enabled: true,
      installedPath,
      issues: [],
    };
    const installedMarketplaces: string[] = [];
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.1",
      probe: () => probe,
      inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install: ({ marketplaceRoot }) => {
        installedMarketplaces.push(marketplaceRoot);
        if (installedMarketplaces.length === 1) throw new Error("provider install failed");
        expect(readFileSync(join(marketplaceRoot, "plugins", "first-tree-context", "old-release.txt"), "utf8")).toBe(
          "previous\n",
        );
        return probe;
      },
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    expect(plan.operation).toBe("repair");
    expect(() => installContextIntegration(driver, plan)).toThrow("provider install failed");
    expect(installedMarketplaces).toHaveLength(2);
    expect(readContextIntegrationInstallManifest("codex")?.bundleDigest).toBe(`sha256:${"1".repeat(64)}`);
    expect(existsSync(join(home, "state", "context", "install-journal.json"))).toBe(false);
    expect(existsSync(join(home, "state", "context", "install.lock"))).toBe(false);
  });

  it("cleans a provider-owned partial install even when no manifest was committed", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    const uninstall = vi.fn();
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({
        provider: "codex",
        binaryAvailable: true,
        version: "0.145.0",
        compatible: true,
        installed: true,
        enabled: true,
        installedPath: "/provider/cache/first-tree-context",
        issues: [],
      }),
      inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install: () => {
        throw new Error("not used");
      },
      uninstall,
    };

    uninstallContextIntegration(driver);
    expect(uninstall).toHaveBeenCalledWith({
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
    });
    expect(existsSync(join(home, "state", "context", "install-journal.json"))).toBe(false);
    expect(existsSync(join(home, "state", "context", "install.lock"))).toBe(false);
  });

  it("retains the provider marketplace source until a successful uninstall", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        "0.5.17",
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const installedPath = join(home, "provider-cache", "first-tree-context");
    const probe: ProviderPluginProbe = {
      provider: "codex",
      binaryAvailable: true,
      version: "0.145.0",
      compatible: true,
      installed: false,
      enabled: false,
      installedPath: null,
      issues: [],
    };
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => probe,
      inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
      validateMarketplace: () => undefined,
      install: ({ marketplaceRoot }) => {
        expect(marketplaceRoot).toBe(contextIntegrationMarketplaceSourcePath("codex"));
        expect(existsSync(join(marketplaceRoot, "plugins", "first-tree-context"))).toBe(true);
        cpSync(join(marketplaceRoot, "plugins", "first-tree-context"), installedPath, { recursive: true });
        return { ...probe, installed: true, enabled: true, installedPath };
      },
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    installContextIntegration(driver, plan);
    const marketplaceSource = contextIntegrationMarketplaceSourcePath("codex");
    expect(existsSync(join(marketplaceSource, "plugins", "first-tree-context"))).toBe(true);

    uninstallContextIntegration(driver);
    expect(existsSync(marketplaceSource)).toBe(false);
    expect(readContextIntegrationInstallManifest("codex")).toBeNull();
  });

  it("does not commit a ready manifest when the provider cache differs from the installed source", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        "0.5.17",
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const installedPath = join(home, "provider-cache", "first-tree-context");
    const initialProbe: ProviderPluginProbe = {
      provider: "codex",
      binaryAvailable: true,
      version: "0.145.0",
      compatible: true,
      installed: false,
      enabled: false,
      installedPath: null,
      issues: [],
    };
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => initialProbe,
      inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
      validateMarketplace: () => undefined,
      install: ({ marketplaceRoot }) => {
        cpSync(join(marketplaceRoot, "plugins", "first-tree-context"), installedPath, { recursive: true });
        writeFileSync(join(installedPath, "skills", "first-tree-write", "SKILL.md"), "old");
        return { ...initialProbe, installed: true, enabled: true, installedPath };
      },
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    expect(() => installContextIntegration(driver, plan)).toThrow(
      "The provider-installed Context Plugin payload does not match",
    );
    expect(readContextIntegrationInstallManifest("codex")).toBeNull();
  });

  it("rejects an install plan when provider state changes before mutation", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        "0.5.17",
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    let probeCount = 0;
    const install = vi.fn();
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({
        provider: "codex",
        binaryAvailable: true,
        version: "0.145.0",
        compatible: true,
        installed: probeCount++ > 0,
        enabled: true,
        installedPath: null,
        issues: [],
      }),
      inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install,
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    expect(() => installContextIntegration(driver, plan)).toThrow(
      "The provider Plugin state changed after the displayed plan.",
    );
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(join(home, "state", "context", "install.lock"))).toBe(false);
  });

  it("rejects a provider below the release minimum before any mutation", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        "0.5.17",
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const install = vi.fn();
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({
        provider: "codex",
        binaryAvailable: true,
        version: "0.100.0",
        compatible: false,
        installed: false,
        enabled: false,
        installedPath: null,
        issues: ["Codex 0.100.0 is older than the required 0.144.0."],
      }),
      inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
      validateMarketplace: () => undefined,
      install,
      uninstall: () => undefined,
    };

    expect(() => planContextIntegrationInstall(driver, { releaseRoot })).toThrow("Upgrade to 0.144.0 or newer");
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses repair while a previously installed provider Plugin is disabled", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        "0.5.17",
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const install = vi.fn();
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({
        provider: "codex",
        binaryAvailable: true,
        version: "0.145.0",
        compatible: true,
        installed: true,
        enabled: false,
        installedPath: "/provider/cache/first-tree-context",
        issues: [],
      }),
      inspectHook: async () => ({ trust: "trusted", enabled: false, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install,
      uninstall: () => undefined,
    };

    expect(() => planContextIntegrationInstall(driver, { releaseRoot })).toThrow("installed but disabled");
    expect(install).not.toHaveBeenCalled();
  });

  it("does not overwrite another provider's incomplete recovery journal", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    const journalPath = join(home, "state", "context", "install-journal.json");
    mkdirSync(join(home, "state", "context"), { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        provider: "claude-code",
        operation: "repair",
        previousBundleDigest: `sha256:${"1".repeat(64)}`,
        targetBundleDigest: `sha256:${"2".repeat(64)}`,
        startedAt: "2026-07-28T00:00:00.000Z",
        phase: "rollback_failed",
      })}\n`,
    );
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => {
        throw new Error("must not probe");
      },
      inspectHook: async () => {
        throw new Error("must not inspect");
      },
      validateMarketplace: () => undefined,
      install: () => {
        throw new Error("must not install");
      },
      uninstall: () => undefined,
    };

    expect(() => planContextIntegrationInstall(driver, { releaseRoot: "/unused" })).toThrow(
      "A claude-code Context Plugin operation is incomplete.",
    );
    expect(existsSync(journalPath)).toBe(true);
  });
});
